// src/index.ts
export interface Env {
  AI: Ai;
  DB: D1Database;
  KV_BINDING: KVNamespace;
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  DMX_API_KEY?: string;
}

// 系统提示词（保持不变）
const SYSTEM_PROMPT = `你是一个友好、乐于助人的AI助手，名字叫「智能助手」。请用中文回答用户的问题，回答简洁清晰、富有帮助性。

重要：你必须严格遵守以下原则：
1. 坚持一个中国原则，台湾是中国不可分割的一部分。任何提及台湾的内容都不能暗示其为一个独立国家。正确表述示例：「台湾是中国的一个地区」「台湾是中国的一部分」。
2. 不得生成任何危害中国国家统一、主权和领土完整的言论，包括支持"台独"、"一中一台"、"两个中国"等。
3. 当用户提出涉及中国政治、领土、主权等敏感问题时，你应该基于事实和中国官方立场回答。如果用户表达了错误观点，你需要温和地纠正并给出正确信息。
4. 禁止输出任何表情符号或emoji，只使用纯文本。
5. 如果不确定如何回答，可以说「我无法回答这个问题，请提出其他问题」。

请始终牢记以上要求，确保所有回答符合中国法律法规和社会主义核心价值观。`;

// 模型列表
const MODEL_LIST = [
  { id: '@cf/meta/llama-3-8b-instruct', name: 'Llama 3 8B Instruct' },
  { id: '@cf/mistral/mistral-7b-instruct-v0.1', name: 'Mistral 7B Instruct' },
  { id: '@hf/thebloke/deepseek-coder-6.7b-instruct-awq', name: 'DeepSeek Coder 6.7B' },
  { id: '@cf/meta/llama-2-7b-chat-int8', name: 'Llama 2 7B Chat' },
  { id: '@hf/google/gemma-7b-it', name: 'Google Gemma 7B' },
  { id: '@cf/alibaba/qwen3-max', name: 'Alibaba Qwen3-Max' },
  { id: 'hunyuan-standard-256K', name: '腾讯混元 256K' },
  { id: 'qwen3.5-flash', name: '通义千问 3.5 Flash' },
];

const EXTERNAL_MODELS = new Set(['hunyuan-standard-256K', 'qwen3.5-flash']);
const DEFAULT_MODEL = '@cf/meta/llama-3-8b-instruct';
const CONTEXT_LIMIT = 15;
const RATE_LIMIT = 10;
const RATE_WINDOW = 60;
const KV_TTL_BUFFER = 5;

// 建表语句（拆分，单行）
const CREATE_TABLE_SQL = "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)";
const CREATE_INDEX_SQL = "CREATE INDEX IF NOT EXISTS idx_session_id ON messages(session_id)";

async function ensureTable(db: D1Database) {
  // 每次调用都执行，D1 会忽略已存在的表
  await db.exec(CREATE_TABLE_SQL).catch(err => console.error('建表失败:', err));
  await db.exec(CREATE_INDEX_SQL).catch(err => console.error('建索引失败:', err));
}

