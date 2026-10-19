import type { AdminJobDetail, StoredAnalysisRequest } from '@cet-reading/contracts/analysis-diagnostics';
import { explainAnalysisFailure } from '@cet-reading/contracts/analysis-diagnostics';
import { tokenize } from '@cet-reading/contracts/tokens';

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const labels: Record<string, string> = { pending: '排队中', running: '生成中', succeeded: '已完成', failed: '失败' };
function date(value: string | null) {
  if (!value) return '未记录';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? '未记录' : new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false,
  }).format(parsed);
}
function duration(start: string | null, end: string | null) {
  if (!start || !end) return '—';
  const ms = Math.max(0, Date.parse(end) - Date.parse(start));
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms} 毫秒`;
  return ms < 60000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.floor(ms / 60000)} 分 ${Math.floor(ms % 60000 / 1000)} 秒`;
}
const stamp = (label: string, value: string | null, empty = '未记录') => `<div><dt>${label}</dt><dd>${value ? `<time datetime="${esc(value)}">${esc(date(value))}</time>` : esc(empty)}</dd></div>`;
function pretty(value: string) { try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; } }

export function createAdminRequestDetail(request: (path: string) => Promise<AdminJobDetail>) {
  const dialog = document.getElementById('admin-job-dialog') as HTMLDialogElement;
  const body = document.getElementById('admin-detail-body')!;
  const title = document.getElementById('admin-detail-title')!;
  const state = document.getElementById('admin-detail-state')!;
  const feedback = document.getElementById('admin-detail-feedback')!;
  const refresh = document.getElementById('admin-detail-refresh') as HTMLButtonElement;
  const sourceLink = document.getElementById('admin-detail-source') as HTMLAnchorElement;
  let selected: string | null = null;
  let revision = 0;
  let loading = false;
  let fingerprint = '';
  const texts = new Map<string, string>();
  const rawModes = new Set<string>();

  function code(key: string, value: string, label: string) {
    texts.set(key, value);
    const raw = rawModes.has(key);
    return `<section class="request-code" data-code="${esc(key)}"><div class="request-code-toolbar"><h4>${label}</h4><div class="request-code-actions"><div class="request-code-modes" role="group" aria-label="${label}显示方式"><button type="button" data-code-mode="pretty" aria-pressed="${!raw}">格式化</button><button type="button" data-code-mode="raw" aria-pressed="${raw}">原始文本</button></div><button class="text-link" type="button" data-copy-code>复制</button></div></div><pre tabindex="0">${esc(raw ? value : pretty(value))}</pre></section>`;
  }
  function requestCard(item: StoredAnalysisRequest, index: number, opened: Set<string> | null, latest: string) {
    const error = item.validationError || item.errorMessage;
    const status = item.validationStatus === 'passed' ? '校验通过' : item.validationStatus === 'failed' ? '校验未通过'
      : item.errorMessage ? '请求失败' : item.completedAt ? '返回完成' : '接收中';
    const failure = error ? `<div class="request-failure"><p>${esc(explainAnalysisFailure(error))}</p><pre>${esc(error)}</pre>${item.validationIssues.length ? `<ul>${item.validationIssues.map(issue => `<li><code>${esc(issue.path || '返回内容')}</code>：${esc(issue.message)}</li>`).join('')}</ul>` : ''}</div>` : '';
    return `<details class="request-attempt" data-trace-id="${esc(item.id)}"${(opened ? opened.has(item.id) : item.id === latest) ? ' open' : ''}><summary><span class="request-attempt-title">第 ${index + 1} 次请求 <span>${item.purpose === 'repair' ? '修正回答' : '首次生成'}${item.transportAttempt > 1 ? ` · 网络重试 ${item.transportAttempt - 1}` : ''}</span></span><span class="request-attempt-state${error ? ' is-error' : ''}">${status}<span aria-hidden="true">⌄</span></span></summary><div class="request-attempt-body"><dl class="request-timeline">${stamp('发出请求', item.sentAt)}${stamp('收到响应头', item.responseAt, item.completedAt ? '未收到' : '等待响应')}${stamp('首个回答内容', item.firstContentAt, item.completedAt ? '无回答内容' : '等待内容')}${stamp('返回完成', item.completedAt, '接收中')}</dl><p class="request-attempt-meta">${item.httpStatus ? `HTTP ${item.httpStatus} · ` : ''}请求耗时 ${duration(item.sentAt, item.completedAt)}${item.firstContentAt ? ` · 首个内容等待 ${duration(item.sentAt, item.firstContentAt)}` : ''}${item.finishReason ? ` · 结束原因 ${esc(item.finishReason)}` : ''}</p>${failure}${item.responseText ? code(`${item.id}:answer`, item.responseText, item.errorMessage ? 'AI 返回内容（接收中断，可能不完整）' : 'AI 原始返回') : `<p class="request-no-content">${item.completedAt ? '本次没有收到可记录的 AI 回答。' : '请求正在进行，返回内容将在接收完成后显示。'}</p>`}${item.responseBody ? code(`${item.id}:body`, item.responseBody, item.responseKind === 'upstream_error' ? '上游服务错误返回' : '未能解析的上游返回') : ''}${item.responseTruncated ? '<p class="request-record-note">返回内容超过保存上限，仅保留前 131,072 个字符。</p>' : ''}<details class="request-input"><summary>查看发送给 AI 的内容</summary>${code(`${item.id}:input`, item.requestText, '完整请求内容')}${item.requestTruncated ? '<p class="request-record-note">请求内容超过保存上限，显示内容已截断。</p>' : ''}</details><p class="request-identifiers">模型 ${esc(item.model)} · Worker 第 ${item.workerAttempt} 轮${item.providerRequestId ? ` · 上游请求 ID ${esc(item.providerRequestId)}` : ''}</p></div></details>`;
  }
  function render(data: AdminJobDetail) {
    const nextFingerprint = JSON.stringify(data);
    if (nextFingerprint === fingerprint) return;
    const opened = fingerprint ? new Set([...body.querySelectorAll<HTMLDetailsElement>('.request-attempt[open]')].map(el => el.dataset.traceId!)) : null;
    const contextOpened = [...body.querySelectorAll<HTMLDetailsElement>('[data-preserve-open][open]')].map(el => el.dataset.preserveOpen);
    const inputOpened = new Set([...body.querySelectorAll<HTMLDetailsElement>('.request-input[open]')].map(el => el.closest<HTMLElement>('[data-trace-id]')!.dataset.traceId));
    const scroll = body.scrollTop;
    const codeScroll = new Map([...body.querySelectorAll<HTMLElement>('[data-code]')].map(node => [node.dataset.code, node.querySelector('pre')!.scrollTop]));
    fingerprint = nextFingerprint;
    texts.clear();
    title.textContent = data.title || '精读任务';
    state.className = `admin-state is-${data.status}`;
    state.textContent = labels[data.status] ?? data.status;
    const url = data.articleId ? `/news/?article=${encodeURIComponent(data.articleId)}` : data.paperId
      ? `/${data.examLevel === 'CET4' ? 'cet4' : data.examLevel === 'CET6' ? 'cet6' : 'postgraduate'}/?paper=${encodeURIComponent(data.paperId)}&mode=intensive` : '';
    sourceLink.hidden = !url; sourceLink.href = url || '#';
    const original = data.question?.prompt || data.source;
    const first = data.requests[0], last = data.requests.at(-1);
    const failure = data.errorMessage ? `<section class="request-result is-error"><h3>为什么失败</h3><p>${esc(explainAnalysisFailure(data.errorMessage))}</p><pre>${esc(data.errorMessage)}</pre></section>` : '';
    const context = data.question ? JSON.stringify(data.question, null, 2) : [data.context.previousSentence && `上一句：${data.context.previousSentence}`, data.context.nextSentence && `下一句：${data.context.nextSentence}`].filter(Boolean).join('\n\n');
    body.innerHTML = `<div class="request-detail-meta"><span>${esc(data.model)}</span><span>${data.type === 'question' ? '做题精读' : data.type === 'text' ? '题面精读' : '文章精读'}</span><span>北京时间 · 精确到毫秒</span></div>${failure}<section class="request-original"><h3>${data.type === 'question' ? '题目原文' : '原句'}</h3><p lang="en">${esc(original || '任务未保存原文。')}</p>${data.type !== 'question' && original ? `<details data-preserve-open="tokens"><summary>查看原句 token 索引</summary><div class="request-tokens">${tokenize(original).map(token => `<span><i>${token.index}</i>${esc(token.text)}</span>`).join('')}</div></details>` : ''}${context ? `<details data-preserve-open="context"><summary>${data.question ? '查看关联文章与选项' : '查看前后文'}</summary><pre>${esc(context)}</pre></details>` : ''}</section><section class="request-task-timing"><h3>任务时间线</h3><dl class="request-timeline">${stamp('加入队列', data.createdAt)}${stamp('首次开始处理', data.startedAt, data.status === 'pending' ? '尚未开始' : '未记录')}${stamp(data.requestsHasMore ? '最早保留的 AI 请求' : '首次发出 AI 请求', first?.sentAt ?? null, first ? '未记录' : '无请求记录')}${stamp('任务结束', data.finishedAt, ['pending', 'running'].includes(data.status) ? '处理中' : '未记录')}</dl><p class="request-attempt-meta">首次排队 ${duration(data.createdAt, data.startedAt)} · 任务处理 ${duration(data.startedAt, data.finishedAt)}${last?.completedAt ? ` · 最后一次返回 ${esc(date(last.completedAt))}` : ''}</p></section><section class="request-model-history"><div class="request-history-heading"><h3>AI 请求与返回</h3><span>${data.requests.length} 次${data.requestsHasMore ? ' · 显示最近 50 次' : ''}</span></div>${data.requests.length ? data.requests.map((item, index) => requestCard(item, index, opened, last!.id)).join('') : `<div class="request-history-empty"><p>${data.status === 'pending' ? '任务还在排队，尚未发出 AI 请求。' : '这条任务没有保存 AI 原始返回。'}</p><span>${data.status === 'pending' ? '开始处理后，每次请求会显示在这里。' : '旧记录当时只保存了最终状态和错误，无法恢复原始回答；更新后的新请求会记录发送内容、原始返回和校验结果。'}</span></div>`}</section><p class="request-identifiers">任务 ID ${esc(data.id)}<br>提示词版本 ${esc(data.promptVersion)}${data.mode === 'demo' ? ' · 演示模式，没有真实模型请求' : ''}</p>`;
    for (const item of body.querySelectorAll<HTMLDetailsElement>('.request-input')) if (inputOpened.has(item.closest<HTMLElement>('[data-trace-id]')!.dataset.traceId)) item.open = true;
    for (const item of body.querySelectorAll<HTMLDetailsElement>('[data-preserve-open]')) if (contextOpened.includes(item.dataset.preserveOpen)) item.open = true;
    body.scrollTop = scroll;
    for (const item of body.querySelectorAll<HTMLElement>('[data-code]')) item.querySelector('pre')!.scrollTop = codeScroll.get(item.dataset.code) ?? 0;
  }
  async function load(background = false) {
    if (!selected || (loading && background)) return;
    const id = selected, current = ++revision;
    loading = true; refresh.disabled = true;
    if (!background) { body.setAttribute('aria-busy', 'true'); feedback.textContent = '正在读取请求记录…'; }
    try {
      const data = await request(`/api/admin/analysis/jobs/${encodeURIComponent(id)}`);
      if (current !== revision || selected !== id || !dialog.open) return;
      render(data); feedback.textContent = '';
    } catch (error) {
      if (current === revision && selected === id && dialog.open) feedback.textContent = error instanceof Error ? error.message : '详情读取失败，可点击刷新重试。';
    } finally {
      if (current === revision) { loading = false; refresh.disabled = false; body.setAttribute('aria-busy', 'false'); }
    }
  }
  document.getElementById('admin-detail-close')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    const id = selected; revision += 1; selected = null; loading = false;
    if (id) document.querySelector<HTMLButtonElement>(`[data-detail-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  });
  refresh.addEventListener('click', () => void load());
  body.addEventListener('click', async event => {
    const target = event.target as HTMLElement;
    const block = target.closest<HTMLElement>('[data-code]');
    if (!block) return;
    const key = block.dataset.code!, value = texts.get(key) ?? '';
    const mode = target.closest<HTMLButtonElement>('[data-code-mode]');
    if (mode) {
      if (mode.dataset.codeMode === 'raw') rawModes.add(key); else rawModes.delete(key);
      block.querySelector('pre')!.textContent = rawModes.has(key) ? value : pretty(value);
      block.querySelectorAll<HTMLButtonElement>('[data-code-mode]').forEach(button => button.setAttribute('aria-pressed', String((button.dataset.codeMode === 'raw') === rawModes.has(key))));
    }
    const copy = target.closest<HTMLButtonElement>('[data-copy-code]');
    if (copy) {
      try { await navigator.clipboard.writeText(value); copy.textContent = '已复制'; }
      catch { feedback.textContent = '复制未成功，可直接选择返回内容复制。'; }
    }
  });
  return {
    open(id: string) {
      if (selected !== id) { fingerprint = ''; texts.clear(); rawModes.clear(); body.replaceChildren(); body.scrollTop = 0; title.textContent = '请求详情'; state.textContent = ''; sourceLink.hidden = true; }
      selected = id;
      if (!dialog.open) dialog.showModal();
      void load();
    },
    refresh() { if (dialog.open) void load(true); },
  };
}
