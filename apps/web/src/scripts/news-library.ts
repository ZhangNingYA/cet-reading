import { mountIntensive } from "./intensive-reader";
import type { LearningBlock } from "@cet-reading/contracts/learning";
const node = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const library = node("news-library"),
  reader = node("news-reader"),
  view = node("learning-view");
const apiBase = library.dataset.apiBase || "";

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
type CurriculumItem = {
  order: number;
  stage: number;
  role: "concept" | "practice" | string;
  repo: string;
  path: string;
  title: string;
  objective?: string;
  prerequisites?: string[];
};
type LibrarySummary = {
  planned: number;
  published: number;
  stageCount: number;
  dailyCount: number;
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
  curriculum: CurriculumItem[] = [],
  summary: LibrarySummary = { planned: 0, published: 0, stageCount: 6, dailyCount: 2 };
let progress = new Map<string, Progress>(),
  selectedCollectionId: string | null = null,
  currentId: string | undefined,
  requestId = 0,
  dispose: (() => void) | undefined;
let libraryReady = false,
  progressReady = false;
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
) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
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
const collectionMeta = (value: { repo?: string; source_name?: string }) => {
  const key = `${value.repo || value.source_name || ""}`.toLowerCase();
  if (key.includes("openai"))
    return {
      id: "openai",
      title: "OpenAI Cookbook",
      description: "OpenAI 官方示例文档集：用可运行的 API 示例学习从一次模型调用到 Agent 工作流。",
      origin: "来自 OpenAI 团队维护的 openai/openai-cookbook 仓库；本站按原仓库材料整理，保留英文原文、代码和上下文。",
      sourceUrl: "https://github.com/openai/openai-cookbook",
      scope: "覆盖 Responses 与 Chat Completions、结构化输出、函数与工具调用、检索、评测和多步 Agent。",
      recommendation: "适合从 Python 或 JavaScript 基础开始，把概念落到 API 请求、错误处理和可运行的小实验上。",
    };
  if (key.includes("anthropic"))
    return {
      id: "anthropic",
      title: "Anthropic Claude Cookbook",
      description: "Anthropic 官方 Claude 示例文档集：从消息调用开始，逐步理解工具、上下文和可靠的 Agent 协作。",
      origin: "来自 Anthropic 团队维护的 anthropics/anthropic-cookbook 仓库；本站按原仓库材料整理，保留英文原文、代码和上下文。",
      sourceUrl: "https://github.com/anthropics/anthropic-cookbook",
      scope: "覆盖 Claude Messages API、工具调用、长上下文、提示设计、多 Agent 协作和生产化模式。",
      recommendation: "适合用另一套成熟的工程视角理解 Agent：重点观察模型如何和工具、上下文及外部系统协作。",
    };
  return {
    id: "other",
    title: value.source_name || value.repo || "技术文档",
    description: "已核验的 Agent 开发技术材料。",
    origin: "来自已核验的官方技术来源。",
    sourceUrl: "",
    scope: "围绕 Agent 开发所需的 API、工具和运行方式整理。",
    recommendation: "作为主线文档的补充阅读。",
  };
};
function pathTitle(path: string) {
  const name = path.split("/").at(-1) || path;
  return name
    .replace(/\.(ipynb|md)$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function courseItem(order: number) {
  return curriculum.find((item) => item.order === order);
}
function articleAt(order: number) {
  return articles.find((article) => article.learning_order === order);
}
function collectionItems(collectionId: string) {
  return curriculum.filter((entry) => collectionMeta(entry).id === collectionId);
}
function collectionNumber(item: CurriculumItem, collectionId: string) {
  const index = collectionItems(collectionId).findIndex((entry) => entry.order === item.order);
  return index >= 0 ? index + 1 : item.order;
}
function itemLabel(item: CurriculumItem, article?: Article) {
  return article?.title || pathTitle(item.path);
}
function roleLabel(role: string) {
  return role === "concept" ? "原理篇" : "实践篇";
}
function totalLessons() {
  return summary.planned || curriculum.length || 24;
}
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
function heading(title: string, detail = "") {
  const h = el("div", "learning-section-heading");
  h.append(el("h2", "", title));
  if (detail) h.append(el("span", "", detail));
  return h;
}
function renderDocumentCard(item: CurriculumItem, documentNumber: number) {
  const article = articleAt(item.order);
  const card = el("li", "learning-document");
  const number = el("span", "learning-document-number", String(documentNumber).padStart(2, "0"));
  const body = el("div", "learning-document-body");
  const meta = el("div", "learning-document-meta");
  meta.append(
    el("span", "", `第 ${item.stage} 阶段`),
    el("span", "", roleLabel(item.role)),
    el("span", "", article ? statusLabel(article.id) : "待发布"),
  );
  const title = article ? articleLink(article, itemLabel(item, article), "learning-document-link") : el("span", "learning-document-link learning-document-link-disabled", itemLabel(item));
  const detail = el("p", "", `${item.title} · ${item.objective || "课程材料待发布"}`);
  body.append(meta, title, detail);
  card.append(number, body);
  return card;
}
function renderDocuments() {
  const groups = new Map<string, { meta: ReturnType<typeof collectionMeta>; items: CurriculumItem[] }>();
  for (const item of curriculum) {
    const meta = collectionMeta(item);
    const group = groups.get(meta.id) || { meta, items: [] };
    group.items.push(item);
    groups.set(meta.id, group);
  }
  view.append(
    heading("文档集", "选择一个官方 Cookbook，先看清楚来源和学习价值，再进入文章目录。"),
  );
  if (!selectedCollectionId) {
    const cards = el("div", "learning-collection-cards");
    for (const group of groups.values()) {
      const published = group.items.filter((item) => articleAt(item.order)).length;
      const complete = group.items.filter((item) => {
        const article = articleAt(item.order);
        return article && progress.get(article.id)?.status === "completed";
      }).length;
      const card = el("button", "learning-collection-card");
      card.type = "button";
      card.append(
        el("span", "learning-book-icon", "▤"),
        el("span", "learning-collection-card-copy"),
        el("span", "learning-collection-card-arrow", "进入 →"),
      );
      const copy = card.querySelector<HTMLElement>(".learning-collection-card-copy")!;
      copy.append(
        el("span", "learning-eyebrow", "文档集"),
        el("strong", "", group.meta.title),
        el("span", "", group.meta.description),
        el("small", "", `${group.items.length} 篇课程 · ${published} 篇已发布 · ${complete} 篇已读`),
      );
      card.onclick = () => {
        selectedCollectionId = group.meta.id;
        render();
      };
      cards.append(card);
    }
    view.append(cards);
    return;
  }
  const group = groups.get(selectedCollectionId);
  if (!group) {
    selectedCollectionId = null;
    renderDocuments();
    return;
  }
  const back = el("button", "learning-back-link", "← 返回文档集");
  back.type = "button";
  back.onclick = () => {
    selectedCollectionId = null;
    render();
  };
  const published = group.items.filter((item) => articleAt(item.order)).length;
  const complete = group.items.filter((item) => {
    const article = articleAt(item.order);
    return article && progress.get(article.id)?.status === "completed";
  }).length;
  const intro = el("section", "learning-collection-intro");
  intro.append(
    el("span", "learning-book-icon learning-book-icon-large", "▤"),
    el("div"),
  );
  const introCopy = intro.querySelector<HTMLElement>("div")!;
  introCopy.append(
    el("p", "learning-eyebrow", "文档集简介"),
    el("h2", "", group.meta.title),
    el("p", "", group.meta.description),
    el("p", "learning-collection-intro-meta", `${group.items.length} 篇课程材料 · ${published} 篇已发布 · ${complete} 篇已读`),
  );
  const details = el("div", "learning-collection-intro-details");
  for (const [label, text] of [["来源", group.meta.origin], ["内容范围", group.meta.scope], ["推荐原因", group.meta.recommendation]] as const) {
    const item = el("div", "learning-collection-intro-detail");
    const copy = el("p", "", text);
    if (label === "来源" && group.meta.sourceUrl) {
      const link = el("a", "learning-collection-source", "打开官方仓库 ↗");
      link.href = group.meta.sourceUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      copy.append(document.createTextNode(" "), link);
    }
    item.append(el("strong", "", label), copy);
    details.append(item);
  }
  introCopy.append(details);
  view.append(back, intro);
  view.append(heading("文章目录", `${published} 篇已发布 · 按基础到实践排列`));
  const list = el("ol", "learning-document-list learning-document-list-expanded");
  group.items.forEach((item, index) => list.append(renderDocumentCard(item, index + 1)));
  view.append(list);
}
function render() {
  if (!libraryReady) return;
  view.replaceChildren();
  view.setAttribute("aria-busy", "false");
  renderDocuments();
}
function pendingKey() {
  return "cet-reading:learning-drafts:single:v1";
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
      "本机保存不可用，请保持页面打开直到保存完成。";
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
        `${articles.find((a) => a.id === id)?.title || "学习记录"}：其他页面更新了记录。请核对后选择要保留的版本。`,
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
        `当前草稿：\n${describe(pending.get(id) || {})}\n\n已保存的记录：\n${describe({ status: remote?.status, exerciseDone: remote?.exercise_done, notes: remote?.notes })}`,
      ),
    );
    item.append(detail);
    const local = el("button", "", "保留本机修改"),
      cloud = el("button", "", "使用已保存版本");
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
        node("learning-save-status").textContent = "已采用保存记录";
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
  if (!progressReady || !pending.has(id) || conflicts.has(id))
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
              "保存有冲突，本机修改已保留，请在页面上方核对。";
            renderConflicts();
          } else
            node("learning-save-status").textContent =
              "暂未保存，已在本机保留，联网后重试。";
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
async function setupProgress() {
  try {
    const data = await json("/api/learning/progress");
    progress = new Map(data.progress.map((p: Progress) => [p.article_id, p]));
    progressReady = true;
    try { localStorage.removeItem("cet-reading:learning-profile:v1"); } catch {}
    restoreDrafts();
    for (const id of pending.keys()) void flush(id);
  } catch {
    node("learning-status").textContent = "学习进度暂时无法连接；文章仍可阅读，刷新后重试。";
  }
}
const progressPromise = setupProgress();
async function load() {
  try {
    const data = await json("/api/learning/library");
    articles = data.articles;
    curriculum = data.curriculum;
    summary = data.summary || summary;
    libraryReady = true;
    await progressPromise;
    if (progressReady) node("learning-status").textContent = data.schedule?.enabled === false
      ? "材料自动更新已暂停，已有内容可以继续学习。"
      : data.run?.status === "failed"
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
function currentPart(blocks: LearningBlock[], blockId?: string | null) {
  const index = blockId ? blocks.findIndex((block) => block.id === blockId) : -1;
  const before = index >= 0 ? blocks.slice(0, index + 1) : blocks;
  const headingBlock = [...before].reverse().find((block) => block.type === "heading");
  return headingBlock?.text || "文档导读";
}
function setCurrentPart(blocks: LearningBlock[], blockId?: string | null) {
  node("learning-current-part").textContent = `当前部分：${currentPart(blocks, blockId)}`;
}
async function openArticle(id: string, writeHistory = true) {
  clearTimeout(notesTimer);
  if (currentId)
    queue(currentId, {
      notes: node<HTMLTextAreaElement>("learning-notes").value,
    });
  const request = ++requestId;
  await progressPromise;
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
    const item = courseItem(a.learning_order);
    const collection = collectionMeta(a);
    const documentNumber = item
      ? collectionNumber(item, collection.id)
      : a.learning_order;
    const collectionTotal = collectionItems(collection.id).length;
    node("news-title").textContent = a.title;
    node("learning-source").textContent = `${collection.title} · 本集第 ${String(documentNumber).padStart(2, "0")} / ${collectionTotal} 篇`;
    node("learning-lesson").textContent =
      `课程第 ${String(a.learning_order).padStart(2, "0")} / ${totalLessons()} 篇 · ${a.lesson_title} · ${roleLabel(a.learning_role)}`;
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
    setCurrentPart(blocks, p?.block_id);
    const tocHeading = el("p", "learning-toc-heading", `文档目录 · ${blocks.filter((block) => block.type === "heading").length} 个部分`);
    toc.append(tocHeading);
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
        setCurrentPart(blocks, blockId);
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
