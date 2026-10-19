import { createAdminRequestDetail } from './admin-request-detail';
type JobType = 'sentence' | 'text' | 'question';
type JobStatus = 'active' | 'failed' | 'succeeded';
type Board = 'CET4' | 'CET6' | 'POSTGRAD' | 'NEWS';
type Settings = { workerConcurrency: number; queueCapacity: number; backfillPaused: boolean };
type Progress = { total: number; cached: number; pending: number; running: number; failed: number };
type Priority = { id?: string; revision: string; paperId: string; sectionId: string | null; type: JobType; sourceType?: 'paper' | 'news'; title: string; sectionTitle: string | null; finishedAt: string | null; progress: Progress };
type PaperSection = { id: string; title: string; progress: Record<JobType, Progress> };
type Job = {
  id: string; type: JobType; textKey: string | null; status: string;
  paperId: string | null; articleId: string | null; examLevel: string | null;
  title: string; sectionTitle: string | null; source: string; errorCode: string | null;
  attempts: number;
  createdAt: string | null; startedAt: string | null; finishedAt: string | null;
};
type Overview = {
  observedAt: string; settings: Settings;
  queue: { pending: number; running: number; failed: number; active: number };
  jobs: Job[]; jobsPage: { page: number; limit: number; hasMore: boolean };
  priority: Priority[];
};
type Paper = {
  id: string; source_type: 'paper' | 'news'; title: string; exam_level: string; year: number; month: number; set_no: number; batch_at?: string; published_at?: string;
  total: number; cached: number; sentence_total?: number; sentence_cached?: number;
  analysis_text_total?: number; analysis_text_cached?: number;
  analysis_solving_total?: number; analysis_solving_cached?: number;
};
const root = document.getElementById('admin-analysis') as HTMLElement;
const apiBase = root.dataset.apiBase || '';
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const status = el('admin-status');
const speed = el<HTMLSelectElement>('admin-concurrency');
const toggle = el<HTMLButtonElement>('admin-toggle-backfill');
const jobType = el<HTMLSelectElement>('admin-job-type');
const search = el<HTMLInputElement>('admin-paper-search');
let selectedBoard: Board = 'CET4';
const boardViews = new Map<Board, { query: string; page: number }>();
const boardNames: Record<Board, string> = { CET4: '四级', CET6: '六级', POSTGRAD: '考研', NEWS: 'News' };
const tabs = [el<HTMLButtonElement>('admin-requests-tab'), el<HTMLButtonElement>('admin-progress-tab')];
const typeLabels: Record<JobType, string> = { sentence: '文章精读', text: '题面精读', question: '做题精读' };
const stateLabels: Record<string, string> = { pending: '排队中', running: '生成中', succeeded: '已完成', failed: '失败' };
const errorLabels: Record<string, string> = { timeout: '生成超时', service_unavailable: '服务连接失败', invalid_result: '生成内容不完整', generation_failed: '生成失败' };
let settings: Settings | null = null;
let currentPanel = 'requests';
let jobStatus: JobStatus = 'active';
let overviewLoading = false;
let papersLoading = false;
let settingsSaving = false;
let settingsRevision = 0;
let papersLoaded = false;
let retrying = false;
let clearing = false;
let papers: Paper[] = [];
let jobPage = 0;
let jobHasMore = false;
let jobRows: Job[] = [];
const detailPanel = createAdminRequestDetail(request);
let overviewController: AbortController | null = null;
let overviewRevision = 0;
let lastOverview: Overview | null = null;
let lastJobMarkup = '';
const requestViews = new Map<string, { jobs: Job[]; page: number; hasMore: boolean }>();
const requestViewKey = () => `${jobStatus}:${jobType.value}`;
let paperPage = 0;
let priority: Priority[] = [];
let prioritySaving = false;
let priorityRevision = 0;
let expandedPaper: string | null = null;
let sectionsLoading = false;
const sectionsByPaper = new Map<string, PaperSection[]>();
const PAGE_SIZE = 10;
const JOB_PAGE_SIZE = 20;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
// Progress aggregates sentences, question text and solving caches across all
// papers. It is intentionally allowed more time than the small control-panel
// requests, otherwise a healthy but busy database is shown as "signal timed out".
const PROGRESS_REQUEST_TIMEOUT_MS = 45000;
function esc(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function announce(message: string, error = false) {
  status.textContent = message;
  status.classList.toggle('admin-error', error);
}
function contentUrl(id: string | null, examLevel: string | null, articleId: string | null = null) {
  if (articleId) return `/news/?article=${encodeURIComponent(articleId)}`;
  if (!id) return '';
  const section = examLevel === 'CET4' ? 'cet4' : examLevel === 'CET6' ? 'cet6' : 'postgraduate';
  return `/${section}/?paper=${encodeURIComponent(id)}&mode=intensive`;
}
function time(value: string | null) {
  return value ? new Date(value).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' }) : '';
}
async function request(path: string, init?: RequestInit): Promise<any> {
  const timeoutMs = path.startsWith('/api/admin/analysis/papers')
    ? PROGRESS_REQUEST_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: { accept: 'application/json', 'content-type': 'application/json', ...init?.headers },
      signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error(path.startsWith('/api/admin/analysis/papers')
        ? '精读进度汇总较慢，请稍后刷新。'
        : '管理服务响应超时，请稍后重试。');
    }
    throw error;
  }
  const raw = await response.text();
  let body: { error?: string; message?: string } = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(response.ok
      ? '服务返回了无效数据，请刷新后重试。'
      : `管理服务暂时不可用（HTTP ${response.status}），请稍后重试。`);
  }
  if (!response.ok) throw new Error(body.error === 'admin_disabled' ? '精读管理尚未启用。' : body.message || '加载失败，请重试。');
  return body;
}
function filters(page = jobPage) {
  const params = new URLSearchParams({ jobStatus, page: String(page), limit: String(JOB_PAGE_SIZE) });
  if (jobType.value) params.set('jobType', jobType.value);
  return params.toString();
}
function renderSettings() {
  if (!settings) return;
  el('admin-backfill-state').textContent = settings.backfillPaused
    ? '自动生成已暂停，当前请求会继续完成。' : '自动生成已开启';
  if (!settingsSaving) {
    speed.value = String(settings.workerConcurrency);
    speed.disabled = false;
    toggle.textContent = settings.backfillPaused ? '恢复自动生成' : '暂停自动生成';
    toggle.disabled = false;
  }
}
function renderOverview(data: Overview) {
  settings = data.settings;
  el('admin-running').textContent = String(data.queue.running);
  el('admin-pending').textContent = String(data.queue.pending);
  el('admin-failed').textContent = String(data.queue.failed);
  el('admin-observed-at').textContent = `${time(data.observedAt)} 更新`;
  renderSettings();
  renderPriority(Array.isArray(data.priority) ? data.priority : data.priority ? [data.priority] : []);
  const retryAll = el<HTMLButtonElement>('admin-retry-all');
  retryAll.hidden = jobStatus !== 'failed';
  retryAll.disabled = retrying || data.queue.failed === 0;
  const clearFailures = el<HTMLButtonElement>('admin-clear-failures');
  clearFailures.hidden = jobStatus !== 'failed';
  clearFailures.disabled = clearing || data.queue.failed === 0;
  clearFailures.textContent = jobType.value ? `清空${typeLabels[jobType.value as JobType]}失败` : '清空全部失败';
  jobHasMore = Boolean(data.jobsPage?.hasMore);
  el('admin-requests-panel').setAttribute('aria-busy', 'false');
  const listMarkup = data.jobs.length ? data.jobs.map(job => {
    const url = contentUrl(job.paperId, job.examLevel, job.articleId);
    const title = url ? `<a href="${esc(url)}">${esc(job.title || '精读任务')} <span aria-hidden="true">↗</span></a>` : esc(job.title || '精读任务');
    const detail = job.type === 'text' ? (job.textKey === 'prompt' ? '题干' : `选项 ${job.textKey?.replace('option:', '') || ''}`) : '';
    const error = job.status === 'failed' && job.errorCode ? errorLabels[job.errorCode] || '生成失败' : '';

    const attempts = job.attempts ? ` · 尝试 ${job.attempts} 次` : '';
    return `<article class="admin-job-row"><div class="admin-job-copy"><h2>${title}</h2><p class="admin-job-source" lang="en" title="${esc(job.source)}">${esc(job.source)}</p><p class="admin-job-meta">${typeLabels[job.type]}${detail ? ` · ${esc(detail)}` : ''}${job.sectionTitle ? ` · ${esc(job.sectionTitle)}` : ''}${attempts}${error ? ` · <span class="admin-error">${error}</span>` : ''}</p></div><div class="admin-job-action"><span class="admin-state is-${esc(job.status)}">${esc(stateLabels[job.status] || job.status)}</span>${job.status === 'failed' ? `<button class="text-link admin-retry-one" type="button" data-job-id="${esc(job.id)}"${retrying ? ' disabled' : ''}>重试</button>` : `<time>${time(job.finishedAt || job.startedAt || job.createdAt)}</time>`}<button type="button" class="text-link admin-open-detail" data-detail-id="${esc(job.id)}" aria-haspopup="dialog">查看详情 <span aria-hidden="true">↗</span></button></div></article>`;
  }).join('') : `<p class="admin-empty">${jobStatus === 'active' ? '当前没有进行中的请求' : jobStatus === 'failed' ? '没有失败任务' : '最近 24 小时还没有完成记录'}</p>`;
  const list = el('admin-job-list');
  if (listMarkup !== lastJobMarkup) {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>('[data-detail-id], [data-job-id]') : null;
    const focusId = focused?.dataset.detailId;
    list.innerHTML = listMarkup;
    lastJobMarkup = listMarkup;
    if (focusId) list.querySelector<HTMLButtonElement>(`[data-detail-id="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
  }
  list.classList.remove('is-loading');
  list.style.minHeight = '';
  lastOverview = data;
  requestViews.set(requestViewKey(), { jobs: [...data.jobs], page: jobPage, hasMore: jobHasMore });
  const total = jobStatus === 'active' ? data.queue.active : jobStatus === 'failed' ? data.queue.failed : null;
  el('admin-job-count').textContent = total === null
    ? `每次显示 ${JOB_PAGE_SIZE} 条，按需加载更多 · 每 10 秒更新`
    : `显示 ${data.jobs.length} / ${total} 条 · 每次最多 ${JOB_PAGE_SIZE} 条 · 每 10 秒更新`;
  const more = el<HTMLButtonElement>('admin-job-more');
  more.hidden = !jobHasMore;
  more.disabled = overviewLoading;
}
function prepareRequestView() {
  const cached = requestViews.get(requestViewKey());
  jobPage = cached?.page ?? 0;
  jobRows = cached?.jobs ?? [];
  lastJobMarkup = '';
  if (cached && lastOverview) renderOverview({ ...lastOverview, jobs: [...cached.jobs], jobsPage: { page: jobPage, limit: JOB_PAGE_SIZE, hasMore: cached.hasMore } });
  else {
    const list = el('admin-job-list');
    list.style.minHeight = `${Math.min(360, list.getBoundingClientRect().height)}px`;
    list.innerHTML = '<div class="admin-request-loading" role="status"><span></span>正在读取请求记录…</div>';
    el('admin-job-count').textContent = '';
    el('admin-job-more').hidden = true;
  }
  el('admin-requests-panel').setAttribute('aria-busy', 'true');
}
async function loadOverview(append = false, force = false) {
  if (overviewLoading && !force) return;
  overviewController?.abort();
  const controller = new AbortController();
  overviewController = controller;
  const currentRevision = ++overviewRevision;
  overviewLoading = true;
  const key = requestViewKey();
  const revision = settingsRevision;
  const selectionRevision = priorityRevision;
  try {
    const pages = append ? [jobPage] : Array.from({ length: jobPage + 1 }, (_, index) => index);
    const responses = await Promise.all(pages.map(page => request(`/api/admin/analysis?${filters(page)}`, { signal: controller.signal }) as Promise<Overview>));
    if (currentRevision !== overviewRevision || key !== requestViewKey()) return;
    const data = responses[0]!;
    if (revision !== settingsRevision && settings) data.settings = settings;
    if (selectionRevision !== priorityRevision) data.priority = priority;
    const rows = append ? [...jobRows, ...data.jobs] : responses.flatMap(result => result.jobs);
    jobRows = [...new Map(rows.map(job => [job.id, job])).values()];
    data.jobs = jobRows;
    data.jobsPage = responses.at(-1)!.jobsPage;
    renderOverview(data);
    detailPanel.refresh();
  } catch (error) {
    if (!controller.signal.aborted && currentRevision === overviewRevision) {
      announce(error instanceof Error ? error.message : '请求加载失败。', true);
      el('admin-requests-panel').setAttribute('aria-busy', 'false');
      if (!jobRows.length) el('admin-job-list').innerHTML = '<p class="admin-empty">请求记录未能加载，可点击上方刷新重试。</p>';
    }
  } finally {
    if (currentRevision === overviewRevision) {
      overviewLoading = false;
      el<HTMLButtonElement>('admin-job-more').disabled = false;
    }
  }
}

function renderPriority(values: Priority[]) {
  priority = values;
  const container = el('admin-priority');
  container.hidden = !values.length;
  el('admin-priority-list').innerHTML = values.map((value, index) => `<div class="admin-priority-item"><div><strong>${index + 1}. ${esc(value.title)} · ${esc(value.sectionTitle || (value.sourceType === 'news' ? '整篇文章' : '整套试卷'))} · ${typeLabels[value.type]}</strong><p>已完成 ${value.progress.cached} / ${value.progress.total}${settings?.backfillPaused ? ' · 等待恢复自动生成' : ` · ${value.progress.pending + value.progress.running} 条已排队${value.progress.failed ? ` · ${value.progress.failed} 条失败` : ''}`}</p></div><button class="text-link admin-remove-priority" type="button" data-priority-revision="${esc(value.revision)}"${prioritySaving ? ' disabled' : ''}>取消</button></div>`).join('');
  el<HTMLButtonElement>('admin-clear-priority').disabled = prioritySaving;
}
function progressCell(label: string, total = 0, cached = 0, action?: { paperId: string; sectionId?: string; type: JobType; sourceType?: 'paper' | 'news' }) {
  if (!total) return `<div class="admin-progress-cell is-empty"><span class="admin-progress-label">${label}</span><span>—</span></div>`;
  const value = Math.min(cached, total);
  const percent = Math.round(value / total * 100);
  const clickable = action && value < total;
  const selected = action && priority.some(item => !item.finishedAt && item.paperId === action.paperId &&
    item.sourceType === (action.sourceType || 'paper') && item.sectionId === (action.sectionId || null) && item.type === action.type);
  const attrs = clickable ? `type="button" data-priority-paper="${esc(action.paperId)}" data-priority-source="${esc(action.sourceType || 'paper')}" data-priority-section="${esc(action.sectionId || '')}" data-priority-type="${action.type}" title="优先生成${label}"${prioritySaving || selected ? ' disabled' : ''}` : '';
  return `<${clickable ? 'button' : 'div'} class="admin-progress-cell${value === total ? ' is-complete' : ''}${selected ? ' is-priority' : ''}" ${attrs} aria-label="${selected ? '已加入队列，' : clickable ? '点击加入队列，' : ''}${label}，已完成 ${value}/${total}，${percent}%"><span class="admin-progress-label">${label}</span><span class="admin-progress-ratio">${value}<span> / ${total}</span>${selected ? '<small class="admin-queued-label">已排队</small>' : ''}</span><span class="admin-progress-track" aria-hidden="true"><i style="width:${percent}%"></i></span></${clickable ? 'button' : 'div'}>`;
}
function sectionRows(paperId: string) {
  const sections = sectionsByPaper.get(paperId);
  return `<div class="admin-paper-sections">${sections ? sections.map(section => `<div class="admin-part-row"><span class="admin-part-name">${esc(section.title)}</span>${(['sentence','text','question'] as JobType[]).map(type => progressCell(typeLabels[type], section.progress[type].total, section.progress[type].cached, { paperId, sectionId: section.id, type })).join('')}</div>`).join('') || '<p class="admin-empty">没有可生成的部分</p>' : '<p class="admin-empty">正在读取各部分进度…</p>'}</div>`;
}
function renderPapers() {
  el('admin-catalog-kind').textContent = selectedBoard === 'NEWS' ? '文章目录' : '试卷目录';
  const query = search.value.trim().toLowerCase();
  const inBoard = (paper: Paper) => selectedBoard === 'NEWS' ? paper.source_type === 'news'
    : paper.source_type === 'paper' && (selectedBoard === 'POSTGRAD' ? !['CET4', 'CET6'].includes(paper.exam_level) : paper.exam_level === selectedBoard);
  const boardPapers = papers.filter(inBoard);
  const visible = boardPapers.filter(paper => !query || `${paper.id} ${paper.title} ${paper.year}`.toLowerCase().includes(query)).sort((a, b) => selectedBoard === 'NEWS'
    ? Date.parse(b.batch_at || b.published_at || '1970-01-01') - Date.parse(a.batch_at || a.published_at || '1970-01-01') || a.id.localeCompare(b.id)
    : b.year - a.year || b.month - a.month || a.set_no - b.set_no || a.id.localeCompare(b.id));
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  paperPage = Math.min(paperPage, pages - 1);
  el('admin-paper-count').textContent = `${visible.length} ${selectedBoard === 'NEWS' ? '篇文章' : '套试卷'} · ${boardPapers.filter(paper => paper.cached >= paper.total).length} 已完成`;
  let year: number | null = null;
  el('admin-paper-list').innerHTML = visible.length ? visible.slice(paperPage * PAGE_SIZE, (paperPage + 1) * PAGE_SIZE).map(paper => {
    const heading = year !== paper.year ? `<h3 class="admin-catalog-year">${paper.year} <span>${selectedBoard === 'NEWS' ? '文章' : '年真题'}</span></h3>` : '';
    year = paper.year;
    const url = paper.source_type === 'news' ? contentUrl(null, null, paper.id) : contentUrl(paper.id, paper.exam_level);
    const action = (type: JobType) => ({ paperId: paper.id, type, sourceType: paper.source_type });
    const remainingType: JobType | null = (paper.sentence_cached ?? paper.cached) < (paper.sentence_total ?? paper.total) ? 'sentence'
      : (paper.analysis_text_cached ?? 0) < (paper.analysis_text_total ?? 0) ? 'text'
      : (paper.analysis_solving_cached ?? 0) < (paper.analysis_solving_total ?? 0) ? 'question' : null;
    const queued = priority.some(item => !item.finishedAt && item.paperId === paper.id && item.sectionId === null && item.type === remainingType);
    const title = remainingType ? `<button class="admin-paper-queue" type="button" data-priority-paper="${esc(paper.id)}" data-priority-source="${paper.source_type}" data-priority-type="${remainingType}" title="${queued ? '已加入' : '点击加入'}${typeLabels[remainingType]}队列"${prioritySaving || queued ? ' disabled' : ''}><strong>${esc(paper.title)}</strong><span>${queued ? '已排队' : '+ 加入队列'}</span></button>` : `<a href="${esc(url)}"><strong>${esc(paper.title)}</strong></a>`;
    return `${heading}<article class="admin-paper-row${remainingType ? '' : ' is-complete'}"><div class="admin-paper-name">${title}<div class="admin-paper-links"><a class="admin-catalog-source" href="${esc(url)}">查看原文 ↗</a>${!remainingType ? '<small class="admin-completed-label">全部已完成</small>' : ''}${paper.source_type === 'paper' ? `<button class="text-link admin-show-parts" type="button" data-parts-paper="${esc(paper.id)}" aria-expanded="${expandedPaper === paper.id}">${expandedPaper === paper.id ? '收起篇目' : remainingType ? '按篇目排队' : '查看篇目'} <span aria-hidden="true">${expandedPaper === paper.id ? '−' : '+'}</span></button>` : ''}</div></div>${progressCell('文章精读', paper.sentence_total ?? paper.total, paper.sentence_cached ?? paper.cached, action('sentence'))}${progressCell('题面精读', paper.analysis_text_total, paper.analysis_text_cached, action('text'))}${progressCell('做题精读', paper.analysis_solving_total, paper.analysis_solving_cached, action('question'))}${expandedPaper === paper.id ? sectionRows(paper.id) : ''}</article>`;
  }).join('') : `<p class="admin-empty">${query ? '没有匹配的内容' : `${boardNames[selectedBoard]}目录暂无内容`}</p>`;
  el('admin-paper-pagination').hidden = pages <= 1;
  el('admin-paper-page').textContent = `${paperPage + 1} / ${pages}`;
  el<HTMLButtonElement>('admin-paper-prev').disabled = paperPage === 0;
  el<HTMLButtonElement>('admin-paper-next').disabled = paperPage === pages - 1;
}
function setProgressBoard(board: Board) {
  if (selectedBoard === board) return;
  boardViews.set(selectedBoard, { query: search.value, page: paperPage });
  selectedBoard = board;
  const saved = boardViews.get(board);
  search.value = saved?.query ?? '';
  paperPage = saved?.page ?? 0;
  search.placeholder = board === 'NEWS' ? '搜索文章标题' : `搜索${boardNames[board]}试卷、年份`;
  root.querySelectorAll<HTMLButtonElement>('[data-progress-board]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.progressBoard === board)));
  renderPapers();
}

async function loadPapers() {
  if (papersLoading) return;
  papersLoading = true;
  try {
    papers = (await request('/api/admin/analysis/papers')).papers;
    papersLoaded = true;
    renderPapers();
    if (expandedPaper) void loadSections(expandedPaper);
  } catch (error) {
    el('admin-paper-list').innerHTML = `<p class="admin-empty admin-error">${esc(error instanceof Error ? error.message : '进度加载失败。')}</p>`;
  } finally {
    papersLoading = false;
    el('admin-progress-panel').setAttribute('aria-busy', 'false');
  }
}
async function loadSections(paperId: string) {
  if (sectionsLoading) return;
  sectionsLoading = true;
  try {
    const data = await request(`/api/admin/analysis/papers/${encodeURIComponent(paperId)}/sections`);
    sectionsByPaper.set(paperId, data.sections);
    if (expandedPaper === paperId) renderPapers();
  } catch (error) {
    announce(error instanceof Error ? error.message : '部分进度加载失败。', true);
  } finally {
    sectionsLoading = false;
    if (expandedPaper && expandedPaper !== paperId && !sectionsByPaper.has(expandedPaper)) void loadSections(expandedPaper);
  }
}
async function selectPriority(target: { paperId: string; sectionId: string | null; type: JobType; sourceType?: 'paper' | 'news' } | null) {
  if (prioritySaving) return;
  prioritySaving = true;
  renderPapers();
  el<HTMLButtonElement>('admin-clear-priority').disabled = true;
  try {
    const data = await request('/api/admin/analysis/priority', { method: 'POST', body: JSON.stringify(target) });
    priorityRevision += 1;
    renderPriority(Array.isArray(data.priority) ? data.priority : data.priority ? [data.priority] : []);
    announce(target ? settings?.backfillPaused ? '已设为优先，恢复自动生成后开始排队。'
      : data.queued ? `已优先排队 ${data.queued} 条，其余内容会持续分批排队。` : '已设为优先，等待当前任务完成后排队。' : '已取消优先。');
  } catch (error) {
    announce(error instanceof Error ? error.message : '优先排队失败，请重试。', true);
  } finally {
    prioritySaving = false;
    el<HTMLButtonElement>('admin-clear-priority').disabled = false;
    renderPapers();
    void loadOverview();
    if (currentPanel === 'progress') void loadPapers();
  }
}
async function removePriority(revision: string) {
  if (prioritySaving) return;
  prioritySaving = true;
  renderPriority(priority);
  try {
    const data = await request(`/api/admin/analysis/priority/${encodeURIComponent(revision)}`, { method: 'DELETE' });
    priorityRevision += 1;
    renderPriority(Array.isArray(data.priority) ? data.priority : data.priority ? [data.priority] : []);
    announce('已取消排队项。');
  } catch (error) {
    announce(error instanceof Error ? error.message : '取消排队失败，请重试。', true);
  } finally {
    prioritySaving = false;
    renderPriority(priority);
    void loadOverview();
    if (currentPanel === 'progress') void loadPapers();
  }
}
function showPanel(panel: string) {
  currentPanel = panel;
  tabs.forEach((tab, index) => {
    const selected = (index === 0 ? 'requests' : 'progress') === panel;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    el(tab.getAttribute('aria-controls')!).hidden = !selected;
  });
  if (panel === 'progress' && !papersLoaded) void loadPapers();
}
function setJobStatus(next: JobStatus) {
  jobStatus = next;
  root.querySelectorAll<HTMLButtonElement>('[data-job-status]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.jobStatus === next)));
  el('admin-retry-all').hidden = next !== 'failed';
  el('admin-clear-failures').hidden = next !== 'failed';
  prepareRequestView();
  void loadOverview(false, true);
}
async function saveSettings(paused?: boolean) {
  if (!settings || settingsSaving) return;
  settingsSaving = true;
  speed.disabled = true; toggle.disabled = true;
  try {
    const data = paused !== undefined
      ? await request(`/api/admin/analysis/backfill/${paused ? 'pause' : 'resume'}`, { method: 'POST' })
      : await request('/api/admin/analysis/settings', { method: 'PATCH', body: JSON.stringify({
      workerConcurrency: Number(speed.value), queueCapacity: Math.max(settings.queueCapacity, Number(speed.value) * 2),
    }) });
    settings = data.settings;
    settingsRevision += 1;
    announce(paused === undefined ? '同时生成数量已更新。' : paused ? '已暂停自动生成。' : '已恢复自动生成。');
  } catch (error) {
    announce(error instanceof Error ? error.message : '设置失败，请重试。', true);
  } finally {
    settingsSaving = false; speed.disabled = false; toggle.disabled = false;
    renderSettings();
    await loadOverview();
  }
}
async function retry(jobId?: string) {
  if (retrying) return;
  retrying = true;
  root.querySelectorAll<HTMLButtonElement>('.admin-retry-one, #admin-retry-all').forEach(button => { button.disabled = true; });
  try {
    const data = await request('/api/admin/analysis/retry', { method: 'POST', body: JSON.stringify({ ...(jobId ? { jobId } : {}), ...(jobType.value ? { jobType: jobType.value } : {}), limit: jobId ? 1 : settings?.queueCapacity ?? 8 }) });
    announce(data.retried ? `已将 ${data.retried} 条任务重新排队。` : '暂无可重试任务，或队列已满，请稍后再试。');
  } catch (error) {
    announce(error instanceof Error ? error.message : '重试失败，请稍后再试。', true);
  } finally {
    retrying = false;
    root.querySelectorAll<HTMLButtonElement>('.admin-retry-one, #admin-retry-all').forEach(button => { button.disabled = false; });
    await loadOverview();
  }
}
async function clearFailures() {
  if (clearing || jobStatus !== 'failed') return;
  const scope = jobType.value ? typeLabels[jobType.value as JobType] : '全部';
  if (!window.confirm(`确定清空${scope}失败记录吗？失败任务会从列表移除，成功的精读结果不会受影响。`)) return;
  clearing = true;
  const button = el<HTMLButtonElement>('admin-clear-failures');
  button.disabled = true;
  try {
    const data = await request('/api/admin/analysis/clear-failures', {
      method: 'POST', body: JSON.stringify(jobType.value ? { jobType: jobType.value } : {}),
    });
    announce(data.cleared ? `已清空 ${data.cleared} 条失败记录。` : '没有需要清空的失败记录。');
    jobRows = [];
    requestViews.clear();
    jobPage = 0;
  } catch (error) {
    announce(error instanceof Error ? error.message : '清空失败记录失败，请稍后再试。', true);
  } finally {
    clearing = false;
    button.disabled = false;
    await loadOverview();
  }
}

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => showPanel(index === 0 ? 'requests' : 'progress'));
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
    showPanel(next === 0 ? 'requests' : 'progress'); tabs[next].focus();
  });
});
root.querySelectorAll<HTMLButtonElement>('[data-job-status]').forEach(button => button.addEventListener('click', () => setJobStatus(button.dataset.jobStatus as JobStatus)));
jobType.addEventListener('change', () => { prepareRequestView(); void loadOverview(false, true); });
el('admin-show-failed').addEventListener('click', () => { jobType.value = ''; showPanel('requests'); setJobStatus('failed'); });
el('admin-refresh').addEventListener('click', () => { void loadOverview(); if (currentPanel === 'progress') void loadPapers(); });
speed.addEventListener('change', () => void saveSettings());
toggle.addEventListener('click', () => { if (settings) void saveSettings(!settings.backfillPaused); });
el('admin-retry-all').addEventListener('click', () => void retry());
el('admin-clear-failures').addEventListener('click', () => void clearFailures());
el('admin-job-more').addEventListener('click', () => {
  if (!jobHasMore || overviewLoading) return;
  jobPage += 1;
  void loadOverview(true);
});
el('admin-job-list').addEventListener('click', event => {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLButtonElement>('.admin-retry-one');
  if (button) void retry(button.dataset.jobId);
  const detail = target.closest<HTMLButtonElement>('[data-detail-id]');
  if (detail?.dataset.detailId) detailPanel.open(detail.dataset.detailId);
});
el('admin-clear-priority').addEventListener('click', () => void selectPriority(null));
el('admin-priority-list').addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.admin-remove-priority');
  if (!button?.dataset.priorityRevision || prioritySaving) return;
  void removePriority(button.dataset.priorityRevision);
});
el('admin-paper-list').addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (button?.dataset.priorityPaper) {
    void selectPriority({ paperId: button.dataset.priorityPaper, sourceType: button.dataset.prioritySource === 'news' ? 'news' : 'paper', sectionId: button.dataset.prioritySection || null, type: button.dataset.priorityType as JobType });
  } else if (button?.dataset.partsPaper) {
    const paperId = button.dataset.partsPaper;
    expandedPaper = expandedPaper === paperId ? null : paperId;
    renderPapers();
    if (expandedPaper) void loadSections(paperId);
  }
});
search.addEventListener('input', () => { paperPage = 0; renderPapers(); });
root.querySelectorAll<HTMLButtonElement>('[data-progress-board]').forEach(button => button.addEventListener('click', () => setProgressBoard(button.dataset.progressBoard as Board)));
el('admin-paper-prev').addEventListener('click', () => { paperPage -= 1; renderPapers(); });
el('admin-paper-next').addEventListener('click', () => { paperPage += 1; renderPapers(); });
void loadOverview();
setInterval(() => {
  if (document.visibilityState !== 'hidden') {
    void loadOverview();
    if (currentPanel === 'progress') void loadPapers();
  }
}, 10000);
