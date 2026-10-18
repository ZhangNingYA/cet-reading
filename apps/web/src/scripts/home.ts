import { homeSections } from '../data/sections';
import type { ReadingProgress } from './reading-progress';

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

type Paper = { id: string; title: string; exam_level: string; year: number; content_state: string; content_kind: string; has_content: boolean };
type Article = { id: string; title: string; source_name: string; published_at: string; topic: string; word_count: number };

async function loadPapers(): Promise<Paper[] | null> {
  try {
    const { papers } = await json('/api/papers');
    if (!Array.isArray(papers)) return null;
    for (const section of homeSections.filter(section => section.slug !== 'news')) {
      const available: Paper[] = papers.filter((paper: Paper) => section.examLevels.includes(paper.exam_level)
        && paper.content_kind === 'imported' && paper.content_state === 'local' && paper.has_content);
      const note = home?.querySelector<HTMLElement>(`[data-board-note="${section.slug}"]`);
      if (!note || !available.length) continue;
      const years = available.map(paper => paper.year).filter(Number.isFinite);
      note.textContent = `${available.length} 套真题${years.length ? ` · ${Math.min(...years)}–${Math.max(...years)}` : ''}`;
    }
    return papers;
  } catch { return null; }
}

async function loadNews(): Promise<Article[]> {
  try {
    const { articles } = await json('/api/news');
    if (!Array.isArray(articles)) return [];
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
        if (article.word_count > 0) meta.append(element('span', '', `${article.word_count.toLocaleString('zh-CN')} 词`));
        const title = element('h3', '', article.title);
        title.lang = 'en';
        link.append(meta, title);
        if (article.topic) link.append(element('p', 'home-news-topic', article.topic));
        return link;
      });
      list.replaceChildren(...links);
    }
    return articles;
  } catch { return []; }
}

function localProgress(board: string): ReadingProgress | null {
  try {
    const value = JSON.parse(localStorage.getItem(`cet-reading:last-position:${board}`) || 'null');
    const itemId = value?.itemId ?? value?.paperId;
    return typeof itemId === 'string' && ['intensive', 'practice'].includes(value?.mode) ? { ...value, itemId } : null;
  } catch { return null; }
}

async function loadProgress(board: string) {
  try {
    const result = await json(`/api/reading-progress/${board}`);
    return result?.progress ?? localProgress(board);
  } catch { return localProgress(board); }
}

function timestamp(progress: ReadingProgress) {
  const time = new Date(progress.updatedAt ?? 0).valueOf();
  return Number.isFinite(time) ? time : 0;
}

async function loadResume(papersPromise: Promise<Paper[] | null>, newsPromise: Promise<Article[]>) {
  const positions = await Promise.all(homeSections.map(async section => ({ section, progress: await loadProgress(section.slug) as ReadingProgress | null })));
  const [papers, articles] = await Promise.all([papersPromise, newsPromise]);
  const candidates = positions.filter((entry): entry is typeof entry & { progress: ReadingProgress } =>
    typeof entry.progress?.itemId === 'string' && ['intensive', 'practice'].includes(entry.progress.mode))
    .sort((a, b) => timestamp(b.progress) - timestamp(a.progress));
  const resume = home?.querySelector<HTMLAnchorElement>('[data-home-resume]');
  if (!resume) return;
  for (const { section, progress } of candidates) {
    const item = section.slug === 'news' ? articles.find(article => article.id === progress.itemId)
      : papers?.find(paper => paper.id === progress.itemId && paper.content_state === 'local');
    // An older news article can be outside the first page; its reader resolves the ID.
    if (section.slug !== 'news' && papers && !item) continue;
    const query = new URLSearchParams(section.slug === 'news' ? { article: progress.itemId } : { paper: progress.itemId, mode: progress.mode });
    resume.href = `/${section.slug}/?${query}`;
    resume.querySelector<HTMLElement>('[data-resume-title]')!.textContent = item?.title
      ?? (section.slug === 'news' ? '继续上次的英文文章' : `${section.label} · 上次的试卷`);
    const detail = [section.label, progress.mode === 'practice' ? '做题模式' : '精读模式', progress.sectionTitle];
    if (progress.sentenceNumber) detail.push(`第 ${progress.sentenceNumber} 句`);
    resume.querySelector<HTMLElement>('[data-resume-detail]')!.textContent = detail.filter(Boolean).join(' · ');
    resume.hidden = false;
    break;
  }
}

if (home) {
  const words = home.querySelectorAll<HTMLButtonElement>('.home-sample-word');
  words.forEach(word => word.addEventListener('click', () => {
    words.forEach(button => button.setAttribute('aria-pressed', String(button === word)));
    for (const field of ['word', 'pos', 'meaning', 'note'] as const) {
      const output = home.querySelector<HTMLElement>(`[data-sample-${field}]`);
      if (output) output.textContent = word.dataset[field] ?? '';
    }
  }));
  const papers = loadPapers();
  const news = loadNews();
  void loadResume(papers, news);
}
