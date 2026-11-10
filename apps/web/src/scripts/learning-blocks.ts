import type { LearningBlock } from "@cet-reading/contracts/learning";
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  text?: string,
) {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
export function renderLearningBlock(
  b: LearningBlock,
  apiBase: string,
  sourceUrl: string,
  renderParagraph: (index: number) => HTMLElement,
) {
  let node: HTMLElement;
  if (b.paragraphIndex !== undefined) {
    node = renderParagraph(b.paragraphIndex);
    if (b.type === "quote") node.classList.add("learning-quote");
    if (b.type === "list") node.classList.add("learning-list-item");
  } else if (b.type === "heading") {
    node = el(
      b.level === 1 ? "h2" : b.level === 2 ? "h3" : "h4",
      "learning-heading",
      b.text,
    );
  } else if (b.type === "code") {
    const output = b.language === "output";
    node = el(
      output ? "details" : "div",
      output ? "learning-code learning-output" : "learning-code",
    );
    const bar = el(output ? "summary" : "div", "learning-code-bar");
    bar.append(
      el("span", "", output ? "运行输出 · 点击展开" : b.language || "code"),
    );
    const text = output
      ? b.text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      : b.text;
    const copy = el("button", "", "复制");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = "已复制";
      } catch {
        copy.textContent = "请选中代码复制";
      }
    });
    bar.append(copy);
    const pre = el("pre");
    pre.append(el("code", "", text));
    node.append(bar, pre);
  } else if (b.type === "table") {
    node = el("div", "learning-table-wrap");
    node.tabIndex = 0;
    node.setAttribute("aria-label", "原文表格，可横向滚动");
    const table = el("table");
    for (const [i, row] of (b.rows || []).entries()) {
      const tr = el("tr");
      for (const text of row) tr.append(el(i === 0 ? "th" : "td", "", text));
      table.append(tr);
    }
    node.append(table);
  } else if (b.type === "image") {
    node = el("figure", "learning-image");
    const caption = el("figcaption", "", b.caption || b.alt || "原文配图");
    const fallback = el(
      "a",
      "learning-image-fallback",
      "图片暂不可用，查看原文 ↗",
    );
    fallback.href = sourceUrl;
    fallback.target = "_blank";
    fallback.rel = "noopener noreferrer";
    if (b.src) {
      const button = el("button", "learning-image-button");
      button.type = "button";
      button.setAttribute("aria-label", `放大图片：${b.alt || "原文配图"}`);
      const image = el("img");
      image.src = `${apiBase}${b.src}`;
      image.alt = b.alt || "原文配图";
      image.loading = "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => {
        button.hidden = true;
        fallback.hidden = false;
      });
      fallback.hidden = true;
      button.append(image);
      button.addEventListener("click", () => {
        const dialog = el("dialog", "learning-lightbox");
        const close = el("button", "", "关闭 ×");
        close.type = "button";
        const enlarged = el("img");
        enlarged.src = image.src;
        enlarged.alt = image.alt;
        close.onclick = () => dialog.close();
        dialog.append(close, enlarged, el("p", "", caption.textContent || ""));
        document.body.append(dialog);
        dialog.addEventListener("click", (e) => {
          if (e.target === dialog) dialog.close();
        });
        dialog.addEventListener(
          "close",
          () => {
            dialog.remove();
            button.focus();
          },
          { once: true },
        );
        dialog.showModal();
      });
      node.append(button);
    }
    node.append(fallback, caption);
  } else node = el("p", "passage-paragraph", b.text);
  node.id = `learning-${b.id}`;
  node.dataset.learningBlock = b.id;
  if (b.links?.length) {
    const refs = el("span", "learning-block-links");
    for (const link of b.links) {
      try {
        const u = new URL(link.url);
        if (u.protocol !== "https:") continue;
      } catch {
        continue;
      }
      const a = el("a", "", `${link.text} ↗`);
      a.href = link.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      refs.append(a);
    }
    node.append(refs);
  }
  return node;
}
