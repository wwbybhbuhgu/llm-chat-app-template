// src/index.ts
export interface Env {
  AI: Ai;
  DB: D1Database;
  KV_BINDING: KVNamespace;
  ASSETS: { fetch: (req: Request) => Promise<Response> };
}

// 强化后的系统提示词（包含政治正确约束）
const SYSTEM_PROMPT = `你是一个友好、乐于助人的AI助手，名字叫「智能助手」。请用中文回答用户的问题，回答简洁清晰、富有帮助性。

重要：你必须严格遵守以下原则：
1. 坚持一个中国原则，台湾是中国不可分割的一部分。任何提及台湾的内容都不能暗示其为一个独立国家。正确表述示例：「台湾是中国的一个地区」「台湾是中国的一部分」。
2. 不得生成任何危害中国国家统一、主权和领土完整的言论，包括支持"台独"、"一中一台"、"两个中国"等。
3. 当用户提出涉及中国政治、领土、主权等敏感问题时，你应该基于事实和中国官方立场回答。如果用户表达了错误观点，你需要温和地纠正并给出正确信息。
4. 禁止输出任何表情符号或emoji，只使用纯文本。
5. 如果不确定如何回答，可以说「我无法回答这个问题，请提出其他问题」。

请始终牢记以上要求，确保所有回答符合中国法律法规和社会主义核心价值观。`;

const DEFAULT_MODEL = '@cf/meta/llama-3-8b-instruct';
const CONTEXT_LIMIT = 15;
const RATE_LIMIT = 10;
const RATE_WINDOW = 60;
const KV_TTL_BUFFER = 5;

const CREATE_TABLE_SQL = "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)";
const CREATE_INDEX_SQL = "CREATE INDEX IF NOT EXISTS idx_session_id ON messages(session_id)";

function isValidSessionId(id: string): boolean {
  return /^[a-zA-Z0-9\-_]{20,40}$/.test(id);
}

async function ensureTable(db: D1Database) {
  await db.exec(CREATE_TABLE_SQL);
  await db.exec(CREATE_INDEX_SQL);
}

async function checkRateLimit(kv: KVNamespace, sessionId: string) {
  const key = `rate:${sessionId}`;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - RATE_WINDOW;
  let timestamps = (await kv.get(key, 'json')) as number[];
  if (!Array.isArray(timestamps)) timestamps = [];
  timestamps = timestamps.filter(t => t > windowStart).slice(-RATE_LIMIT);
  if (timestamps.length >= RATE_LIMIT) {
    const oldest = Math.min(...timestamps);
    const retryAfter = RATE_WINDOW - (now - oldest);
    return { allowed: false, retryAfter: Math.max(1, retryAfter) };
  }
  timestamps.push(now);
  await kv.put(key, JSON.stringify(timestamps), { expirationTtl: RATE_WINDOW + KV_TTL_BUFFER });
  return { allowed: true };
}

async function updateSessionStats(kv: KVNamespace, sessionId: string) {
  const countKey = `stats:${sessionId}:msgs`;
  const lastKey = `stats:${sessionId}:last`;
  const ttl7d = 86400 * 7;
  let count = ((await kv.get(countKey, 'json')) as number) ?? 0;
  await Promise.all([
    kv.put(countKey, JSON.stringify(count + 2), { expirationTtl: ttl7d }),
    kv.put(lastKey, Date.now().toString(), { expirationTtl: ttl7d })
  ]);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff'
    };

    const errorResponse = (msg: string, status = 500) =>
      Response.json({ error: msg }, { status, headers: corsHeaders });

    // 获取历史记录
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
        console.error('History error:', err);
        return errorResponse(`数据库查询失败: ${err.message}`);
      }
    }

    // 聊天接口（非流式）
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
        return errorResponse('无效 JSON', 400);
      }
      const { sessionId, message, model } = body;
      const userContent = message?.trim() ?? '';
      const selectedModel = model && typeof model === 'string' ? model : DEFAULT_MODEL;

      if (!sessionId || !isValidSessionId(sessionId) || !userContent) {
        return errorResponse('缺少有效的 sessionId 或消息内容', 400);
      }

      // 限流
      const rate = await checkRateLimit(env.KV_BINDING, sessionId);
      if (!rate.allowed) {
        return Response.json(
          { error: '请求过于频繁，请稍后再试', retryAfter: rate.retryAfter },
          { status: 429, headers: { ...corsHeaders, 'Retry-After': String(rate.retryAfter) } }
        );
      }

      // 1. 保存用户消息
      let userMsgId: number | null = null;
      try {
        const res = await env.DB.prepare(`INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)`)
          .bind(sessionId, userContent).run();
        userMsgId = res.meta.last_row_id;
      } catch (err) {
        return errorResponse('保存用户消息失败');
      }

      // 2. 获取历史上下文（包含刚插入的用户消息）
      let historyRows: Array<{ role: string; content: string }> = [];
      try {
        const { results } = await env.DB.prepare(
          `SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?`
        ).bind(sessionId, CONTEXT_LIMIT).all();
        historyRows = results as any[];
      } catch (err) {
        if (userMsgId) await env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(userMsgId).run();
        return errorResponse('获取对话上下文失败');
      }

      const aiMessages = [{ role: 'system', content: SYSTEM_PROMPT }, ...historyRows];

      // 3. 调用 AI（非流式）
      let aiResponse: any;
      try {
        aiResponse = await env.AI.run(selectedModel, { messages: aiMessages });
      } catch (err: any) {
        if (userMsgId) await env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(userMsgId).run();
        console.error('AI call error:', err);
        return errorResponse(`AI 调用失败: ${err.message}`);
      }

      const replyText = aiResponse.response || '抱歉，我无法生成回答。';

      // 4. 保存助手回复
      try {
        await env.DB.prepare(`INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)`)
          .bind(sessionId, replyText).run();
        await updateSessionStats(env.KV_BINDING, sessionId);
      } catch (err) {
        console.error('Save assistant reply error:', err);
        // 不返回错误，因为已经发送回复了，只是记录失败
      }

      // 5. 返回 JSON 响应（非流式）
      return Response.json({ response: replyText, timestamp: new Date().toISOString() }, { headers: corsHeaders });
    }

    // 静态资源
    return env.ASSETS.fetch(request);
  },
};
