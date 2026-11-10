import { mountIntensive } from "./intensive-reader";
import type { LearningBlock } from "@cet-reading/contracts/learning";
const node = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const library = node("news-library"),
  reader = node("news-reader"),
  view = node("learning-view");
const apiBase = library.dataset.apiBase || "";
const profileKey = "cet-reading:learning-profile:v1";
type Article = {
  id: string;
  title: string;
  source_name: string;
  source_url: string;
  published_at: string;
  batch_at: string;
  word_count: number;
  learning_order: number;
  learning_stage: number;
  learning_role: string;
  lesson_title: string;
  learning_objective: string;
  learning_exercise: string;
  prerequisites: string[];
  source_revision: string;
};
type Progress = {
  article_id: string;
  status: "reading" | "completed" | "review";
  sentence_id: string | null;
  block_id: string | null;
  exercise_done: boolean;
  notes: string;
  revision: number;
  updated_at: string;
};
type Patch = {
  status?: Progress["status"];
  sentenceId?: string | null;
  blockId?: string | null;
  exerciseDone?: boolean;
  notes?: string;
};
let articles: Article[] = [],
  curriculum: { order: number; stage: number; role: string; title: string }[] =
    [],
  stages: { id: number; title: string; goal: string }[] = [];
let progress = new Map<string, Progress>(),
  token = "",
  tab = "learn",
  filter = "all",
  query = "",
  currentId: string | undefined,
  requestId = 0,
  dispose: (() => void) | undefined;
let libraryReady = false,
  profileReady = false;
const pending = new Map<string, Patch>(),
  inFlight = new Map<string, Patch>(),
  revisions = new Map<string, number>(),
  saving = new Map<string, Promise<void>>(),
  conflicts = new Set<string>();
