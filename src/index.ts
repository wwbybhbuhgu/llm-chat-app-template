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

const initSQL = "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP); CREATE INDEX IF NOT EXISTS idx_session_id ON messages(session_id);";

function isValidSessionId(id: string): boolean {
  return /^[a-zA-Z0-9\-_]{20,40}$/.test(id);
}

async function ensureTable(db: D1Database) {
  await db.exec(initSQL);
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

// 创建一个安全的 SSE 流，并确保在流结束时调用 onComplete（即使出错）
function createSSEStream(aiStream: ReadableStream, onComplete: (fullText: string) => void): ReadableStream {
  let fullText = '';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream({
    async start(controller) {
      const reader = aiStream.getReader();
      let buffer = '';
      let streamError: any = null;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const jsonStr = line.slice(6);
              if (jsonStr === '[DONE]') continue;
              try {
                const parsed = JSON.parse(jsonStr);
                if (parsed.response) {
                  const chunk = parsed.response;
                  fullText += chunk;
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: chunk })}\n\n`));
                }
              } catch (e) {
                // 忽略解析错误
              }
            }
          }
        }
        // 处理残余 buffer
        if (buffer.startsWith('data: ')) {
          const jsonStr = buffer.slice(6);
          if (jsonStr !== '[DONE]') {
            try {
              const parsed = JSON.parse(jsonStr);
              if (parsed.response) {
                fullText += parsed.response;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: parsed.response })}\n\n`));
              }
            } catch (e) {}
          }
        }
      } catch (err) {
        streamError = err;
        console.error('Stream reading error', err);
      } finally {
        // 无论成功还是失败，都发送结束标记并调用 onComplete
        controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
        controller.close();
        // 如果出错，fullText 可能不完整，但仍然保存已有的内容（或保存错误提示）
        if (streamError) {
          onComplete(fullText || '抱歉，生成回复时出现错误。');
        } else {
          onComplete(fullText);
        }
      }
    },
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
        },
      });
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
    };

    const errorResponse = (msg: string, status: number = 500) =>
      Response.json({ error: msg }, { status, headers: corsHeaders });

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
      const { sessionId, message, model } = body;
      const selectedModel = model && typeof model === 'string' ? model : DEFAULT_MODEL;

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

      // 1. 保存用户消息
      try {
        await env.DB.prepare(`INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)`)
          .bind(sessionId, message.trim()).run();
      } catch (err: any) {
        return errorResponse('保存用户消息失败');
      }

      // 2. 创建 assistant 占位消息，以便即使流中断也有一条记录
      let assistantMessageId: number | null = null;
      try {
        const insertAssistant = await env.DB.prepare(
          `INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', '')`
        ).bind(sessionId).run();
        assistantMessageId = insertAssistant.meta.last_row_id;
      } catch (err) {
        // 占位失败则回滚用户消息
        await env.DB.prepare(
          `DELETE FROM messages WHERE session_id = ? AND id = (SELECT id FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1)`
        ).bind(sessionId, sessionId).run();
        return errorResponse('无法创建助手消息占位');
      }

      // 3. 获取历史上下文（包含刚插入的空 assistant 和之前的消息）
      const { results: history } = await env.DB.prepare(
        `SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?`
      ).bind(sessionId, CONTEXT_LIMIT).all();

      // 注意：历史中可能包含这个空的 assistant 消息，我们需要过滤掉它（因为其内容为空，且 role 为 assistant，但还没有实际回复）
      // 更简洁的做法：在构造 aiMessages 时，只取之前已经完成的消息（即 content 不为空，或者排除最后一条空的 assistant）。
      // 由于我们刚刚插入的空消息 id 最大，我们可以在查询时排除最后一条空消息，或者简单地在内存中过滤。
      const filteredHistory = (history as any[]).filter((row, index, arr) => {
        // 如果这条消息 role 是 assistant 且 content 为空，并且它是最后一条消息，则跳过
        if (row.role === 'assistant' && row.content === '' && index === arr.length - 1) {
          return false;
        }
        return true;
      });

      const aiMessages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...filteredHistory.map(row => ({ role: row.role, content: row.content }))
      ];

      // 4. 调用流式 AI
      let aiStream: ReadableStream;
      try {
        aiStream = await env.AI.run(selectedModel, { messages: aiMessages, stream: true }) as ReadableStream;
      } catch (err: any) {
        // AI 调用失败，删除用户消息和占位消息
        await env.DB.prepare(
          `DELETE FROM messages WHERE session_id = ? AND id IN (SELECT id FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1)`
        ).bind(sessionId, sessionId).run();
        await env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(assistantMessageId).run();
        return errorResponse(`AI 流启动失败: ${err.message}`);
      }

      // 5. 定义完成回调：更新占位消息的内容
      const onComplete = async (fullReply: string) => {
        if (!fullReply) fullReply = '抱歉，我无法生成回答。';
        try {
          if (assistantMessageId) {
            await env.DB.prepare(`UPDATE messages SET content = ? WHERE id = ?`).bind(fullReply, assistantMessageId).run();
          } else {
            // 降级：插入新消息
            await env.DB.prepare(`INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)`)
              .bind(sessionId, fullReply).run();
          }
          await updateSessionStats(env.KV_BINDING, sessionId);
        } catch (err) {
          console.error('Failed to save assistant reply', err);
        }
      };

      const sseStream = createSSEStream(aiStream, onComplete);

      // 返回 SSE 响应
      return new Response(sseStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
