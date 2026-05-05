// 全局变量
let currentSessionId = localStorage.getItem('chat_session_id');
let isLoading = false;

// 生成标准 UUID v4
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// 验证 UUID v4 格式
function isValidUUID(id) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

// 初始化或校验 session
if (!currentSessionId || !isValidUUID(currentSessionId)) {
    currentSessionId = generateUUID();
    localStorage.setItem('chat_session_id', currentSessionId);
}

// DOM 元素
const messagesArea = document.getElementById('messagesArea');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const newChatBtn = document.getElementById('newChatBtn');

// 配置 marked
if (typeof marked !== 'undefined') {
    marked.setOptions({
        breaks: true,
        gfm: true,
        headerIds: false,
        mangle: false
    });
}

// 安全渲染 Markdown
function renderMarkdown(text) {
    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
        const rawHtml = marked.parse(text);
        return DOMPurify.sanitize(rawHtml);
    }
    // Fallback: 简单转义HTML标签
    return text.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    }).replace(/\n/g, '<br>');
}

// 添加消息到界面
function appendMessage(role, content, timestamp = null) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}`;
    const avatar = role === 'user' ? '👤' : '🤖';
    const timeStr = timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();

    // 如果是 assistant 消息，渲染 Markdown；用户消息只做简单换行
    let renderedContent;
    if (role === 'assistant') {
        renderedContent = renderMarkdown(content);
    } else {
        renderedContent = escapeHtml(content).replace(/\n/g, '<br>');
    }

    messageDiv.innerHTML = `
        <div class="avatar">${avatar}</div>
        <div class="message-content">
            <div class="bubble">${renderedContent}</div>
            <div class="timestamp">${timeStr}</div>
        </div>
    `;
    messagesArea.appendChild(messageDiv);
    scrollToBottom();
}

// 纯文本转义（用于用户消息）
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 加载历史消息
async function loadHistory() {
    try {
        const res = await fetch(`/api/history?sessionId=${encodeURIComponent(currentSessionId)}`);
        if (!res.ok) {
            const errData = await res.json();
            console.error('历史加载失败', errData);
            return;
        }
        const { messages } = await res.json();
        if (messages && messages.length > 0) {
            messagesArea.innerHTML = '';
            for (const msg of messages) {
                appendMessage(msg.role, msg.content, msg.created_at);
            }
        } else if (messagesArea.children.length === 0) {
            // 没有历史且界面为空，显示欢迎语
            appendMessage('assistant', '你好！我是智能助手，基于 Llama 3 模型。有什么可以帮助你的吗？');
        }
        scrollToBottom();
    } catch (err) {
        console.error('加载历史异常', err);
    }
}

// 滚动到底部
function scrollToBottom() {
    messagesArea.scrollTop = messagesArea.scrollHeight;
}

// 加载动画控制
function setLoading(loading) {
    isLoading = loading;
    sendBtn.disabled = loading;
    userInput.disabled = loading;
    if (loading) {
        const loader = document.createElement('div');
        loader.id = 'loadingIndicator';
        loader.className = 'loading-indicator';
        loader.innerHTML = '<div class="loading-dot"></div><div class="loading-dot"></div><div class="loading-dot"></div><span style="margin-left:6px">AI 正在思考...</span>';
        messagesArea.appendChild(loader);
        scrollToBottom();
    } else {
        const existing = document.getElementById('loadingIndicator');
        if (existing) existing.remove();
    }
}

// 发送消息
async function sendMessage() {
    const message = userInput.value.trim();
    if (!message || isLoading) return;

    // 立即显示用户消息
    appendMessage('user', message);
    userInput.value = '';
    userInput.style.height = 'auto';
    setLoading(true);

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: currentSessionId, message })
        });
        const data = await response.json();
        if (response.ok && data.response) {
            appendMessage('assistant', data.response, data.timestamp);
        } else {
            let errMsg = data.error || '未知错误';
            if (data.retryAfter) errMsg += ` (请 ${Math.ceil(data.retryAfter)} 秒后重试)`;
            appendMessage('assistant', `❌ 出错：${errMsg}`);
        }
    } catch (err) {
        console.error(err);
        appendMessage('assistant', '⚠️ 网络错误，请检查连接后重试');
    } finally {
        setLoading(false);
    }
}

// 新建会话
function newChat() {
    currentSessionId = generateUUID();
    localStorage.setItem('chat_session_id', currentSessionId);
    messagesArea.innerHTML = '';
    appendMessage('assistant', '✨ 已开启全新会话！你可以开始提问了。');
    scrollToBottom();
}

// 事件绑定
sendBtn.addEventListener('click', sendMessage);
newChatBtn.addEventListener('click', newChat);
userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});
// 自动调整 textarea 高度
userInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});

// 启动时加载历史
loadHistory();
