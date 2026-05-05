// src/index.ts
export interface Env {
  AI: Ai;
  DB: D1Database;
  KV_BINDING: KVNamespace;
  ASSETS: { fetch: (req: Request) => Promise<Response> };
}

const SYSTEM_PROMPT = `你是一个友好、乐于助人的AI助手，名字叫「智能助手」。请用中文回答用户的问题，回答简洁清晰、富有帮助性。`;
const AI_MODEL = '@cf/meta/llama-3-8b-instruct';
const CONTEXT_LIMIT = 15;        // 保留最近15条消息（约7轮对话）
const RATE_LIMIT = 10;           // 每分钟最大请求数
const RATE_WINDOW = 60;          // 滑动窗口（秒）

// 创建消息表（仅执行一次）
const initSQL = `
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_session_id ON messages(session_id);
`;

// 辅助函数：验证 UUID 格式
function isValidSessionId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

// KV 限流检查（滑动窗口）
async function checkRateLimit(kv: KVNamespace, sessionId: string): Promise<{ allowed: boolean; retryAfter?: number }> {
  const key = `rate:${sessionId}`;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - RATE_WINDOW;
  let timestamps = await kv.get(key, 'json') as number[];
  if (!Array.isArray(timestamps)) timestamps = [];
  timestamps = timestamps.filter(t => t > windowStart);
  if (timestamps.length >= RATE_LIMIT) {
    const oldest = Math.min(...timestamps);
    const retryAfter = RATE_WINDOW - (now - oldest);
    return { allowed: false, retryAfter: Math.max(1, retryAfter) };
  }
  timestamps.push(now);
  await kv.put(key, JSON.stringify(timestamps), { expirationTtl: RATE_WINDOW + 5 });
  return { allowed: true };
}

// 更新会话统计（KV 演示）
async function updateSessionStats(kv: KVNamespace, sessionId: string) {
  const countKey = `stats:${sessionId}:msgs`;
  let count = await kv.get(countKey, 'json') as number;
  if (count === null) count = 0;
  await kv.put(countKey, JSON.stringify(count + 2), { expirationTtl: 86400 * 7 }); // 用户+助手两条
  await kv.put(`stats:${sessionId}:last`, Date.now().toString(), { expirationTtl: 86400 * 7 });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
    };

    // 确保数据库表存在（后台执行，不阻塞请求）
    ctx.waitUntil(env.DB.exec(initSQL).catch(e => console.error('init DB failed', e)));

    // GET /api/history 获取历史消息
    if (path === '/api/history' && request.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId || !isValidSessionId(sessionId)) {
        return Response.json({ error: '无效的 sessionId' }, { status: 400, headers: corsHeaders });
      }
      try {
        const { results } = await env.DB.prepare(
          `SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT 200`
        ).bind(sessionId).all();
        return Response.json({ messages: results }, { headers: corsHeaders });
      } catch (err) {
        console.error(err);
        return Response.json({ error: '数据库查询失败' }, { status: 500, headers: corsHeaders });
      }
    }

    // POST /api/chat 发送消息并获取 AI 回复
    if (path === '/api/chat' && request.method === 'POST') {
      let body: { sessionId?: string; message?: string };
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: '无效的 JSON' }, { status: 400, headers: corsHeaders });
      }
      const { sessionId, message } = body;
      if (!sessionId || !isValidSessionId(sessionId) || !message?.trim()) {
        return Response.json({ error: '缺少有效的 sessionId 或消息内容' }, { status: 400, headers: corsHeaders });
      }

      // 限流检查
      const rate = await checkRateLimit(env.KV_BINDING, sessionId);
      if (!rate.allowed) {
        return Response.json(
          { error: '请求过于频繁，请稍后再试', retryAfter: rate.retryAfter },
          { status: 429, headers: { ...corsHeaders, 'Retry-After': String(rate.retryAfter) } }
        );
      }

      try {
        // 1. 保存用户消息
        await env.DB.prepare(
          `INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)`
        ).bind(sessionId, message.trim()).run();

        // 2. 获取最近对话历史
        const { results: history } = await env.DB.prepare(
          `SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?`
        ).bind(sessionId, CONTEXT_LIMIT).all();

        const aiMessages = [
          { role: 'system', content: SYSTEM_PROMPT },
          ...(history as any[]).map(row => ({ role: row.role, content: row.content }))
        ];

        // 3. 调用 Workers AI
        const aiResp = await env.AI.run(AI_MODEL, { messages: aiMessages });
        let reply = (aiResp as any)?.response || '抱歉，我暂时无法生成回答。';

        // 4. 保存 AI 回复
        await env.DB.prepare(
          `INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)`
        ).bind(sessionId, reply).run();

        // 5. 更新 KV 统计（异步）
        ctx.waitUntil(updateSessionStats(env.KV_BINDING, sessionId));

        return Response.json({ response: reply, timestamp: new Date().toISOString() }, { headers: corsHeaders });
      } catch (err: any) {
        console.error(err);
        // 回滚：删除刚刚插入的用户消息
        try {
          await env.DB.prepare(
            `DELETE FROM messages WHERE session_id = ? AND id = (SELECT id FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1)`
          ).bind(sessionId, sessionId).run();
        } catch (e) { /* 忽略 */ }
        return Response.json({ error: 'AI 服务出错: ' + err.message }, { status: 500, headers: corsHeaders });
      }
    }

    // 其他所有请求由 Assets 处理（返回 index.html 或静态资源）
    return env.ASSETS.fetch(request);
  }
};