let notesTimer: ReturnType<typeof setTimeout> | undefined;
const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  text?: string,
) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
async function json(
  path: string,
  init: RequestInit = {},
  auth = false,
  profileToken = token,
) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(auth ? { authorization: `Bearer ${profileToken}` } : {}),
    },
  });
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(data.error || "request_failed"), {
      status: response.status,
      data,
    });
  return data;
}
const statusLabel = (id: string) => {
  const p = progress.get(id);
  return p?.status === "completed"
    ? "已读"
    : p?.status === "review"
      ? "待复习"
      : p
        ? "学习中"
        : "未开始";
};
function articleLink(article: Article, label: string, cls = "") {
  const a = el("a", cls, label);
  a.href = `?article=${encodeURIComponent(article.id)}`;
  a.addEventListener("click", (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    void openArticle(article.id);
  });
  return a;
}
function row(a: Article, index?: number) {
  const link = articleLink(a, "", "learning-row");
  link.append(
    el(
      "span",
      "learning-row-number",
      String(index ?? a.learning_order).padStart(2, "0"),
    ),
  );
  const body = el("div");
  const meta = el("div", "learning-row-meta");
  meta.append(
    el("span", "", a.learning_role === "concept" ? "原理篇" : "实践篇"),
    el("span", "", a.source_name),
    el(
      "span",
      "",
      `阅读约 ${Math.max(3, Math.ceil(a.word_count / 160))} 分钟 · 练习另计`,
    ),
  );
  const title = el("h3", "", a.title);
  title.lang = "en";
  body.append(
    meta,
    title,
    el("p", "", a.learning_objective),
    el("span", "learning-row-state", statusLabel(a.id)),
  );
  link.append(body, el("span", "learning-row-arrow", "↗"));
  return link;
}
function matching() {
  return articles.filter((a) =>
    `${a.title} ${a.lesson_title} ${a.learning_objective} ${a.source_name}`
      .toLowerCase()
      .includes(query),
  );
}
function heading(title: string, detail = "") {
  const h = el("div", "learning-section-heading");
  h.append(el("h2", "", title));
  if (detail) h.append(el("span", "", detail));
  return h;
}
function resumeArticle() {
  return (
    articles.find((a) => progress.get(a.id)?.status !== "completed") ||
    articles.at(-1)
  );
}
function render() {
  if (!libraryReady) return;
  view.replaceChildren();
  view.setAttribute("aria-busy", "false");
  if (query) {
    view.append(heading("搜索结果", `${matching().length} 篇`));
    const rows = el("div", "learning-rows");
    for (const a of matching()) rows.append(row(a));
    view.append(rows);
    if (!rows.childElementCount)
      view.append(el("p", "learning-empty", "没有找到相关材料。"));
    return;
  }
  if (tab === "learn") {
    const resume = resumeArticle();
    if (resume) {
      const card = el("section", "learning-continue");
      const copy = el("div");
      const p = progress.get(resume.id);
      const complete = p?.status === "completed";
      copy.append(
        el(
          "p",
          "learning-eyebrow",
          complete ? "已读完当前材料" : p ? "继续上次" : "从这里开始",
        ),
        el("h2", "", resume.title),
        el(
          "p",
          "",
          `第 ${Math.ceil(resume.learning_order / 2)} 课 · ${resume.lesson_title}${p ? " · 已保存阅读位置" : ""}`,
        ),
      );
      card.append(
        copy,
        articleLink(
          resume,
          complete ? "回顾文章 →" : p ? "继续阅读 →" : "开始学习 →",
          "learning-primary",
        ),
      );
      view.append(card);
    }
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const dayOf = (s: string) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(s));
    const latest = articles.at(-1)?.batch_at;
    const daily = articles.filter((a) => a.batch_at === latest);
    view.append(
      heading(
        latest && dayOf(latest) === today ? "今天的两篇" : "最近的学习单元",
        daily[0]
          ? `第 ${Math.ceil(daily[0].learning_order / 2)} 课 / ${daily[0].lesson_title}`
          : "",
      ),
    );
    view.append(
      el(
        "p",
        "learning-section-note",
        latest && dayOf(latest) !== today
          ? "每天 08:00 更新两篇。继续学习会接着尚未完成的课次。"
          : "先读原理，再看实现。阅读和练习可以按自己的节奏完成。",
      ),
    );
    const rows = el("div", "learning-rows");
    daily.forEach((a, i) => rows.append(row(a, i + 1)));
    view.append(rows);
    if (!daily.length)
      view.append(
        el(
          "p",
          "learning-empty",
          "首批技术材料正在准备中。准备好后会出现在这里。",
        ),
      );
    const active =
      stages.find((s) => s.id === resume?.learning_stage) || stages[0];
    if (active) {
      const summary = el("section", "learning-stage-summary");
      summary.append(
        heading(
          "当前阶段",
          `${String(active.id).padStart(2, "0")} ${active.title}`,
        ),
      );
      const total = curriculum.filter((c) => c.stage === active.id).length;
      const done = articles.filter(
        (a) =>
          a.learning_stage === active.id &&
          progress.get(a.id)?.status === "completed",
      ).length;
      const bar = el("progress");
      bar.max = Math.max(total, 1);
      bar.value = done;
      bar.setAttribute("aria-label", `当前阶段已读 ${done} 篇，共 ${total} 篇`);
      summary.append(
        bar,
        el(
          "p",
          "",
          `已读 ${done} 篇 · 当前阶段已安排 ${total} 篇。完成状态由你确认。`,
        ),
      );
      view.append(summary);
    }
  } else if (tab === "route") {
    view.append(
      heading("从最小 Agent 到可靠服务"),
      el(
        "p",
        "learning-section-note",
        "围绕一个技术文档助手逐步实践。按课次阅读，也可以提前浏览已发布内容。",
      ),
    );
    const active = resumeArticle()?.learning_stage || 1;
    for (const s of stages) {
      const d = el("details", "learning-stage");
      d.open = s.id === active;
      d.append(
        el("summary", "", `${String(s.id).padStart(2, "0")}  ${s.title}`),
        el("p", "", s.goal),
      );
      const list = el("ol");
      for (const c of curriculum.filter((c) => c.stage === s.id)) {
        const li = el("li");
        const a = articles.find((a) => a.learning_order === c.order);
        if (a)
          li.append(
            articleLink(
              a,
              `${c.role === "concept" ? "原理" : "实践"} · ${a.title}`,
            ),
            el("small", "", ` · ${statusLabel(a.id)}`),
          );
        else
          li.textContent = `${c.role === "concept" ? "原理" : "实践"} · ${c.title} · 待安排`;
        list.append(li);
      }
      d.append(list);
      view.append(d);
    }
  } else {
    view.append(
      heading(
        "学习记录",
        `${articles.filter((a) => progress.get(a.id)?.status === "completed").length} 篇已读`,
      ),
    );
    const filters = el("div", "learning-filters");
    for (const [key, label] of [
      ["all", "全部"],
      ["reading", "学习中"],
      ["completed", "已读"],
      ["review", "待复习"],
      ["unread", "未开始"],
    ]) {
      const b = el("button", "", label);
      b.type = "button";
      b.setAttribute("aria-pressed", String(filter === key));
      b.onclick = () => {
        filter = key;
        render();
      };
      filters.append(b);
    }
    view.append(filters);
    const rows = el("div", "learning-rows");
    for (const a of articles) {
      const p = progress.get(a.id);
      if (
        filter === "all" ||
        filter === p?.status ||
        (filter === "unread" && !p)
      )
        rows.append(row(a));
    }
    view.append(rows);
    if (!rows.childElementCount)
      view.append(el("p", "learning-empty", "这里还没有学习记录。"));
  }
}
function pendingKey() {
  return `cet-reading:learning-unsynced:${token}`;
}
function persist() {
  const drafts = new Map(inFlight);
  for (const [id, patch] of pending)
    drafts.set(id, { ...drafts.get(id), ...patch });
  try {
    localStorage.setItem(
      pendingKey(),
      JSON.stringify(
        [...drafts].map(([id, patch]) => [
          id,
          {
            patch,
            revision: revisions.get(id) ?? progress.get(id)?.revision ?? 0,
            conflict: conflicts.has(id),
          },
        ]),
      ),
    );
  } catch {
    node("learning-save-status").textContent =
      "本机保存不可用，请保持页面打开直到同步完成。";
  }
}
function restoreDrafts() {
  try {
    for (const [id, draft] of JSON.parse(
      localStorage.getItem(pendingKey()) || "[]",
    )) {
      if (!draft?.patch || !Number.isInteger(draft.revision)) continue;
      pending.set(id, draft.patch);
      revisions.set(id, draft.revision);
      if (draft.conflict) conflicts.add(id);
    }
  } catch {}
  renderConflicts();
}
function renderConflicts() {
  const box = node("learning-conflicts");
  box.replaceChildren();
  box.hidden = !conflicts.size;
  for (const id of conflicts) {
    const item = el("div");
    item.append(
      el(
        "p",
        "",
        `${articles.find((a) => a.id === id)?.title || "学习记录"}：另一台设备更新了记录。请核对后选择要保留的版本。`,
      ),
    );
    const detail = el("details");
    detail.append(el("summary", "", "查看两份记录"));
    const describe = (p: Patch) =>
      `状态：${p.status || "未修改"} · 练习：${p.exerciseDone === undefined ? "未修改" : p.exerciseDone ? "完成" : "未完成"}\n笔记：${p.notes ?? "未修改"}`;
    const remote = progress.get(id);
    detail.append(
      el(
        "pre",
        "",
        `本机待同步：\n${describe(pending.get(id) || {})}\n\n其他设备已保存：\n${describe({ status: remote?.status, exerciseDone: remote?.exercise_done, notes: remote?.notes })}`,
      ),
    );
    item.append(detail);
    const local = el("button", "", "保留本机修改"),
      cloud = el("button", "", "使用已同步版本");
    local.onclick = async () => {
      conflicts.delete(id);
      revisions.set(id, progress.get(id)?.revision || 0);
      persist();
      renderConflicts();
      await flush(id);
      render();
    };
    cloud.onclick = () => {
      conflicts.delete(id);
      pending.delete(id);
      revisions.delete(id);
      persist();
      renderConflicts();
      if (currentId === id) {
        node<HTMLTextAreaElement>("learning-notes").value = remote?.notes || "";
        node<HTMLInputElement>("learning-exercise-done").checked =
          remote?.exercise_done || false;
        node("learning-save-status").textContent = "已采用同步记录";
      }
      render();
    };
    item.append(local, cloud);
    box.append(item);
  }
}
function queue(id: string, patch: Patch) {
  if (!revisions.has(id)) revisions.set(id, progress.get(id)?.revision || 0);
  pending.set(id, { ...pending.get(id), ...patch });
  persist();
  void flush(id);
}
function flush(id: string): Promise<void> {
  const existing = saving.get(id);
  if (existing) return existing;
  if (!profileReady || !pending.has(id) || conflicts.has(id))
    return Promise.resolve();
  const task = (async () => {
    try {
      while (pending.has(id) && !conflicts.has(id)) {
        const patch = pending.get(id)!;
        pending.delete(id);
        inFlight.set(id, patch);
        persist();
        if (currentId === id)
          node("learning-save-status").textContent = "正在保存…";
        try {
          const result = await json(
            `/api/learning/progress/${encodeURIComponent(id)}`,
            {
              method: "PUT",
              body: JSON.stringify({
                ...patch,
                revision: revisions.get(id) ?? progress.get(id)?.revision ?? 0,
              }),
            },
            true,
          );
          progress.set(id, result.progress);
          inFlight.delete(id);
          if (pending.has(id)) revisions.set(id, result.progress.revision);
          else revisions.delete(id);
          persist();
          if (currentId === id)
            node("learning-save-status").textContent =
              "阅读位置与学习记录已保存";
        } catch (error: any) {
          inFlight.delete(id);
          if (error.status === 409 && error.data.current) {
            const current = error.data.current as Progress;
            progress.set(id, current);
            const keys: Record<keyof Patch, keyof Progress> = {
              status: "status",
              sentenceId: "sentence_id",
              blockId: "block_id",
              exerciseDone: "exercise_done",
              notes: "notes",
            };
            // A request may reach the server just before the page closes. Replaying
            // that exact saved patch is already successful, not a device conflict.
            if (
              Object.entries(patch).every(
                ([key, value]) => current[keys[key as keyof Patch]] === value,
              )
            ) {
              if (pending.has(id)) revisions.set(id, current.revision);
              else revisions.delete(id);
              persist();
              if (currentId === id)
                node("learning-save-status").textContent =
                  "阅读位置与学习记录已保存";
              continue;
            }
          }
          pending.set(id, { ...patch, ...pending.get(id) });
          if (error.status === 409) {
            conflicts.add(id);
            node("learning-save-status").textContent =
              "同步有冲突，本机修改已保留，请在页面上方核对。";
            renderConflicts();
          } else
            node("learning-save-status").textContent =
              "暂未同步，已在本机保留，联网后重试。";
          persist();
          break;
        }
      }
    } finally {
      saving.delete(id);
    }
  })();
  saving.set(id, task);
  return task;
}
async function setupProfile() {
  try {
    token = localStorage.getItem(profileKey) || "";
  } catch {}
  try {
    if (!/^[a-f0-9]{64}$/.test(token)) {
      const result = await json("/api/learning/profile", { method: "POST" });
      token = result.token;
      try {
        localStorage.setItem(profileKey, token);
      } catch {
        node("profile-status").textContent =
          "浏览器无法保存档案，请复制同步码以便下次继续。";
      }
    }
    const data = await json("/api/learning/progress", {}, true);
    progress = new Map(data.progress.map((p: Progress) => [p.article_id, p]));
    profileReady = true;
    restoreDrafts();
    for (const id of pending.keys()) void flush(id);
  } catch {
    node("learning-status").textContent =
      "学习进度暂时无法连接；文章仍可阅读，刷新后重试。";
  }
}
const profilePromise = setupProfile();
async function load() {
  try {
    const data = await json("/api/learning/library");
    articles = data.articles;
    curriculum = data.curriculum;
    stages = data.stages;
    libraryReady = true;
    await profilePromise;
    if (profileReady) node("learning-status").textContent = data.run?.status === "failed"
      ? "本次材料更新暂未完成，课程位置已保留。可以继续学习已有内容。"
      : "";
    render();
    renderConflicts();
  } catch {
    node("learning-status").textContent = "学习材料加载失败。";
    view.replaceChildren();
    const b = el("button", "learning-primary", "重试");
    b.onclick = () => void load();
    view.append(b);
  }
}
async function openArticle(id: string, writeHistory = true) {
  clearTimeout(notesTimer);
  if (currentId)
    queue(currentId, {
      notes: node<HTMLTextAreaElement>("learning-notes").value,
    });
  const request = ++requestId;
  await profilePromise;
  try {
    const a = await json(`/api/news/${encodeURIComponent(id)}`);
    if (request !== requestId) return;
    dispose?.();
    currentId = id;
    library.hidden = true;
    reader.hidden = false;
    document.body.classList.add("reader-page");
    if (writeHistory)
      history.pushState({}, "", `?article=${encodeURIComponent(id)}`);
    node("news-title").textContent = a.title;
    node("learning-source").textContent = a.source_name;
    node("learning-lesson").textContent =
      `第 ${Math.ceil(a.learning_order / 2)} 课 · ${a.learning_role === "concept" ? "原理篇" : "实践篇"}`;
    const source = el("a", "", "查看原文 ↗");
    source.href = a.source_url;
    source.target = "_blank";
    source.rel = "noopener noreferrer";
    node("news-meta").replaceChildren(
      document.createTextNode(
        `原文版本 ${new Date(a.published_at).toLocaleDateString("zh-CN")} · `,
      ),
      source,
    );
    node("learning-objective").textContent = a.learning_objective;
    node("learning-prerequisites").textContent =
      `先修：${(a.prerequisites || []).join(" · ")}`;
    node("learning-exercise").textContent = a.learning_exercise;
    const p = progress.get(id);
    node<HTMLTextAreaElement>("learning-notes").value =
      pending.get(id)?.notes ?? inFlight.get(id)?.notes ?? p?.notes ?? "";
    node<HTMLInputElement>("learning-exercise-done").checked =
      pending.get(id)?.exerciseDone ??
      inFlight.get(id)?.exerciseDone ??
      p?.exercise_done ??
      false;
    node("learning-save-status").textContent =
      p?.status === "completed"
        ? "已标记已读 · 阅读位置自动保存"
        : "阅读位置自动保存 · 尚未标记已读";
    const license = el(
      "a",
      "",
      `${a.license_name} · 原文版本 ${a.source_revision?.slice(0, 10) || ""}`,
    );
    license.href = a.license_url;
    license.target = "_blank";
    license.rel = "noopener noreferrer";
    node("news-attribution").replaceChildren(license);
    node("learning-license-text").textContent = a.license_text || "";
    const toc = node("learning-toc");
    toc.replaceChildren();
    toc.hidden = true;
    node("learning-toc-toggle").setAttribute("aria-expanded", "false");
    const blocks: LearningBlock[] = a.sections[0].blocks || [];
    for (const b of blocks.filter((b) => b.type === "heading")) {
      const link = el("a", "", b.text);
      link.href = `#learning-${b.id}`;
      link.onclick = (e) => {
        e.preventDefault();
        document
          .getElementById(`learning-${b.id}`)
          ?.scrollIntoView({ block: "start" });
        toc.hidden = true;
        node("learning-toc-toggle").setAttribute("aria-expanded", "false");
      };
      toc.append(link);
    }
    const target = node("news-content");
    target.replaceChildren();
    let lastBlock = p?.block_id;
    dispose = mountIntensive(a, apiBase, target, {
      analysisPath: `/api/news/${encodeURIComponent(id)}/analyses`,
      hideNavigation: true,
      initialSectionId: `${id}-body`,
      initialSentenceId: p?.sentence_id || undefined,
      initialBlockId: p?.block_id || undefined,
      onPositionChange: (_section, sentenceId) => {
        if (sentenceId) queue(id, { sentenceId });
      },
      onBlockChange: (blockId) => {
        if (lastBlock === blockId) return;
        lastBlock = blockId;
        queue(id, {
          blockId,
          ...(blocks.find((b) => b.id === blockId)?.paragraphIndex === undefined
            ? { sentenceId: null }
            : {}),
        });
      },
    });
    if (!p) queue(id, { status: "reading" });
    node("news-title").focus({ preventScroll: true });
    if (!p?.sentence_id && !p?.block_id)
      window.scrollTo({ top: 0, behavior: "instant" });
  } catch {
    if (request === requestId) {
      showList(false);
      node("learning-status").textContent = "文章暂时无法加载，请重试。";
    }
  }
}
function showList(writeHistory = true) {
  clearTimeout(notesTimer);
  if (currentId)
    queue(currentId, {
      notes: node<HTMLTextAreaElement>("learning-notes").value,
    });
  ++requestId;
  dispose?.();
  dispose = undefined;
  currentId = undefined;
  reader.hidden = true;
  library.hidden = false;
  document.body.classList.remove("reader-page");
  if (writeHistory) history.pushState({}, "", location.pathname);
  render();
}
node("news-back").onclick = () => showList();
node("learning-toc-toggle").onclick = () => {
  const toc = node("learning-toc");
  toc.hidden = !toc.hidden;
  node("learning-toc-toggle").setAttribute(
    "aria-expanded",
    String(!toc.hidden),
  );
};
node("learning-ask").onclick = () => {
  const chat = reader.querySelector<HTMLDetailsElement>(".article-chat");
  if (chat) {
    chat.open = true;
    chat.scrollIntoView({ block: "start" });
    chat
      .querySelector<HTMLTextAreaElement>("textarea")
      ?.focus({ preventScroll: true });
  }
};
node<HTMLInputElement>("learning-search").oninput = (e) => {
  query = (e.target as HTMLInputElement).value.trim().toLowerCase();
  render();
};
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-tab]"))
  b.onclick = () => {
    tab = b.dataset.tab!;
    for (const x of document.querySelectorAll("[data-tab]")) {
      if (x === b) x.setAttribute("aria-current", "page");
      else x.removeAttribute("aria-current");
    }
    render();
  };
