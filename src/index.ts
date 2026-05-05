// src/index.ts
export interface Env {
  AI: Ai;
  DB: D1Database;
  KV_BINDING: KVNamespace;
  ASSETS: { fetch: (req: Request) => Promise<Response> };
}

const SYSTEM_PROMPT = `你是一个友好、乐于助人的AI助手，名字叫「智能助手」。请用中文回答用户的问题，回答简洁清晰、富有帮助性。重要：请勿使用任何表情符号或emoji，只使用纯文本。`;

const DEFAULT_MODEL = '@cf/meta/llama-3-8b-instruct';
const CONTEXT_LIMIT = 15;
const RATE_LIMIT = 10;
const RATE_WINDOW = 60;
const KV_TTL_BUFFER = 5;

// 修复：拆分为单行SQL，避免多行字符串导致的解析错误
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

  let count = (await kv.get(countKey, 'json')) as number;
  count = count ?? 0;

  await Promise.all([
    kv.put(countKey, JSON.stringify(count + 2), { expirationTtl: ttl7d }),
    kv.put(lastKey, Date.now().toString(), { expirationTtl: ttl7d })
  ]);
}

// 可靠流处理
function createSSEStream(
  aiStream: ReadableStream,
  onComplete: (fullText: string) => Promise<void>
): ReadableStream {
  let fullText = '';
  const encoder = new TextEncoder();
  const reader = aiStream.getReader();

  return new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunkStr = new TextDecoder().decode(value);
          try {
            const json = JSON.parse(chunkStr);
            const content = json.response ?? '';
            if (content) {
              fullText += content;
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content })}\n\n`));
            }
          } catch {
            continue;
          }
        }
      } catch (err) {
        console.error('Stream read error:', err);
      } finally {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
        await onComplete(fullText || '抱歉，生成回答失败。');
      }
    },
    cancel() {
      reader.cancel();
    }
  });
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

        const { results } = await env.DB.prepare(`
          SELECT role, content, created_at 
          FROM messages 
          WHERE session_id = ? 
          ORDER BY created_at ASC 
          LIMIT 200
        `).bind(sessionId).all();

        return Response.json({ messages: results }, { headers: corsHeaders });
      } catch (err: any) {
        console.error('History query error:', err);
        return errorResponse(`数据库查询失败: ${err.message}`);
      }
    }

    // 流式聊天接口
    if (path === '/api/chat' && request.method === 'POST') {
      try {
        await ensureTable(env.DB);
      } catch (err: any) {
        return errorResponse(`数据库初始化失败: ${err.message}`);
      }

      let body: { sessionId?: string; message?: string; model?: string };
      try {
        body = await request.json();
      } catch {
        return errorResponse('请求体不是合法 JSON', 400);
      }

      const { sessionId, message, model } = body;
      const userContent = message?.trim() ?? '';
      const selectedModel = model && typeof model === 'string' ? model : DEFAULT_MODEL;

      if (!sessionId || !isValidSessionId(sessionId) || !userContent) {
        return errorResponse('缺少有效的 sessionId 或消息内容', 400);
      }

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
        const res = await env.DB.prepare(`
          INSERT INTO messages (session_id, role, content) 
          VALUES (?, 'user', ?)
        `).bind(sessionId, userContent).run();
        userMsgId = res.meta.last_row_id;
      } catch (err: any) {
        return errorResponse('保存用户消息失败');
      }

      // 2. 获取历史上下文
      let historyRows: Array<{ role: string; content: string }> = [];
      try {
        const { results } = await env.DB.prepare(`
          SELECT role, content 
          FROM messages 
          WHERE session_id = ? 
          ORDER BY created_at ASC 
          LIMIT ?
        `).bind(sessionId, CONTEXT_LIMIT).all();
        historyRows = results as any[];
      } catch (err: any) {
        if (userMsgId) await env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(userMsgId).run();
        return errorResponse('获取对话上下文失败');
      }

      const aiMessages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...historyRows
      ];

      // 3. 调用 AI 流式接口
      let aiStream: ReadableStream;
      try {
        aiStream = await env.AI.run(selectedModel, {
          messages: aiMessages,
          stream: true
        }) as ReadableStream;
      } catch (err: any) {
        if (userMsgId) {
          await env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(userMsgId).run();
        }
        return errorResponse(`AI 模型调用失败: ${err.message}`);
      }

      const onComplete = async (fullReply: string) => {
        try {
          await env.DB.prepare(`
            INSERT INTO messages (session_id, role, content) 
            VALUES (?, 'assistant', ?)
          `).bind(sessionId, fullReply).run();
          await updateSessionStats(env.KV_BINDING, sessionId);
          console.log(`[Session ${sessionId}] 已保存助手回复，长度: ${fullReply.length}`);
        } catch (err) {
          console.error('保存助手回复失败:', err);
        }
      };

      const sseStream = createSSEStream(aiStream, onComplete);

      return new Response(sseStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'X-Content-Type-Options': 'nosniff'
        }
      });
    }

    return env.ASSETS.fetch(request);
  },
};
