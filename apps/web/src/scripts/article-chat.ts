import {
  CHAT_QUESTION_LIMIT, CHAT_ANSWER_LIMIT, CHAT_HISTORY_LIMIT, CHAT_HISTORY_CHARACTERS,
  articleChatErrors, type ArticleChatTarget, type ArticleChatMessage, type ArticleChatEvent,
} from '@cet-reading/contracts/article-chat';

// Deliberately page-local: refreshing discards every article's conversation.
const conversations = new Map<string, ArticleChatMessage[]>();

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function chatIcon() {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(icon.namespaceURI, 'path');
  path.setAttribute('d', 'M5 4.5h14v11H9l-4 4v-15ZM8.5 9h7M8.5 12h4');
  icon.append(path); return icon;
}
function recentHistory(messages: ArticleChatMessage[]) {
  const recent = messages.slice(-CHAT_HISTORY_LIMIT);
  while (recent.reduce((sum, message) => sum + message.content.length, 0) > CHAT_HISTORY_CHARACTERS) recent.splice(0, 2);
  return recent;
}
function errorMessage(code: unknown) {
  return typeof code === 'string' && Object.hasOwn(articleChatErrors, code)
    ? articleChatErrors[code as keyof typeof articleChatErrors] : articleChatErrors.chat_failed;
}
async function* readEvents(response: Response): AsyncGenerator<ArticleChatEvent> {
  if (!response.body) throw new Error(articleChatErrors.chat_failed);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 1_000_000) throw new Error(articleChatErrors.chat_failed);
      if (done && buffer.trim()) buffer += '\n';
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (line) {
          const event = JSON.parse(line);
          if (!['start', 'ping', 'delta', 'done', 'error'].includes(event?.type)) throw new Error(articleChatErrors.chat_failed);
          if (event.type === 'delta' && typeof event.text !== 'string') throw new Error(articleChatErrors.chat_failed);
          yield event as ArticleChatEvent;
        }
      }
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export function createArticleChat(apiBase: string, target: ArticleChatTarget, title: string) {
  const key = JSON.stringify(target);
  let history = [...(conversations.get(key) ?? [])];
  let request: AbortController | undefined;
  let disposed = false, busy = false, composing = false;
  const details = element('details', 'article-chat');
  details.dataset.chatTarget = key;
  const summary = element('summary', 'article-chat-summary');
  const icon = element('span', 'article-chat-icon'); icon.append(chatIcon());
  const heading = element('span', 'article-chat-heading');
  heading.append(element('strong', '', '问 AI'), element('span', '', '带上这篇文章，继续问深一点'));
  const toggle = element('span', 'article-chat-toggle', '展开');
  summary.append(icon, heading, toggle);
  const panel = element('div', 'article-chat-panel');
  const context = element('div', 'article-chat-context');
  context.append(element('span', 'article-chat-context-label', '正在讨论'), element('span', 'article-chat-context-title', title));
  const clear = element('button', 'article-chat-clear', '清空对话'); clear.type = 'button';
  context.append(clear);
  const log = element('ol', 'article-chat-messages');
  log.setAttribute('role', 'log'); log.setAttribute('aria-label', '关于本文的问答'); log.setAttribute('aria-live', 'polite');
  const welcome = element('div', 'article-chat-welcome');
  welcome.append(element('strong', '', '哪里还没读透？'), element('p', '', '问细节、问句意，也可以顺着上一句回答继续追问。'));
  const suggestions = element('div', 'article-chat-suggestions');
  const composer = element('div', 'article-chat-composer');
  const input = element('textarea', 'article-chat-input');
  input.rows = 3; input.maxLength = CHAT_QUESTION_LIMIT;
  input.placeholder = '例如：第二段的例子，为什么能支持作者的观点？';
  input.setAttribute('aria-label', '向 AI 提问，已关联当前文章全文');
  const footer = element('div', 'article-chat-composer-footer');
  const hint = element('span', 'article-chat-note');
  hint.append(element('span', 'article-chat-keyboard-hint', 'Enter 发送 · Shift + Enter 换行'), element('span', '', '刷新后对话清空'));
  const buttons = element('div', 'article-chat-buttons');
  const stop = element('button', 'article-chat-stop', '停止回答'); stop.type = 'button'; stop.hidden = true;
  const send = element('button', 'article-chat-send', '发送问题'); send.type = 'button';
  buttons.append(stop, send); footer.append(hint, buttons); composer.append(input, footer);
  const status = element('p', 'article-chat-status'); status.setAttribute('role', 'status'); status.hidden = true;
  for (const question of ['哪些细节支持作者的观点？', '最后一段起什么作用？']) {
    const button = element('button', '', question); button.type = 'button';
    button.addEventListener('click', () => { input.value = question; input.focus(); updateControls(); });
    suggestions.append(button);
  }
  welcome.append(suggestions);
  panel.append(context, welcome, log, composer, status); details.append(summary, panel);

  function appendMessage(role: 'user' | 'assistant', content: string) {
    const row = element('li', `article-chat-message article-chat-message-${role}`);
    row.append(element('span', 'article-chat-speaker', role === 'user' ? '你问' : 'AI'));
    const text = element('div', 'article-chat-text', content); row.append(text); log.append(row);
    return text;
  }
  function updateControls() {
    send.disabled = busy || !input.value.trim();
    send.textContent = busy ? '回答中…' : '发送问题';
    stop.hidden = !busy; clear.disabled = busy;
    clear.hidden = !log.children.length;
    welcome.hidden = Boolean(log.children.length); log.hidden = !log.children.length;
    panel.setAttribute('aria-busy', String(busy));
  }
  function setStatus(text: string, error = false) {
    status.textContent = text; status.hidden = !text; status.dataset.state = error ? 'error' : '';
  }
  for (const message of history) appendMessage(message.role, message.content);
  updateControls();
  clear.addEventListener('click', () => {
    if (busy) return;
    history = []; conversations.delete(key); log.replaceChildren(); setStatus(''); updateControls();
  });
  stop.addEventListener('click', () => request?.abort());
  input.addEventListener('input', updateControls);
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { setTimeout(() => { composing = false; }, 0); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing && !composing) {
      event.preventDefault(); void ask();
    }
  });
  send.addEventListener('click', () => { void ask(); });
  details.addEventListener('toggle', () => {
    toggle.textContent = details.open ? '收起' : '展开';
    if (details.open && !disposed && document.activeElement === summary) {
      input.focus({ preventScroll: true }); input.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  });

  async function ask() {
    const question = input.value.trim();
    if (busy || !question || disposed) return;
    if (question.length > CHAT_QUESTION_LIMIT) { setStatus(`问题请控制在 ${CHAT_QUESTION_LIMIT} 字以内。`, true); return; }
    busy = true; setStatus('正在结合本文思考…');
    appendMessage('user', question);
    const answer = appendMessage('assistant', ''); answer.classList.add('is-waiting');
    input.value = ''; updateControls(); log.scrollTop = log.scrollHeight;
    const controller = new AbortController(); request = controller;
    let timedOut = false, complete = false, text = '';
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 195000);
    try {
      const response = await fetch(`${apiBase}/api/article-chat`, {
        method: 'POST', signal: controller.signal, cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target, question, history: recentHistory(history) }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(errorMessage(body?.error));
      }
      if (!response.headers.get('content-type')?.includes('application/x-ndjson')) throw new Error(articleChatErrors.chat_failed);
      for await (const event of readEvents(response)) {
        if (disposed || controller.signal.aborted) return;
        if (event.type === 'error') throw new Error(errorMessage(event.error));
        if (event.type === 'delta') {
          if (text.length + event.text.length > CHAT_ANSWER_LIMIT) throw new Error(articleChatErrors.chat_incomplete);
          const follow = log.scrollHeight - log.scrollTop - log.clientHeight < 64;
          text += event.text; answer.textContent = text; answer.classList.remove('is-waiting');
          setStatus(''); if (follow) log.scrollTop = log.scrollHeight;
        }
        if (event.type === 'done') { complete = true; break; }
      }
      if (!complete || !text.trim()) throw new Error(articleChatErrors.chat_incomplete);
      if (disposed || controller.signal.aborted) return;
      history = recentHistory([...history, { role: 'user', content: question }, { role: 'assistant', content: text }]);
      conversations.set(key, history); setStatus('');
    } catch (error) {
      if (disposed) return;
      const message = timedOut ? articleChatErrors.chat_timeout : controller.signal.aborted ? '已停止回答，可以修改问题后再问。'
        : error instanceof Error && Object.values(articleChatErrors).includes(error.message as typeof articleChatErrors[keyof typeof articleChatErrors]) ? error.message : articleChatErrors.chat_failed;
      if (!text) answer.textContent = '这次没有收到完整回答。';
      if (!input.value) input.value = question;
      setStatus(message, !controller.signal.aborted || timedOut);
    } finally {
      clearTimeout(timeout); request = undefined; busy = false;
      if (!disposed) { answer.classList.remove('is-waiting'); updateControls(); }
    }
  }
  return { element: details, dispose() { disposed = true; request?.abort(); } };
}
