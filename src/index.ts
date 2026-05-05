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
  // ... 保持不变
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
  let count = (await kv.get(countKey, 'json')) as number ?? 0;
  await Promise.all([
    kv.put(countKey, JSON.stringify(count + 2), { expirationTtl: ttl7d }),
    kv.put(lastKey, Date.now().toString(), { expirationTtl: ttl7d })
  ]);
}

// 增强流处理：兼容多种格式，输出日志
function createSSEStream(
  aiStream: ReadableStream,
  onComplete: (fullText: string) => Promise<void>
): ReadableStream {
  let fullText = '';
  const encoder = new TextEncoder();
  const reader = aiStream.getReader();

  return new ReadableStream({
    async start(controller) {
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunkStr = new TextDecoder().decode(value);
          buffer += chunkStr;
          // 按行分割，处理 SSE 格式
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.trim() === '') continue;
            let dataStr = line;
            // 移除可能的 data: 前缀
            if (line.startsWith('data: ')) {
              dataStr = line.slice(6);
            }
            if (dataStr === '[DONE]') continue;
            try {
              const json = JSON.parse(dataStr);
              // 尝试多种可能的字段名
              const content = json.response ?? json.text ?? json.content ?? '';
              if (content) {
                fullText += content;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content })}\n\n`));
              } else {
                // 如果字段不存在，记录日志
                console.warn('Unexpected AI response chunk:', json);
              }
            } catch (err) {
              console.warn('Failed to parse line:', dataStr, err);
            }
          }
        }
        // 处理最后剩余 buffer
        if (buffer.trim() !== '') {
          let dataStr = buffer.trim();
          if (dataStr.startsWith('data: ')) dataStr = dataStr.slice(6);
          if (dataStr !== '[DONE]') {
            try {
              const json = JSON.parse(dataStr);
              const content = json.response ?? json.text ?? json.content ?? '';
              if (content) {
                fullText += content;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content })}\n\n`));
              }
            } catch (err) {
              console.warn('Failed to parse final buffer:', buffer, err);
            }
          }
        }
      } catch (err) {
        console.error('Stream read error:', err);
      } finally {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
        console.log(`Full text collected (length: ${fullText.length}): ${fullText.slice(0, 200)}...`);
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

    // 历史记录接口（保持不变）
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

    // 聊天接口
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

      const rate = await checkRateLimit(env.KV_BINDING, sessionId);
      if (!rate.allowed) {
        return Response.json(
          { error: '请求过于频繁，请稍后再试', retryAfter: rate.retryAfter },
          { status: 429, headers: { ...corsHeaders, 'Retry-After': String(rate.retryAfter) } }
        );
      }

      // 保存用户消息
      let userMsgId: number | null = null;
      try {
        const res = await env.DB.prepare(`INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)`)
          .bind(sessionId, userContent).run();
        userMsgId = res.meta.last_row_id;
      } catch (err) {
        return errorResponse('保存用户消息失败');
      }

      // 获取历史
      let historyRows = [];
      try {
        const { results } = await env.DB.prepare(
          `SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?`
        ).bind(sessionId, CONTEXT_LIMIT).all();
        historyRows = results as any[];
      } catch (err) {
        if (userMsgId) await env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(userMsgId).run();
        return errorResponse('获取上下文失败');
      }

      const aiMessages = [{ role: 'system', content: SYSTEM_PROMPT }, ...historyRows];

      console.log(`Calling AI model: ${selectedModel}, messages count: ${aiMessages.length}`);

      let aiStream: ReadableStream;
      try {
        aiStream = await env.AI.run(selectedModel, { messages: aiMessages, stream: true }) as ReadableStream;
      } catch (err: any) {
        if (userMsgId) await env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(userMsgId).run();
        console.error('AI call error:', err);
        return errorResponse(`AI 调用失败: ${err.message}`);
      }

      const onComplete = async (fullReply: string) => {
        console.log(`Saving assistant reply for session ${sessionId}, length: ${fullReply.length}`);
        try {
          await env.DB.prepare(`INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)`)
            .bind(sessionId, fullReply).run();
          await updateSessionStats(env.KV_BINDING, sessionId);
        } catch (err) {
          console.error('Save assistant reply error:', err);
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