node("learning-notes").addEventListener("input", () => {
  clearTimeout(notesTimer);
  const id = currentId;
  if (id) {
    const text = node<HTMLTextAreaElement>("learning-notes").value;
    if (!revisions.has(id)) revisions.set(id, progress.get(id)?.revision || 0);
    pending.set(id, { ...pending.get(id), notes: text });
    persist();
    notesTimer = setTimeout(() => void flush(id), 700);
  }
});
node("learning-exercise-done").addEventListener("change", () => {
  if (currentId)
    queue(currentId, {
      exerciseDone: node<HTMLInputElement>("learning-exercise-done").checked,
    });
});
node("learning-review").onclick = async () => {
  const id = currentId;
  if (id) {
    queue(id, { status: "review" });
    await flush(id);
    if (!pending.has(id) && currentId === id)
      node("learning-save-status").textContent = "已加入待复习";
  }
};
node("learning-complete").onclick = async () => {
  const id = currentId;
  if (!id) return;
  const button = node<HTMLButtonElement>("learning-complete");
  button.disabled = true;
  try {
    queue(id, {
      status: "completed",
      notes: node<HTMLTextAreaElement>("learning-notes").value,
    });
    await flush(id);
    if (pending.has(id) || currentId !== id) return;
    const next = articles.find(
      (a) =>
        a.learning_order >
          (articles.find((x) => x.id === id)?.learning_order || 0) &&
        progress.get(a.id)?.status !== "completed",
    );
    if (next) await openArticle(next.id);
    else {
      showList();
      node("learning-status").textContent =
        "当前材料已读完。下一组会按计划更新，也可以回顾已读文章。";
    }
  } finally {
    button.disabled = false;
  }
};
node("profile-copy").onclick = async () => {
  await profilePromise;
  try {
    await navigator.clipboard.writeText(token);
    node("profile-status").textContent = "同步码已复制，请妥善保存。";
  } catch {
    node<HTMLInputElement>("profile-token").value = token;
    node("profile-status").textContent =
      "已填入同步码，选中输入框内容手动复制。";
  }
};
node("profile-import").onclick = async () => {
  const value = node<HTMLInputElement>("profile-token").value.trim();
  if (!/^[a-f0-9]{64}$/.test(value)) {
    node("profile-status").textContent = "请输入完整的 64 位同步码。";
    return;
  }
  await profilePromise;
  if (saving.size || pending.size) {
    node("profile-status").textContent =
      "当前档案还有未保存的修改，请先完成同步或处理冲突。";
    return;
  }
  try {
    const data = await json("/api/learning/progress", {}, true, value);
    // Recheck after the request in case another UI event queued a write.
    if (saving.size || pending.size) return;
    localStorage.setItem(profileKey, value);
    token = value;
    progress = new Map(data.progress.map((p: Progress) => [p.article_id, p]));
    revisions.clear();
    conflicts.clear();
    profileReady = true;
    restoreDrafts();
    for (const id of pending.keys()) void flush(id);
    node<HTMLInputElement>("profile-token").value = "";
    node("profile-status").textContent = "已连接学习档案。";
    render();
  } catch {
    node("profile-status").textContent = "同步码无效或连接失败，原档案已保留。";
  }
};
window.addEventListener("online", () => {
  for (const id of pending.keys()) void flush(id);
});
window.addEventListener("pagehide", persist);
window.addEventListener("popstate", () => {
  const id = new URL(location.href).searchParams.get("article");
  if (id) void openArticle(id, false);
  else showList(false);
});
void load().then(() => {
  const id = new URL(location.href).searchParams.get("article");
  if (id) void openArticle(id, false);
});
setInterval(() => {
  if (!document.hidden) {
    for (const id of pending.keys()) void flush(id);
    if (!currentId) void load();
  }
}, 60000);
