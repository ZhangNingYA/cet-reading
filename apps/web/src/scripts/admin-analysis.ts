export {};
type RuntimeSettings = {
  workerConcurrency: number;
  queueCapacity: number;
  backgroundTarget: number;
  backfillPaused: boolean;
  promptOverride: string;
};
type Paper = {
  id: string;
  title: string;
  exam_level: string;
  year: number;
  month: number;
  set_no: number;
  priority: number;
  sort_order: number;
  total: number;
  cached: number;
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
    `${data.cache.cached.toLocaleString()} / ${data.cache.total.toLocaleString()} 条可见句子已有可复用缓存`;
  el("admin-cache-detail").textContent = data.cache.legacyCached
    ? `其中当前 Prompt ${data.cache.currentCached.toLocaleString()} 条，历史兼容 Prompt ${data.cache.legacyCached.toLocaleString()} 条；试卷 ${data.cache.paperTotal.toLocaleString()} 句，资讯 ${data.cache.newsTotal.toLocaleString()} 句。`
    : `当前 Prompt 已缓存 ${data.cache.currentCached.toLocaleString()} 条；试卷 ${data.cache.paperTotal.toLocaleString()} 句，资讯 ${data.cache.newsTotal.toLocaleString()} 句。`;
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
  panels.setAttribute("aria-busy", "false");
}
async function load(silent = false) {
  if (inFlight) return;
  inFlight = true;
  try {
    const data = (await request("/api/admin/analysis")) as Overview;
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
  }
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
function renderPapers() {
  const target = el<HTMLElement>("admin-paper-list");
  target.innerHTML = papers.length
    ? papers
        .map(
          (paper, index) =>
            `<div class="admin-paper-row" draggable="true" data-index="${index}"><span class="admin-drag-handle" aria-label="拖动排序">⋮⋮</span><span class="admin-paper-name"><strong>${esc(paper.title)}</strong><small>${esc(paper.exam_level)} · ${paper.year}-${String(paper.month).padStart(2, "0")} · ${paper.cached}/${paper.total} 句</small></span><label>优先级<input class="admin-paper-priority" data-id="${esc(paper.id)}" type="number" min="-100" max="100" value="${paper.priority}" /></label></div>`,
        )
        .join("")
    : '<p class="admin-note">暂时没有已发布试卷。</p>';
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
    paperId: paper.id,
    priority: Number(
      (
        document.querySelector(
          `.admin-paper-priority[data-id="${CSS.escape(paper.id)}"]`,
        ) as HTMLInputElement
      )?.value ?? paper.priority,
    ),
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
async function retry(code: string) {
  const button = document.querySelector<HTMLButtonElement>(
    `.admin-retry[data-code="${CSS.escape(code)}"]`,
  );
  if (button) button.disabled = true;
  try {
    const data = (await request("/api/admin/analysis/retry", {
      method: "POST",
      body: JSON.stringify({ errorCode: code, limit: 500 }),
    })) as { retried: number };
    setStatus(`已将 ${data.retried} 条${code}失败任务重新排队。`);
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
el("admin-retry-list").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
    ".admin-retry",
  );
  if (button) void retry(button.dataset.code || "");
});
void Promise.all([load(), loadPapers(), loadAudit()]);
setInterval(() => {
  if (document.visibilityState !== "hidden") {
    void load(true);
    void loadPapers();
    void loadAudit();
  }
}, 10000);
