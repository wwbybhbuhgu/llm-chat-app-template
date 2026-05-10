# AI 智能助手聊天应用

基于 Cloudflare Workers + D1 + KV 的多模型 AI 聊天应用，支持流式响应和历史记录管理。

## ✨ 特性

- 🤖 **多模型支持** - 内置 Llama 3, Mistral, Qwen 等多个大语言模型
- ⚡ **流式响应** - Server-Sent Events (SSE) 实时推送 AI 回复
- 💾 **持久化存储** - D1 数据库存储对话历史，KV 限流保护
- 🔒 **安全过滤** - 集成爱国主题系统提示词，确保内容合规
- 📱 **响应式设计** - 移动端友好界面
- 🌐 **本地资源** - CDN 资源本地化，减少网络请求

## 🛠️ 技术栈

- **后端**: Cloudflare Workers (TypeScript)
- **数据库**: Cloudflare D1
- **缓存/限流**: Cloudflare KV
- **AI**: Cloudflare Workers AI / DMX API 网关
- **前端**: HTML/CSS/Vanilla JavaScript

## 📦 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/wwbybhbuhgu/llm-chat-app-template.git
cd llm-chat-app-template
```

### 2. 安装依赖

```bash
npm install
npm run cf-typegen
```

### 3. 配置环境变量

在 `wrangler.toml` 中配置以下绑定：

```toml
[[d1_databases]]
binding = "DB"
database_name = "your-db-name"
database_id = "your-db-id"

[[kv_namespaces]]
binding = "KV_BINDING"
id = "your-kv-id"
```

### 4. 创建数据库表

```bash
wrangler d1 execute your-db-name --file=create-table.sql
```

`create-table.sql` 内容见下文。

### 5. 部署

```bash
npm run deploy
```

## 🗄️ 数据库 Schema

```sql
-- 消息表
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,           -- 'user' or 'assistant'
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 索引优化查询性能
CREATE INDEX IF NOT EXISTS idx_session_id ON messages(session_id);
```

## 📁 项目结构

```
llm-chat-app-template/
├── public/                  # 静态资源
│   ├── index.html          # 聊天界面
│   ├── chat.js             # 前端逻辑
│   ├── style.css           # 样式
│   └── vendor/             # 第三方库
│       ├── marked.min.js   # Markdown 解析
│       └── dompurify.min.js # XSS 防护
├── src/                    # 后端代码
│   └── index.ts            # Worker 主入口
├── wrangler.jsonc          # Wrangler 配置
├── package.json
└── README.md
```

## 🔌 API 接口

| 接口 | 方法 | 描述 |
|------|------|------|
| `/api/models` | GET | 获取可用模型列表 |
| `/api/history?sessionId=xxx` | GET | 获取会话历史记录 |
| `/api/chat` | POST | 发送消息并流式接收 AI 回复 |
| `/api/save-ai-reply` | POST | 保存完整的 AI 回复（前端调用） |

## 🎯 核心架构

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   前端      │         │   后端      │         │   数据库    │
│  (chat.js)  │────────▶│ (index.ts)  │────────▶│   (D1)      │
│             │◀────────│             │◀────────│             │
│ 维护上下文  │         │ 流式转发    │         │ 存储历史    │
│ 组装请求    │         │ 异步保存    │         │ 限流统计    │
└─────────────┘         └─────────────┘         └─────────────┘
```

## 🔧 自定义配置

### 修改 AI 模型

编辑 `src/index.ts` 中的 `MODEL_LIST`:

```typescript
const MODEL_LIST = [
  { id: '@cf/meta/llama-3-8b-instruct', name: 'Llama 3 8B Instruct' },
  // ... 更多模型
];
```

### 修改系统提示词

编辑 `src/index.ts` 中的 `SYSTEM_PROMPT`，包含爱国主题过滤策略。

### 调整限流设置

```typescript
const RATE_LIMIT = 10;     // 每分钟最大请求数
const RATE_WINDOW = 60;    // 时间窗口（秒）
```

## 🐛 常见问题

### 1. 流式响应不工作？

确保响应头包含：
```
Content-Type: text/event-stream
Cache-Control: no-cache, no-store, must-revalidate
Connection: keep-alive
```

### 2. 数据库报错？

检查是否已执行建表 SQL，D1 数据库中是否有足够的存储空间。

### 3. 为什么 AI 看不到历史记录？

前端需要正确组装 `context` 参数传给后端 `/api/chat` 接口。

## 📝 变更记录

### v1.0.0 - 初始版本
- ✅ 基础聊天功能
- ✅ 流式响应
- ✅ 历史记录
- ✅ 限流保护
- ✅ 爱国主题过滤

## 📄 许可证

MIT License
