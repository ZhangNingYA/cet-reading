import { homeSections } from '../data/sections';

const home = document.querySelector<HTMLElement>('[data-home]');
const apiBase = home?.dataset.apiBase ?? '';

async function json(path: string) {
  const response = await fetch(`${apiBase}${path}`, { signal: AbortSignal.timeout(8_000), cache: 'no-store' });
  if (!response.ok) throw new Error('Home content unavailable');
  return response.json();
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text: string) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

type Paper = { exam_level: string; year: number; content_state: string; content_kind: string; has_content: boolean };
type Article = { id: string; title: string; source_name: string; published_at: string };

async function loadPapers() {
  try {
    const { papers } = await json('/api/papers');
    if (!Array.isArray(papers)) return;
    for (const section of homeSections.filter(section => section.slug !== 'news')) {
      const available: Paper[] = papers.filter((paper: Paper) => section.examLevels.includes(paper.exam_level)
        && paper.content_kind === 'imported' && paper.content_state === 'local' && paper.has_content);
      const note = home?.querySelector<HTMLElement>(`[data-board-note="${section.slug}"]`);
      if (!note || !available.length) continue;
      const years = available.map(paper => paper.year).filter(Number.isFinite);
      note.textContent = `${available.length} 套真题${years.length ? ` · ${Math.min(...years)}–${Math.max(...years)}` : ''}`;
    }
  } catch { return; }
}

async function loadNews() {
  try {
    const { articles } = await json('/api/news');
    if (!Array.isArray(articles)) return;
    const latest: Article[] = articles.filter((article: Article) => typeof article.id === 'string' && typeof article.title === 'string').slice(0, 2);
    const list = home?.querySelector<HTMLElement>('[data-home-news]');
    if (list && latest.length) {
      const links = latest.map(article => {
        const link = element('a', 'home-news-item', '');
        link.href = `/news/?article=${encodeURIComponent(article.id)}`;
        const meta = element('div', 'home-news-meta', '');
        meta.append(element('span', '', article.source_name));
        const date = new Date(article.published_at);
        if (Number.isFinite(date.valueOf())) {
          const time = element('time', '', date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' }));
          time.dateTime = article.published_at;
          meta.append(time);
        }
        const title = element('h3', '', article.title);
        title.lang = 'en';
        link.append(meta, title);
        return link;
      });
      list.replaceChildren(...links);
    }
  } catch { return; }
}

if (home) {
  void loadPapers();
  void loadNews();
}
