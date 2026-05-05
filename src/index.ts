// src/index.ts
export interface Env {
  AI: Ai;
  DB: D1Database;
  KV_BINDING: KVNamespace;
  ASSETS: { fetch: (req: Request) => Promise<Response> };
}

const SYSTEM_PROMPT = `你是一个友好、乐于助人的AI助手，名字叫「智能助手」。请用中文回答用户的问题，回答简洁清晰、富有帮助性。`;
const AI_MODEL = '@cf/meta/llama-3-8b-instruct';
const CONTEXT_LIMIT = 15;
const RATE_LIMIT = 10;
const RATE_WINDOW = 60;

// 单行 SQL，避免多行字符串导致的解析错误
const initSQL = "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP); CREATE INDEX IF NOT EXISTS idx_session_id ON messages(session_id);";

function isValidSessionId(id: string): boolean {
  return /^[a-zA-Z0-9\-_]{20,40}$/.test(id);
}

async function ensureTable(db: D1Database) {
  try {
    await db.exec(initSQL);
  } catch (err: any) {
    console.error('Table creation error:', err);
    throw new Error(`Failed to initialize database: ${err.message}`);
  }
}

async function checkRateLimit(kv: KVNamespace, sessionId: string) {
  const key = `rate:${sessionId}`;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - RATE_WINDOW;
  let timestamps = (await kv.get(key, 'json')) as number[];
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

async function updateSessionStats(kv: KVNamespace, sessionId: string) {
  const countKey = `stats:${sessionId}:msgs`;
  let count = (await kv.get(countKey, 'json')) as number;
  if (count === null) count = 0;
  await kv.put(countKey, JSON.stringify(count + 2), { expirationTtl: 86400 * 7 });
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

    // 辅助函数：响应错误
    const errorResponse = (msg: string, status: number = 500) => 
      Response.json({ error: msg }, { status, headers: corsHeaders });

    // ---------- API 路由 ----------
    // GET /api/history
    if (path === '/api/history' && request.method === 'GET') {
      try {
        await ensureTable(env.DB);
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId || !isValidSessionId(sessionId)) {
          return errorResponse('无效或缺失 sessionId', 400);
        }
        const { results } = await env.DB.prepare(
          `SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT 200`
        ).bind(sessionId).all();
        return Response.json({ messages: results }, { headers: corsHeaders });
      } catch (err: any) {
        console.error('History error', err);
        return errorResponse(`数据库查询失败: ${err.message}`);
      }
    }

    // POST /api/chat
    if (path === '/api/chat' && request.method === 'POST') {
      try {
        await ensureTable(env.DB);
      } catch (err: any) {
        return errorResponse(`数据库初始化失败: ${err.message}`);
      }

      let body: any;
      try {
        body = await request.json();
      } catch {
        return errorResponse('无效的 JSON', 400);
      }
      const { sessionId, message } = body;
      if (!sessionId || !isValidSessionId(sessionId) || !message?.trim()) {
        return errorResponse('缺少有效的 sessionId 或消息内容', 400);
      }

      const rate = await checkRateLimit(env.KV_BINDING, sessionId);
      if (!rate.allowed) {
        return Response.json(
          { error: '请求过于频繁，请稍后再试', retryAfter: rate.retryAfter },
          { status: 429, headers: { ...corsHeaders, 'Retry-After': String(rate.retryAfter) } }
        );
      }

      try {
        // 保存用户消息
        await env.DB.prepare(`INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)`)
          .bind(sessionId, message.trim()).run();

        const { results: history } = await env.DB.prepare(
          `SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?`
        ).bind(sessionId, CONTEXT_LIMIT).all();

        const aiMessages = [
          { role: 'system', content: SYSTEM_PROMPT },
          ...(history as any[]).map(row => ({ role: row.role, content: row.content }))
        ];

        const aiResp = await env.AI.run(AI_MODEL, { messages: aiMessages });
        let reply = (aiResp as any)?.response || '抱歉，我暂时无法生成回答。';

        await env.DB.prepare(`INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)`)
          .bind(sessionId, reply).run();

        ctx.waitUntil(updateSessionStats(env.KV_BINDING, sessionId));

        return Response.json({ response: reply, timestamp: new Date().toISOString() }, { headers: corsHeaders });
      } catch (err: any) {
        console.error('Chat error', err);
        // 回滚：删除刚刚插入的用户消息
        try {
          await env.DB.prepare(
            `DELETE FROM messages WHERE session_id = ? AND id = (SELECT id FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1)`
          ).bind(sessionId, sessionId).run();
        } catch (e) {}
        return errorResponse(`AI 服务出错: ${err.message}`);
      }
    }

    // 静态资源
    return env.ASSETS.fetch(request);
  },
};
