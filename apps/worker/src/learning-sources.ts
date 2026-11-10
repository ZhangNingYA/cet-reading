import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { load } from "cheerio";
import { marked, type Token } from "marked";
import type {
  LearningArticle,
  LearningBlock,
  LearningEntry,
} from "@cet-reading/contracts/learning";

export const learningRepos = [
  "anthropics/claude-cookbooks",
  "openai/openai-cookbook",
] as const;
export const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function learningCatalog(): LearningEntry[] {
  return JSON.parse(
    readFileSync(
      new URL("../../../data/news/learning-catalog.json", import.meta.url),
      "utf8",
    ),
  );
}
export async function sourceFetch(
  url: string,
  limit = 8_000_000,
): Promise<string> {
  const u = new URL(url);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    !["api.github.com", "raw.githubusercontent.com"].includes(u.hostname)
  )
    throw new Error("Unapproved learning source");
  const prefix = u.hostname === "api.github.com" ? "/repos/" : "/";
  if (!learningRepos.some((repo) => u.pathname.startsWith(prefix + repo + "/")))
    throw new Error("Unapproved learning repository");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(u, {
        redirect: "error",
        signal: AbortSignal.timeout(20000),
        headers: {
          "user-agent": "CET-Reading-Learning/1.0",
          accept:
            u.hostname === "api.github.com"
              ? "application/vnd.github+json"
              : "text/plain",
        },
      });
      if (!r.ok) {
        await r.body?.cancel();
        throw Object.assign(new Error(`Learning source HTTP ${r.status}`), {
          retryable: r.status === 429 || r.status >= 500,
        });
      }
      if (!r.body)
        throw Object.assign(new Error("Empty learning source"), {
          retryable: false,
        });
      const reader = r.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > limit)
            throw Object.assign(new Error("Learning source too large"), {
              retryable: false,
            });
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return Buffer.concat(chunks).toString("utf8");
    } catch (error) {
      if (
        attempt === 2 ||
        (error as { retryable?: boolean }).retryable === false
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw new Error("Learning source unavailable");
}
const plain = (value: string) => load(value).text().replace(/\s+/g, " ").trim();
function inline(tokens: any[] | undefined, fallback = ""): string {
  if (!tokens) return plain(fallback);
  return tokens
    .map((t) =>
      t.type === "image"
        ? t.text
        : t.tokens
          ? inline(t.tokens)
          : (t.text ?? t.raw ?? ""),
    )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}
function safeLink(value: string, base: string) {
  try {
    const u = new URL(value, base);
    return u.protocol === "https:" && !u.username && !u.password
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function imageSource(
  src: string,
  repo: string,
  path: string,
  revision: string,
): string | undefined {
  if (
    /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(src) &&
    src.length < 4_000_000
  )
    return src;
  try {
    let url: URL;
    if (!/^[a-z]+:/i.test(src)) {
      const target = posix.normalize(posix.join(posix.dirname(path), src));
      if (target.startsWith("../") || target.startsWith("/")) return;
      url = new URL(
        `https://raw.githubusercontent.com/${repo}/${revision}/${target}`,
      );
    } else {
      url = new URL(src);
      if (url.hostname === "github.com")
        url = new URL(
          url.href
            .replace("github.com/", "raw.githubusercontent.com/")
            .replace("/blob/", "/")
            .replace("/raw/", "/"),
        );
      for (const branch of ["main", "master"])
        url.pathname = url.pathname.replace(
          `/${repo}/${branch}/`,
          `/${repo}/${revision}/`,
        );
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "raw.githubusercontent.com" ||
      !url.pathname.startsWith(`/${repo}/${revision}/`) ||
      url.username ||
      url.password ||
      url.port
    )
      return;
    if (
      !/\.(png|jpe?g|gif|webp|svg)$/i.test(url.pathname) ||
      /(badge|logo|shield|tracking)/i.test(url.pathname)
    )
      return;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return;
  }
}
export function parseLearningDocument(
  raw: string,
  entry: Pick<LearningEntry, "repo" | "path">,
  revision: string,
): { title: string; blocks: LearningBlock[]; paragraphs: string[] } {
  const blocks: LearningBlock[] = [];
  const paragraphs: string[] = [];
  const base = `https://github.com/${entry.repo}/blob/${revision}/${entry.path}`;
  const add = (value: Omit<LearningBlock, "id">) => {
    if (!value.text && value.type !== "image" && value.type !== "table") return;
    const b: LearningBlock = { id: `b${blocks.length + 1}`, ...value };
    if (["paragraph", "quote", "list"].includes(b.type) && b.text) {
      b.paragraphIndex = paragraphs.length;
      paragraphs.push(b.text);
    }
    blocks.push(b);
  };
  const addImage = (
    src: string,
    alt: string,
    attachments: Record<string, any> = {},
  ) => {
    if (src.startsWith("attachment:")) {
      const data = attachments[src.slice(11)];
      const mime =
        data &&
        Object.keys(data).find((x) => /^image\/(png|jpeg|webp)$/.test(x));
      if (mime) src = `data:${mime};base64,${data[mime]}`;
    }
    const allowed = imageSource(src, entry.repo, entry.path, revision);
    add({
      type: "image",
      text: "",
      ...(allowed ? { src: allowed } : {}),
      alt: alt || "原文配图",
      caption: allowed
        ? alt || "原文配图"
        : "此图请在原文查看（未核验独立图片许可）",
    });
  };
  const links = (tokens: any[]): { text: string; url: string }[] =>
    tokens.flatMap((t) => {
      const u = t.type === "link" ? safeLink(t.href, base) : undefined;
      return [
        ...(u ? [{ text: inline(t.tokens, t.text), url: u }] : []),
        ...(t.tokens ? links(t.tokens) : []),
      ];
    });
  const walk = (tokens: Token[], attachments: Record<string, any> = {}) => {
    for (const t of tokens) {
      if (t.type === "heading")
        add({
          type: "heading",
          text: inline(t.tokens, t.text),
          level: t.depth,
        });
      else if (t.type === "code")
        add({
          type: "code",
          text: t.text,
          language: t.lang?.split(/\s/)[0] || "text",
        });
      else if (t.type === "table")
        add({
          type: "table",
          text: "",
          rows: [
            t.header.map((c: any) => inline(c.tokens, c.text)),
            ...t.rows.map((r: any[]) =>
              r.map((c: any) => inline(c.tokens, c.text)),
            ),
          ],
        });
      else if (t.type === "list") {
        for (const [i, item] of t.items.entries()) {
          for (const child of item.tokens) {
            if (child.type === "text")
              add({
                type: "list",
                text: `${t.ordered ? `${i + 1}.` : "•"} ${inline(child.tokens, child.text)}`,
              });
            else walk([child], attachments);
          }
        }
      } else if (t.type === "blockquote") {
        const prior = blocks.length;
        walk(t.tokens || [], attachments);
        for (const b of blocks.slice(prior))
          if (b.type === "paragraph") b.type = "quote";
      } else if (t.type === "html") {
        const $ = load(t.text);
        $("script,style,iframe,form").remove();
        $("img").each((_, el) =>
          addImage(
            $(el).attr("src") || "",
            $(el).attr("alt") || "",
            attachments,
          ),
        );
        $("pre").each((_, el) => {
          add({ type: "code", text: $(el).text(), language: "text" });
          $(el).remove();
        });
        const text = $.text().trim();
        if (text) add({ type: "paragraph", text: plain(text) });
      } else if (t.type === "paragraph" || t.type === "text") {
        const ts = t.tokens || [];
        let group: any[] = [];
        const flush = () => {
          const text = inline(group);
          if (text) add({ type: "paragraph", text, links: links(group) });
          group = [];
        };
        for (const child of ts) {
          if (child.type === "image") {
            flush();
            addImage(child.href, child.text, attachments);
          } else group.push(child);
        }
        flush();
        if (!ts.length && t.text)
          add({ type: "paragraph", text: plain(t.text) });
      }
    }
  };
  if (entry.path.endsWith(".ipynb")) {
    const nb = JSON.parse(raw);
    if (!Array.isArray(nb.cells)) throw new Error("Notebook has no cells");
    for (const cell of nb.cells) {
      const content = Array.isArray(cell.source)
        ? cell.source.join("")
        : String(cell.source || "");
      if (cell.cell_type === "markdown")
        walk(marked.lexer(content), cell.attachments || {});
      else if (cell.cell_type === "code") {
        add({
          type: "code",
          text: content,
          language: nb.metadata?.kernelspec?.language || "python",
        });
        for (const out of cell.outputs || []) {
          const image =
            out.data &&
            Object.keys(out.data).find((x) =>
              /^image\/(png|jpeg|webp)$/.test(x),
            );
          if (image)
            addImage(
              `data:${image};base64,${Array.isArray(out.data[image]) ? out.data[image].join("") : out.data[image]}`,
              "原文运行结果",
            );
          else {
            const result = out.text || out.data?.["text/plain"];
            if (result)
              add({
                type: "code",
                text: Array.isArray(result) ? result.join("") : String(result),
                language: "output",
              });
          }
        }
      }
    }
  } else walk(marked.lexer(raw));
  const heading = blocks.find((b) => b.type === "heading")?.text;
  const title =
    heading && !/^(overview|introduction|getting started)$/i.test(heading)
      ? heading
      : posix
          .basename(entry.path)
          .replace(/\.(md|ipynb)$/, "")
          .replaceAll("_", " ");
  if (paragraphs.join(" ").length < 350 || blocks.length < 4)
    throw new Error("Technical material has too little explanatory text");
  return { title, blocks, paragraphs };
}
export async function readLearningArticle(
  entry: Pick<LearningEntry, "key" | "repo" | "path">,
): Promise<LearningArticle> {
  if (!learningRepos.includes(entry.repo))
    throw new Error("Unknown repository");
  const commits = JSON.parse(
    await sourceFetch(
      `https://api.github.com/repos/${entry.repo}/commits?path=${encodeURIComponent(entry.path)}&per_page=1`,
    ),
  );
  const revision = commits[0]?.sha;
  const updatedAt = commits[0]?.commit?.committer?.date;
  if (!/^[a-f0-9]{40}$/.test(revision) || !updatedAt)
    throw new Error("Cannot verify source revision");
  const rawUrl = `https://raw.githubusercontent.com/${entry.repo}/${revision}/${entry.path}`;
  const [raw, licenseText] = await Promise.all([
    sourceFetch(rawUrl),
    sourceFetch(
      `https://raw.githubusercontent.com/${entry.repo}/${revision}/LICENSE`,
      100000,
    ),
  ]);
  if (
    !licenseText.includes("MIT License") ||
    !licenseText.includes("associated documentation files") ||
    !licenseText.includes("Copyright")
  )
    throw new Error("Source documentation permission is not verified");
  const parsed = parseLearningDocument(raw, entry, revision);
  return {
    key: entry.key,
    ...parsed,
    sourceName: entry.repo.startsWith("openai/")
      ? "OpenAI Cookbook"
      : "Anthropic Cookbook",
    sourceUrl: `https://github.com/${entry.repo}/blob/main/${entry.path}`,
    rawUrl,
    revision,
    updatedAt,
    fetchedAt: new Date().toISOString(),
    licenseText,
    licenseUrl: `https://github.com/${entry.repo}/blob/${revision}/LICENSE`,
    contentHash: hash(JSON.stringify(parsed.blocks)),
    wordCount:
      parsed.paragraphs.join(" ").match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)
        ?.length || 0,
  };
}
export async function discoverLearningSources() {
  const found: {
    key: string;
    repo: (typeof learningRepos)[number];
    path: string;
  }[] = [];
  for (const repo of learningRepos) {
    const data = JSON.parse(
      await sourceFetch(
        `https://api.github.com/repos/${repo}/git/trees/main?recursive=1`,
      ),
    );
    if (data.truncated)
      throw new Error("Repository discovery tree is incomplete");
    for (const item of data.tree || []) {
      const p = String(item.path);
      if (
        item.type !== "blob" ||
        !p.endsWith(".ipynb") ||
        /(third_party|partners|example_data|data\/|fixtures|pre_repair|migration|migrating)/i.test(
          p,
        )
      )
        continue;
      if (
        !/^(patterns\/agents|tool_use|claude_agent_sdk|managed_agents|misc|tool_evaluation|capabilities\/retrieval|examples\/agents_sdk|examples\/agent_optimization|examples\/reasoning_function_calls)/.test(
          p,
        )
      )
        continue;
      found.push({ key: `${repo}:${p}`, repo, path: p });
    }
  }
  return found;
}
