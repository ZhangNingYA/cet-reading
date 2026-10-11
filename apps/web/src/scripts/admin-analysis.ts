type RuntimeSettings = {
  workerConcurrency: number;
  queueCapacity: number;
  backgroundTarget: number;
  backfillPaused: boolean;
};
type Overview = {
  observedAt: string;
  model: string;
  mode: string;
  promptVersion: string;
  settings: RuntimeSettings;
  queue: {
    pending: number;
    running: number;
    failed: number;
    active: number;
    capacity: number;
    oldestPendingAt: string | null;
    oldestRunningAt: string | null;
  };
  metrics: {
    successLastHour: number;
    failedLastHour: number;
    successLastSixHours: number;
    failedLastSixHours: number;
    queueP50Seconds: number | null;
    queueP90Seconds: number | null;
    generationP50Seconds: number | null;
    generationP90Seconds: number | null;
  };
  cache: { total: number; cached: number; rate: number };
};

const root = document.getElementById('admin-analysis') as HTMLElement;
const apiBase = root.dataset.apiBase || '';
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const adminStatus = el<HTMLElement>('admin-status');
const grid = root.querySelector('.admin-grid') as HTMLElement;
const concurrency = el<HTMLInputElement>('admin-concurrency');
const capacityInput = el<HTMLInputElement>('admin-capacity-input');
const backgroundTarget = el<HTMLInputElement>('admin-background-target');
const save = el<HTMLButtonElement>('admin-save');
const pause = el<HTMLButtonElement>('admin-pause');
const resume = el<HTMLButtonElement>('admin-resume');
let requestInFlight = false;

function formatSeconds(value: number | null) {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value < 60) return `${Math.round(value)} 秒`;
  return `${(value / 60).toFixed(1)} 分钟`;
}
function formatAge(time: string | null) {
  if (!time) return '当前没有等待中的任务';
  const seconds = Math.max(0, (Date.now() - new Date(time).getTime()) / 1000);
  return `最早任务已等待 ${formatSeconds(seconds)}`;
}
function formatTime(time: string | null) {
  return time ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(time)) : '—';
}
function setStatus(message: string, error = false) {
  adminStatus.textContent = message;
  adminStatus.classList.toggle('admin-error', error);
}
async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${apiBase}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string; error?: string } | null;
    throw new Error(body?.message || body?.error || `请求失败（${response.status}）`);
  }
  return response.json();
}
function render(data: Overview) {
  const queue = data.queue; const metrics = data.metrics; const settings = data.settings;
  el('admin-running').textContent = String(queue.running);
  el('admin-pending').textContent = String(queue.pending);
  el('admin-failed').textContent = String(queue.failed);
  el('admin-capacity').textContent = `${queue.active} / ${queue.capacity}`;
  el('admin-queue-age').textContent = `${formatAge(queue.oldestPendingAt)} · 最早生成任务：${formatTime(queue.oldestRunningAt)}`;
  el('admin-observed-at').textContent = `更新于 ${formatTime(data.observedAt)}`;
  el('admin-success-1h').textContent = String(metrics.successLastHour);
  el('admin-failed-1h').textContent = String(metrics.failedLastHour);
  el('admin-success-6h').textContent = String(metrics.successLastSixHours);
  el('admin-queue-latency').textContent = `${formatSeconds(metrics.queueP50Seconds)} / ${formatSeconds(metrics.queueP90Seconds)}`;
  el('admin-generation-latency').textContent = `${formatSeconds(metrics.generationP50Seconds)} / ${formatSeconds(metrics.generationP90Seconds)}`;
  el('admin-cache-rate').textContent = `${data.cache.rate.toFixed(1)}%`;
  el('admin-cache-count').textContent = `${data.cache.cached.toLocaleString()} / ${data.cache.total.toLocaleString()} 条可见句子已缓存`;
  concurrency.value = String(settings.workerConcurrency);
  capacityInput.value = String(settings.queueCapacity);
  backgroundTarget.value = String(settings.backgroundTarget);
  el('admin-backfill-state').textContent = settings.backfillPaused ? '后台补齐已暂停；用户主动精读仍可继续。' : `后台补齐运行中 · 当前模型 ${data.model} · ${data.mode}`;
  pause.disabled = settings.backfillPaused; resume.disabled = !settings.backfillPaused;
  grid.setAttribute('aria-busy', 'false');
}
async function load(silent = false) {
  if (requestInFlight) return;
  requestInFlight = true;
  try {
    const data = await request('/api/admin/analysis') as Overview;
    render(data); if (!silent) setStatus('后台状态已加载。');
  } catch (error) {
    grid.setAttribute('aria-busy', 'false');
    setStatus(error instanceof Error && error.message === 'admin_disabled' ? '后台控制台尚未启用。' : (error instanceof Error ? error.message : '后台状态加载失败。'), true);
  } finally { requestInFlight = false; }
}
async function saveSettings() {
  const next = { workerConcurrency: Number(concurrency.value), queueCapacity: Number(capacityInput.value), backgroundTarget: Number(backgroundTarget.value) };
  if (!Number.isInteger(next.workerConcurrency) || next.workerConcurrency < 1 || next.workerConcurrency > 4 ||
      !Number.isInteger(next.queueCapacity) || next.queueCapacity < 1 || next.queueCapacity > 32 ||
      next.queueCapacity < next.workerConcurrency ||
      !Number.isInteger(next.backgroundTarget) || next.backgroundTarget < 0 || next.backgroundTarget > next.queueCapacity) {
    setStatus('设置范围无效：并发 1–4，队列 1–32 且不能小于并发数，后台目标不能超过队列上限。', true); return;
  }
  save.disabled = true;
  try { await request('/api/admin/analysis/settings', { method: 'PATCH', body: JSON.stringify(next) }); setStatus('设置已保存，Worker 会在几秒内动态应用。'); await load(true); }
  catch (error) { setStatus(error instanceof Error ? error.message : '设置保存失败。', true); }
  finally { save.disabled = false; }
}
async function setPaused(value: boolean) {
  (value ? pause : resume).disabled = true;
  try { await request(`/api/admin/analysis/backfill/${value ? 'pause' : 'resume'}`, { method: 'POST' }); setStatus(value ? '后台补齐已暂停。' : '后台补齐已恢复。'); await load(true); }
  catch (error) { setStatus(error instanceof Error ? error.message : '操作失败。', true); }
}
save.addEventListener('click', () => void saveSettings());
pause.addEventListener('click', () => void setPaused(true));
resume.addEventListener('click', () => void setPaused(false));
void load();
setInterval(() => { if (document.visibilityState !== 'hidden') void load(true); }, 10_000);
