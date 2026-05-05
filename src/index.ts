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

// 将 AI 流转换为 SSE 流，同时累积完整回复文本
function createSSEStream(aiStream: ReadableStream, onComplete: (fullText: string) => void): ReadableStream {
  let fullText = '';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // AI 流返回的是 JSON 对象每行，格式如：data: {"response":"Hello"}\n\n
  // 我们需要解析每个块，提取 response 字段，然后重新包装为 SSE 格式：data: 文本块\n\n
  // 注意：Cloudflare Workers AI 流式返回的是类似 SSE 的流，但为了通用，我们直接读取原始流，按行分割
  return new ReadableStream({
    async start(controller) {
      const reader = aiStream.getReader();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // 按行分割（SSE 事件以 \n\n 分隔，但每个块可能是部分）
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
                  // 发送 SSE 事件
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: chunk })}\n\n`));
                }
              } catch (e) {
                // 忽略解析错误
              }
            }
          }
        }
        // 处理剩余 buffer
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
        // 流结束，发送结束标记
        controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
        controller.close();
        // 调用完成回调，将完整文本保存到数据库（后台执行）
        onComplete(fullText);
      } catch (err) {
        controller.error(err);
      }
    },
  });
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

    const errorResponse = (msg: string, status: number = 500) =>
      Response.json({ error: msg }, { status, headers: corsHeaders });

    // GET /api/history（保持不变）
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

    // POST /api/chat（流式版本）
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

      // 限流检查
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
        console.error('Save user message error', err);
        return errorResponse('保存用户消息失败');
      }

      // 2. 获取历史上下文（最多 CONTEXT_LIMIT 条）
      const { results: history } = await env.DB.prepare(
        `SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?`
      ).bind(sessionId, CONTEXT_LIMIT).all();

      const aiMessages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...(history as any[]).map(row => ({ role: row.role, content: row.content }))
      ];

      // 3. 调用流式 AI
      let aiStream: ReadableStream;
      try {
        aiStream = await env.AI.run(AI_MODEL, { messages: aiMessages, stream: true }) as ReadableStream;
      } catch (err: any) {
        // 如果调用失败，需要删除刚才保存的用户消息
        await env.DB.prepare(
          `DELETE FROM messages WHERE session_id = ? AND id = (SELECT id FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1)`
        ).bind(sessionId, sessionId).run();
        return errorResponse(`AI 流启动失败: ${err.message}`);
      }

      // 4. 创建 SSE 流，并处理保存完整回复到数据库（在流结束后）
      const onComplete = async (fullReply: string) => {
        if (!fullReply) fullReply = '抱歉，我无法生成回答。';
        try {
          await env.DB.prepare(`INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)`)
            .bind(sessionId, fullReply).run();
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

    // 静态资源
    return env.ASSETS.fetch(request);
  },
};
