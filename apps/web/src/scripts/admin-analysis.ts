import { paperProgressEntries } from "./analysis-progress";
type RuntimeSettings = {
  workerConcurrency: number;
  queueCapacity: number;
  backgroundTarget: number;
  backfillPaused: boolean;
  promptOverride: string;
};
type Paper = {
  id: string;
  source_type: "paper" | "news";
  source_id: string;
  title: string;
  exam_level: string;
  year: number;
  month: number;
  set_no: number;
  priority: number;
  sort_order: number;
  total: number;
  cached: number;
  sentence_total?: number;
  sentence_cached?: number;
  analysis_text_total?: number;
  analysis_text_cached?: number;
  analysis_solving_total?: number;
  analysis_solving_cached?: number;
};
type JobType = "sentence" | "text" | "question";
const jobLabels: Record<JobType, string> = { sentence: "文章精读", text: "题面精读", question: "做题精读" };
const jobStatusLabels: Record<string, string> = { pending: "排队中", running: "生成中", succeeded: "已完成", failed: "失败" };
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
    byType: Record<JobType, { pending: number; running: number; failed: number }>;
  };
  jobs: Array<{
    id: string; type: JobType; textKey: string | null; status: string;
    title: string; sectionTitle: string | null; source: string;
    questionId: string | null; sentenceId: string | null; attempts: number;
    errorCode: string | null; createdAt: string | null; startedAt: string | null;
    finishedAt: string | null; nextAttemptAt: string | null;
  }>;
  metrics: {
    successLastHour: number;
    failedLastHour: number;
    successLastSixHours: number;
    failedLastSixHours: number;
    queueP50Seconds: number | null;
    queueP90Seconds: number | null;
    generationP50Seconds: number | null;
    generationP90Seconds: number | null;
    timeline: Array<{
      at: string | null;
      success: number;
      failed: number;
      queueP50Seconds: number | null;
      queueP90Seconds: number | null;
      generationP50Seconds: number | null;
      generationP90Seconds: number | null;
    }>;
  };
  errors: Array<{ error_code: string; count: number }>;
  workers: Array<{
    workerId: string;
    hostname: string;
    pid: number;
    activeJobs: number;
    concurrency: number;
    lastSeenAt: string | null;
    startedAt: string | null;
  }>;
  cache: {
    total: number;
    cached: number;
    currentCached: number;
    legacyCached: number;
    paperTotal: number;
    newsTotal: number;
    sentenceTotal: number;
    sentenceCached: number;
    textTotal: number;
    textCached: number;
    solvingTotal: number;
    solvingCached: number;
    rate: number;
  };
};
const root = document.getElementById("admin-analysis") as HTMLElement;
const apiBase = root.dataset.apiBase || "";
const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const adminStatus = el<HTMLElement>("admin-status");
const panels = root.querySelector(".admin-panels") as HTMLElement;
const concurrency = el<HTMLInputElement>("admin-concurrency");
const capacity = el<HTMLInputElement>("admin-capacity-input");
const background = el<HTMLInputElement>("admin-background-target");
const promptInput = el<HTMLTextAreaElement>("admin-prompt");
const save = el<HTMLButtonElement>("admin-save");
const pause = el<HTMLButtonElement>("admin-pause");
const resume = el<HTMLButtonElement>("admin-resume");
let inFlight = false;
let papers: Paper[] = [];
let paperPage = 0;
const PAPER_PAGE_SIZE = 10;
const paperSearch = el<HTMLInputElement>("admin-paper-search");
const paperLevel = el<HTMLSelectElement>("admin-paper-level");
function seconds(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value < 60) return `${Math.round(value)} 秒`;
  return `${(value / 60).toFixed(1)} 分钟`;
}
function time(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date(value))
    : "—";
}
function esc(value: unknown) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] || c,
  );
}
function setStatus(message: string, error = false) {
  adminStatus.textContent = message;
  adminStatus.classList.toggle("admin-error", error);
}
async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
      error?: string;
    } | null;
    throw new Error(
      body?.message || body?.error || `请求失败（${response.status}）`,
    );
  }
  return response.json();
}
function renderChart(data: Overview) {
  const chart = el<HTMLElement>("admin-latency-chart");
  const rows = data.metrics.timeline || [];
  if (!rows.length) {
    chart.innerHTML = '<p class="admin-note">暂时没有足够的成功任务数据。</p>';
    return;
  }
  const max = Math.max(
    1,
    ...rows.flatMap((row) => [
      row.queueP90Seconds || 0,
      row.generationP90Seconds || 0,
    ]),
  );
  chart.innerHTML = rows
    .map((row) => {
      const q = Math.round(((row.queueP90Seconds || 0) / max) * 100);
      const g = Math.round(((row.generationP90Seconds || 0) / max) * 100);
      return `<div class="admin-chart-column" title="${esc(time(row.at))} · 排队 P50 ${esc(seconds(row.queueP50Seconds))} / P90 ${esc(seconds(row.queueP90Seconds))} · 生成 P50 ${esc(seconds(row.generationP50Seconds))} / P90 ${esc(seconds(row.generationP90Seconds))}"><span class="admin-chart-bar admin-chart-queue" style="height:${q}%"></span><span class="admin-chart-bar admin-chart-generation" style="height:${g}%"></span><small>${esc(row.at ? new Date(row.at).toLocaleTimeString("zh-CN", { hour: "2-digit" }) : "")}</small></div>`;
    })
    .join("");
}
function renderErrors(data: Overview) {
  const target = el<HTMLElement>("admin-retry-list");
  el("admin-retry-summary").textContent = `当前共有 ${data.queue.failed.toLocaleString()} 条任务处于失败隔离；下方按最近 24 小时的错误类型统计。重试会清零尝试次数并重新进入队列。`;
  el<HTMLButtonElement>("admin-retry-all").disabled = data.queue.failed === 0;
  const labels: Record<string, string> = {
    timeout: "超时",
    service_unavailable: "服务不可用",
    invalid_result: "结果校验失败",
    generation_failed: "其他生成错误",
  };
  target.innerHTML = data.errors.length
    ? data.errors
        .map(
          (item) =>
            `<div class="admin-retry-row"><span><strong>${esc(labels[item.error_code] || item.error_code)}</strong><small>${item.count} 条（24 小时）</small></span><button class="button button-small admin-retry" data-code="${esc(item.error_code)}" type="button">重试此类</button></div>`,
        )
        .join("")
    : '<p class="admin-note">过去 24 小时没有失败任务。</p>';
}
function renderWorkers(data: Overview) {
  const target = el<HTMLElement>("admin-worker-list");
  target.innerHTML = data.workers.length
    ? data.workers
        .map((worker) => {
          const online = worker.lastSeenAt
            ? Date.now() - new Date(worker.lastSeenAt).getTime() < 20000
            : false;
          return `<div class="admin-worker-row"><span class="admin-worker-dot ${online ? "is-online" : ""}"></span><strong>${esc(worker.workerId)}</strong><span>${online ? "在线" : "离线"} · ${worker.activeJobs}/${worker.concurrency} 个任务</span><small>心跳 ${esc(time(worker.lastSeenAt))}</small></div>`;
        })
        .join("")
    : '<p class="admin-note">暂未收到 Worker 心跳。</p>';
}
function renderJobs(data: Overview) {
  el("admin-queue-types").innerHTML = (Object.keys(jobLabels) as JobType[]).map(type => {
    const counts = data.queue.byType[type];
    return `<div><strong>${jobLabels[type]}</strong><span>${counts.running} 生成中 · ${counts.pending} 排队 · ${counts.failed} 失败</span></div>`;
  }).join("");
  const types = el<HTMLSelectElement>("admin-job-type").value;
  const status = el<HTMLSelectElement>("admin-job-status").value;
  const jobs = data.jobs.filter(job => (!types || job.type === types) && (!status || job.status === status));
  el("admin-job-count").textContent = `${jobs.length} 条 · 每 10 秒刷新`;
  el("admin-job-list").innerHTML = jobs.length ? jobs.map(job => {
    const detail = job.type === "text" ? (job.textKey === "prompt" ? "题干" : `选项 ${job.textKey?.replace("option:", "") || ""}`) : "";
    const updated = job.finishedAt || (job.status === "running" ? job.startedAt : job.createdAt);
    const retryAt = job.status === "pending" && job.attempts > 0 && job.nextAttemptAt && Date.parse(job.nextAttemptAt) > Date.now()
      ? ` · 重试时间 ${time(job.nextAttemptAt)}` : "";
    return `<div class="admin-job-row"><div class="admin-job-copy"><strong>${esc(job.title || "精读任务")}</strong><small>${esc(jobLabels[job.type])}${detail ? ` · ${esc(detail)}` : ""}${job.sectionTitle ? ` · ${esc(job.sectionTitle)}` : ""}</small><p lang="en">${esc(job.source)}</p><small>${esc(job.questionId || job.sentenceId || job.id)} · 请求 ${esc(job.id)} · 尝试 ${job.attempts} 次${esc(retryAt)}</small></div><div class="admin-job-state"><strong class="${job.status === "failed" ? "admin-error" : ""}">${esc(jobStatusLabels[job.status] || job.status)}</strong><small>${esc(time(updated))}</small>${job.errorCode ? `<small>${esc(job.errorCode)}</small>` : ""}</div></div>`;
  }).join("") : '<p class="admin-note">当前筛选下没有任务。</p>';
}
function render(data: Overview) {
  const q = data.queue,
    m = data.metrics,
    s = data.settings;
  el("admin-running").textContent = String(q.running);
  el("admin-pending").textContent = String(q.pending);
  el("admin-failed").textContent = String(q.failed);
  el("admin-capacity").textContent = `${q.active} / ${q.capacity}`;
  el("admin-queue-age").textContent = q.oldestPendingAt
    ? `最早任务已等待 ${seconds(Math.max(0, (Date.now() - new Date(q.oldestPendingAt).getTime()) / 1000))} · 最早生成任务：${time(q.oldestRunningAt)}`
    : "当前没有等待中的任务";
  el("admin-observed-at").textContent = `更新于 ${time(data.observedAt)}`;
  el("admin-success-1h").textContent = String(m.successLastHour);
  el("admin-failed-1h").textContent = String(m.failedLastHour);
  el("admin-success-6h").textContent = String(m.successLastSixHours);
  el("admin-queue-latency").textContent =
    `${seconds(m.queueP50Seconds)} / ${seconds(m.queueP90Seconds)}`;
  el("admin-generation-latency").textContent =
    `${seconds(m.generationP50Seconds)} / ${seconds(m.generationP90Seconds)}`;
  el("admin-cache-rate").textContent = `${data.cache.rate.toFixed(1)}%`;
  el("admin-cache-count").textContent =
    `${data.cache.cached.toLocaleString()} / ${data.cache.total.toLocaleString()} 条精读已有可复用缓存`;
  el("admin-cache-detail").textContent =
    `文章精读 ${data.cache.sentenceCached}/${data.cache.sentenceTotal} · 题面精读 ${data.cache.textCached}/${data.cache.textTotal} · 做题精读 ${data.cache.solvingCached}/${data.cache.solvingTotal}；当前 Prompt ${data.cache.currentCached.toLocaleString()} 条，历史兼容 ${data.cache.legacyCached.toLocaleString()} 条。`;
  concurrency.value = String(s.workerConcurrency);
  capacity.value = String(s.queueCapacity);
  background.value = String(s.backgroundTarget);
  promptInput.value = s.promptOverride || "";
  el("admin-backfill-state").textContent = s.backfillPaused
    ? "后台补齐已暂停；用户主动精读仍可继续。"
    : `后台补齐运行中 · ${data.model} · ${data.mode}`;
  pause.disabled = s.backfillPaused;
  resume.disabled = !s.backfillPaused;
  renderChart(data);
  renderErrors(data);
  renderWorkers(data);
  renderJobs(data);
  panels.setAttribute("aria-busy", "false");
}
async function load(silent = false) {
  if (inFlight) return;
  inFlight = true;
  const filters = jobFilters();
  try {
    const data = (await request(`/api/admin/analysis?${filters}`)) as Overview;
    render(data);
    if (!silent) setStatus("后台状态已加载。");
  } catch (error) {
    panels.setAttribute("aria-busy", "false");
    setStatus(
      error instanceof Error && error.message === "admin_disabled"
        ? "后台控制台尚未启用。"
        : error instanceof Error
          ? error.message
          : "后台状态加载失败。",
      true,
    );
  } finally {
    inFlight = false;
    if (filters !== jobFilters()) void load(true);
  }
}
function jobFilters() {
  const params = new URLSearchParams();
  const type = el<HTMLSelectElement>("admin-job-type").value;
  const status = el<HTMLSelectElement>("admin-job-status").value;
  if (type) params.set("jobType", type);
  if (status) params.set("jobStatus", status);
  return params.toString();
}
async function loadPapers() {
  try {
    const data = (await request("/api/admin/analysis/papers")) as {
      papers: Paper[];
    };
    papers = data.papers;
    renderPapers();
  } catch (error) {
    el("admin-paper-list").innerHTML =
      `<p class="admin-note admin-error">${esc(error instanceof Error ? error.message : "试卷加载失败")}</p>`;
  }
}
function filteredPapers() {
  const query = paperSearch.value.trim().toLowerCase();
  return papers
    .map((paper, index) => ({ paper, index }))
    .filter(({ paper }) => {
      const matchesQuery = !query || `${paper.id} ${paper.title} ${paper.year}-${paper.month} ${paper.exam_level}`.toLowerCase().includes(query);
      const matchesLevel = !paperLevel.value || (paperLevel.value === "POSTGRAD"
        ? paper.source_type === "paper" && !["CET4", "CET6"].includes(paper.exam_level)
        : paper.exam_level === paperLevel.value);
      return matchesQuery && matchesLevel;
    });
}
function renderPapers() {
  const target = el<HTMLElement>("admin-paper-list");
  const matches = filteredPapers();
  const pages = Math.max(1, Math.ceil(matches.length / PAPER_PAGE_SIZE));
  paperPage = Math.min(paperPage, pages - 1);
  const visible = matches.slice(paperPage * PAPER_PAGE_SIZE, (paperPage + 1) * PAPER_PAGE_SIZE);
  el("admin-paper-count").textContent = matches.length ? `共 ${matches.length} 套 · 第 ${paperPage + 1}/${pages} 页` : "没有匹配的试卷";
  el<HTMLButtonElement>("admin-paper-prev").disabled = paperPage === 0;
  el<HTMLButtonElement>("admin-paper-next").disabled = paperPage >= pages - 1;
  el("admin-paper-page").textContent = `${paperPage + 1} / ${pages}`;
  target.innerHTML = visible.length
    ? visible.map(({ paper, index }) =>
      `<div class="admin-paper-row" draggable="true" data-index="${index}"><span class="admin-drag-handle" aria-label="拖动排序">⋮⋮</span><span class="admin-paper-name"><strong><em class="admin-source-tag ${paper.source_type === "news" ? "is-news" : ""}">${paper.source_type === "news" ? "News" : "试卷"}</em>${esc(paper.title)}</strong><small>${esc(paper.exam_level)} · ${paper.year}-${String(paper.month).padStart(2, "0")} · 总进度 ${paper.cached}/${paper.total}</small>${paperProgressEntries({ ...paper, analysis_total: paper.sentence_total ?? paper.total, analysis_cached: paper.sentence_cached ?? paper.cached }).map(label => `<small>${esc(label)}</small>`).join("")}</span><label>优先级<input class="admin-paper-priority" data-key="${esc(`${paper.source_type}:${paper.source_id}`)}" type="number" min="-100" max="100" value="${paper.priority}" /></label></div>`).join("")
    : '<p class="admin-note">暂时没有匹配的试卷。</p>';
  target.querySelectorAll<HTMLInputElement>(".admin-paper-priority").forEach((input) => {
    input.addEventListener("change", () => {
      const paper = papers.find((item) => `${item.source_type}:${item.source_id}` === input.dataset.key);
      if (paper) paper.priority = Math.max(-100, Math.min(100, Number(input.value) || 0));
    });
  });
  target.querySelectorAll<HTMLElement>("[draggable=true]").forEach((row) => {
    row.addEventListener("dragstart", (e) =>
      e.dataTransfer?.setData("text/plain", row.dataset.index || ""),
    );
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      row.classList.add("is-drag-over");
    });
    row.addEventListener("dragleave", () =>
      row.classList.remove("is-drag-over"),
    );
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("is-drag-over");
      const from = Number(e.dataTransfer?.getData("text/plain"));
      const to = Number(row.dataset.index);
      if (Number.isInteger(from) && Number.isInteger(to) && from !== to) {
        const moved = papers.splice(from, 1)[0];
        papers.splice(to, 0, moved);
        renderPapers();
      }
    });
  });
}
async function saveOrder() {
  const items = papers.map((paper, index) => ({
    sourceType: paper.source_type,
    sourceId: paper.source_id,
    priority: paper.priority,
    sortOrder: index,
  }));
  try {
    await request("/api/admin/analysis/papers/reorder", {
      method: "POST",
      body: JSON.stringify({ items }),
    });
    setStatus("试卷优先级和顺序已保存。");
    await loadPapers();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "排序保存失败。", true);
  }
}
async function saveSettings() {
  const next = {
    workerConcurrency: Number(concurrency.value),
    queueCapacity: Number(capacity.value),
    backgroundTarget: Number(background.value),
    promptOverride: promptInput.value,
  };
  if (
    !Number.isInteger(next.workerConcurrency) ||
    next.workerConcurrency < 1 ||
    next.workerConcurrency > 4 ||
    !Number.isInteger(next.queueCapacity) ||
    next.queueCapacity < 1 ||
    next.queueCapacity > 32 ||
    next.queueCapacity < next.workerConcurrency ||
    !Number.isInteger(next.backgroundTarget) ||
    next.backgroundTarget < 0 ||
    next.backgroundTarget > next.queueCapacity ||
    next.promptOverride.length > 16000
  ) {
    setStatus("设置范围无效，请检查并发、队列、后台目标和 Prompt 长度。", true);
    return;
  }
  save.disabled = true;
  try {
    await request("/api/admin/analysis/settings", {
      method: "PATCH",
      body: JSON.stringify(next),
    });
    setStatus("设置和 Prompt 已保存，Worker 会在几秒内动态应用。");
    await load(true);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "设置保存失败。", true);
  } finally {
    save.disabled = false;
  }
}
async function setPaused(value: boolean) {
  (value ? pause : resume).disabled = true;
  try {
    await request(
      `/api/admin/analysis/backfill/${value ? "pause" : "resume"}`,
      { method: "POST" },
    );
    setStatus(value ? "后台补齐已暂停。" : "后台补齐已恢复。");
    await load(true);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "操作失败。", true);
  }
}
async function retry(code?: string) {
  const button = code ? document.querySelector<HTMLButtonElement>(`.admin-retry[data-code="${CSS.escape(code)}"]`) : el<HTMLButtonElement>("admin-retry-all");
  if (button) button.disabled = true;
  try {
    const data = (await request("/api/admin/analysis/retry", {
      method: "POST",
      body: JSON.stringify({ ...(code ? { errorCode: code } : {}), limit: 500 }),
    })) as { retried: number };
    setStatus(`已将 ${data.retried} 条${code ? `${code} 类型的` : ""}失败任务重新排队。`);
    await load(true);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "重试失败。", true);
  } finally {
    if (button) button.disabled = false;
  }
}
async function loadAudit() {
  try {
    const data = (await request("/api/admin/analysis/audit")) as {
      entries: Array<{
        changedAt: string;
        actor: string;
        action: string;
        before: unknown;
        after: unknown;
      }>;
    };
    el("admin-audit-list").innerHTML = data.entries.length
      ? data.entries
          .map(
            (entry) =>
              `<div class="admin-audit-row"><strong>${esc(entry.action)}</strong><span>${esc(entry.actor)} · ${esc(time(entry.changedAt))}</span><code>${esc(JSON.stringify(entry.after))}</code></div>`,
          )
          .join("")
      : '<p class="admin-note">还没有配置变更记录。</p>';
  } catch (error) {
    el("admin-audit-list").innerHTML =
      `<p class="admin-note admin-error">${esc(error instanceof Error ? error.message : "审计记录加载失败")}</p>`;
  }
}
save.addEventListener("click", () => void saveSettings());
pause.addEventListener("click", () => void setPaused(true));
resume.addEventListener("click", () => void setPaused(false));
el("admin-save-order").addEventListener("click", () => void saveOrder());
paperSearch.addEventListener("input", () => { paperPage = 0; renderPapers(); });
paperLevel.addEventListener("change", () => { paperPage = 0; renderPapers(); });
el("admin-paper-prev").addEventListener("click", () => { paperPage -= 1; renderPapers(); });
el("admin-paper-next").addEventListener("click", () => { paperPage += 1; renderPapers(); });
el("admin-retry-list").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
    ".admin-retry",
  );
  if (button) void retry(button.dataset.code || "");
});
el("admin-retry-all").addEventListener("click", () => void retry());
for (const id of ["admin-job-type", "admin-job-status"]) {
  el(id).addEventListener("change", () => void load(true));
}
void Promise.all([load(), loadPapers(), loadAudit()]);
setInterval(() => {
  if (document.visibilityState !== "hidden") {
    void load(true);
    void loadPapers();
    void loadAudit();
  }
}, 10000);