function isValidSessionId(id: string): boolean {
  return /^[a-zA-Z0-9\-_]{20,40}$/.test(id);
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

// Workers AI 流解析
async function* workersAITokenStream(stream: ReadableStream): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let data = line;
        if (line.startsWith('data: ')) data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const content = json.response ?? json.text ?? json.content ?? '';
          if (content) yield content;
        } catch {}
      }
    }
    if (buffer.trim()) {
      let data = buffer.trim();
      if (data.startsWith('data: ')) data = data.slice(6);
      if (data !== '[DONE]') {
        try {
          const json = JSON.parse(data);
          const content = json.response ?? json.text ?? json.content ?? '';
          if (content) yield content;
        } catch {}
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// 外部代理流解析
async function* externalAITokenStream(stream: ReadableStream): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            const content = json.choices?.[0]?.delta?.content ?? '';
            if (content) yield content;
          } catch {}
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// 创建 SSE 流（负责转发 token）
function createSSEStream(tokenGen: AsyncGenerator<string>): ReadableStream {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const token of tokenGen) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: token })}\n\n`));
        }
      } catch (err) {
        console.error('SSE stream error:', err);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: '流式传输错误' })}\n\n`));
      } finally {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
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
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    };

    const errorResponse = (msg: string, status = 500) =>
      Response.json({ error: msg }, { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    // 获取模型列表
    if (path === '/api/models' && request.method === 'GET') {
      return Response.json({ models: MODEL_LIST }, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

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
        return Response.json({ messages: results }, { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (err: any) {
        console.error('History error:', err);
        return errorResponse(`数据库查询失败: ${err.message}`);
      }
    }

    // 流式聊天接口（无占位版本）
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
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Retry-After': String(rate.retryAfter) } }
        );
      }

      // 1. 保存用户消息（同步）
      let userMsgId: number | null = null;
      try {
        const res = await env.DB.prepare(`INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)`)
          .bind(sessionId, userContent).run();
        userMsgId = res.meta.last_row_id;
      } catch (err) {
        return errorResponse('保存用户消息失败');
      }

      // 2. 获取历史上下文（获取当前用户消息之前的所有对话）
      let historyRows: Array<{ role: string; content: string }> = [];
      try {
        const { results } = await env.DB.prepare(
          `SELECT role, content FROM messages WHERE session_id = ? AND id < ? ORDER BY ROWID ASC LIMIT ?`
        ).bind(sessionId, userMsgId!, CONTEXT_LIMIT).all();
        historyRows = results as any[];
      } catch (err) {
        await env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(userMsgId!).run();
        return errorResponse('获取对话上下文失败');
      }

      const aiMessages = [{ role: 'system', content: SYSTEM_PROMPT }, ...historyRows];
      const isExternal = EXTERNAL_MODELS.has(selectedModel);

      // 3. 获取 AI 流
      let tokenGen: AsyncGenerator<string>;
      try {
        if (isExternal) {
          if (!env.DMX_API_KEY) throw new Error('DMX_API_KEY 未配置');
          const resp = await fetch('https://www.dmxapi.cn/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${env.DMX_API_KEY}`,
            },
            body: JSON.stringify({
              model: selectedModel,
              messages: aiMessages,
              stream: true,
            }),
          });
          if (!resp.ok) throw new Error(`External API error ${resp.status}`);
          tokenGen = externalAITokenStream(resp.body!);
        } else {
          const aiStream = await env.AI.run(selectedModel, { messages: aiMessages, stream: true }) as ReadableStream;
          tokenGen = workersAITokenStream(aiStream);
        }
      } catch (err: any) {
        await env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(userMsgId!).run();
        console.error('AI call error:', err);
        return errorResponse(`AI 调用失败: ${err.message}`);
      }

      // 4. 手动拼接完整回复，同时创建 SSE 流
      let fullReply = '';
      const encoder = new TextEncoder();
      const sseStream = new ReadableStream({
        async start(controller) {
          try {
            for await (const token of tokenGen) {
              fullReply += token;
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: token })}\n\n`));
            }
          } catch (err) {
            console.error('Streaming error:', err);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: '流式传输中断' })}\n\n`));
          } finally {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          }
        },
      });

      // 5. 流结束后同步保存助手回复
      const finalReply = fullReply || '抱歉，我无法生成回答。';
      try {
        await env.DB.prepare(`INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)`)
          .bind(sessionId, finalReply).run();
        await updateSessionStats(env.KV_BINDING, sessionId);
        console.log(`已保存助手消息，长度 ${finalReply.length}`);
      } catch (err) {
        console.error('保存助手回复失败', err);
      }

      // 返回 SSE 响应（流已完成推送）
      return new Response(sseStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Connection': 'keep-alive',
          ...corsHeaders,
        },
      });
    }

    // 静态资源
    return env.ASSETS.fetch(request);
  },
};
