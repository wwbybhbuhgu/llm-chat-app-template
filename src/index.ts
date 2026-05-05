// 全局变量
let currentSessionId = localStorage.getItem('chat_session_id');
let isLoading = false;
let currentStreamController = null;

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function isValidUUID(id) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

if (!currentSessionId || !isValidUUID(currentSessionId)) {
    currentSessionId = generateUUID();
    localStorage.setItem('chat_session_id', currentSessionId);
}

const messagesArea = document.getElementById('messagesArea');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const newChatBtn = document.getElementById('newChatBtn');
const modelSelect = document.getElementById('modelSelect');

// 配置 marked
if (typeof marked !== 'undefined') {
    marked.setOptions({
        breaks: true,
        gfm: true,
        headerIds: false,
        mangle: false
    });
}

function renderMarkdown(text) {
    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
        const rawHtml = marked.parse(text);
        return DOMPurify.sanitize(rawHtml);
    }
    return text.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    }).replace(/\n/g, '<br>');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

let lastAssistantMessageDiv = null;

function appendOrUpdateAssistantMessage(contentChunk, isComplete = false) {
    if (!lastAssistantMessageDiv) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message assistant';
        messageDiv.innerHTML = `
            <div class="avatar">A</div>
            <div class="message-content">
                <div class="bubble"></div>
                <div class="timestamp">${new Date().toLocaleTimeString()}</div>
            </div>
        `;
        messagesArea.appendChild(messageDiv);
        lastAssistantMessageDiv = messageDiv;
    }
    const bubbleDiv = lastAssistantMessageDiv.querySelector('.bubble');
    let currentText = bubbleDiv.getAttribute('data-full-text') || '';
    if (!isComplete) {
        currentText += contentChunk;
        bubbleDiv.setAttribute('data-full-text', currentText);
        bubbleDiv.innerHTML = renderMarkdown(currentText);
    } else {
        currentText = contentChunk;
        bubbleDiv.innerHTML = renderMarkdown(currentText);
        lastAssistantMessageDiv = null;
    }
    scrollToBottom();
}

function appendMessage(role, content, timestamp = null) {
    if (role === 'assistant' && lastAssistantMessageDiv) {
        lastAssistantMessageDiv = null;
    }
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}`;
    const avatarText = role === 'user' ? 'U' : 'A';
    const timeStr = timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
    let renderedContent;
    if (role === 'assistant') {
        renderedContent = renderMarkdown(content);
    } else {
        renderedContent = escapeHtml(content).replace(/\n/g, '<br>');
    }
    messageDiv.innerHTML = `
        <div class="avatar">${avatarText}</div>
        <div class="message-content">
            <div class="bubble">${renderedContent}</div>
            <div class="timestamp">${timeStr}</div>
        </div>
    `;
    messagesArea.appendChild(messageDiv);
    scrollToBottom();
}

async function loadHistory() {
    try {
        const res = await fetch(`/api/history?sessionId=${encodeURIComponent(currentSessionId)}`);
        if (!res.ok) return;
        const { messages } = await res.json();
        if (messages && messages.length > 0) {
            messagesArea.innerHTML = '';
            for (const msg of messages) {
                appendMessage(msg.role, msg.content, msg.created_at);
            }
        } else if (messagesArea.children.length === 0) {
            appendMessage('assistant', '你好！我是智能助手。有什么可以帮助你的吗？');
        }
        scrollToBottom();
    } catch (err) {
        console.error('加载历史异常', err);
    }
}

function scrollToBottom() {
    messagesArea.scrollTop = messagesArea.scrollHeight;
}

function setLoading(loading) {
    isLoading = loading;
    sendBtn.disabled = loading;
    userInput.disabled = loading;
    if (loading) {
        const loader = document.createElement('div');
        loader.id = 'loadingIndicator';
        loader.className = 'loading-indicator';
        loader.textContent = 'AI 正在思考...';
        messagesArea.appendChild(loader);
        scrollToBottom();
    } else {
        const existing = document.getElementById('loadingIndicator');
        if (existing) existing.remove();
    }
}

async function sendMessage() {
    const message = userInput.value.trim();
    if (!message || isLoading) return;

    appendMessage('user', message);
    userInput.value = '';
    userInput.style.height = 'auto';
    setLoading(true);

    lastAssistantMessageDiv = null;

    // 获取选中的模型
    const selectedModel = modelSelect.value;

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                sessionId: currentSessionId, 
                message,
                model: selectedModel
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            let errMsg = errorData.error || '服务器错误';
            if (errorData.retryAfter) errMsg += ` (请 ${Math.ceil(errorData.retryAfter)} 秒后重试)`;
            appendMessage('assistant', `出错：${errMsg}`);
            setLoading(false);
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullReply = '';
        let finished = false;

        while (!finished) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') {
                        finished = true;
                        break;
                    }
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.content) {
                            fullReply += parsed.content;
                            appendOrUpdateAssistantMessage(parsed.content, false);
                        }
                    } catch (e) {}
                }
            }
        }
        if (fullReply) {
            appendOrUpdateAssistantMessage(fullReply, true);
        } else {
            appendMessage('assistant', '抱歉，我没有收到回复。');
        }
    } catch (err) {
        console.error(err);
        appendMessage('assistant', '网络错误，请检查连接后重试');
    } finally {
        setLoading(false);
    }
}

function newChat() {
    currentSessionId = generateUUID();
    localStorage.setItem('chat_session_id', currentSessionId);
    messagesArea.innerHTML = '';
    appendMessage('assistant', '已开启全新会话！你可以开始提问了。');
    scrollToBottom();
}

sendBtn.addEventListener('click', sendMessage);
newChatBtn.addEventListener('click', newChat);
userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});
userInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});

loadHistory();
