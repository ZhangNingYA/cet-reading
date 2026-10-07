import { tokenize } from '@cet-reading/contracts/tokens';
import type { SentenceAnalysis } from '@cet-reading/contracts';
import { createSectionNavigation } from './section-navigation';

type StudySentence = {
  id: string;
  sectionId: string;
  source: string;
  paragraphIndex: number;
  sentenceIndex: number;
};
type StudySection = {
  id: string;
  title: string;
  kind: string;
  paragraphs: string[];
  questions: { prompt: string }[];
};
type StudyPaper = {
  id: string;
  content_kind: string;
  sections: StudySection[];
  sentences: StudySentence[];
};
type Selection = { sentence: StudySentence; element: HTMLElement; wordIndex: number | null };
type AnalysisTab = 'translation' | 'structure' | 'pattern';
const completed = new Map<string, SentenceAnalysis>();
const roleNames: Record<string, string> = {
  subject: '主语', predicate: '谓语', object: '宾语', complement: '补语', modifier: '修饰语', connector: '连接词',
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mountIntensive(paper: StudyPaper, apiBase: string, target: HTMLElement) {
  const controller = new AbortController();
  const requests = new Map<string, Promise<SentenceAnalysis>>();
  let selected: Selection | null = null;
  let activeTab: AnalysisTab = 'translation';
  let panelOpen = false;
  const { navigation, selectSection } = createSectionNavigation(paper.sections, showSection, '精读章节');
  const layout = element('div', 'intensive-layout');
  const documentColumn = element('div', 'reading-document');
  const pane = element('aside', 'analysis-pane');
  pane.setAttribute('aria-label', '当前句子精读');
  const paneHeader = element('div', 'analysis-heading');
  const paneTitle = element('h3', 'analysis-title', '精读');
  const close = element('button', 'analysis-close', '收起');
  close.type = 'button';
  close.hidden = true;
  const dismiss = (restoreFocus = true) => {
    const previous = selected;
    selected = null;
    panelOpen = false;
    pane.classList.remove('is-open');
    close.hidden = true;
    clearHighlights();
    showEmpty();
    if (restoreFocus && previous) previous.element.focus({ preventScroll: true });
  };
  close.addEventListener('click', () => dismiss());
  paneHeader.append(paneTitle, close);
  const paneBody = element('div', 'analysis-body');
  paneBody.setAttribute('aria-live', 'polite');
  pane.append(paneHeader, paneBody);
  layout.append(documentColumn, pane);
  target.append(navigation, layout);

  function showEmpty(message = '点击原文中的单词或句子') {
    paneTitle.textContent = '精读';
    paneBody.replaceChildren(element('p', 'analysis-empty', message));
  }
  function clearHighlights() {
    target.querySelectorAll('.is-selected, .is-active-word, .is-structure').forEach(node => {
      node.classList.remove('is-selected', 'is-active-word', 'is-structure');
    });
    target.querySelectorAll('.source-word[aria-pressed="true"]').forEach(node => node.setAttribute('aria-pressed', 'false'));
  }
  function highlightSelection() {
    clearHighlights();
    if (!selected) return;
    selected.element.classList.add('is-selected');
    if (selected.wordIndex !== null) {
      const word = selected.element.querySelector(`[data-token-index="${selected.wordIndex}"]`);
      word?.classList.add('is-active-word');
      word?.setAttribute('aria-pressed', 'true');
    }
  }
  function cacheKey(sentence: StudySentence) { return `${paper.id}:${sentence.id}:${sentence.source}`; }

  async function jsonRequest(path: string, method = 'GET') {
    const response = await fetch(`${apiBase}${path}`, { method, signal: controller.signal });
    if (!response.ok) throw new Error('精读请求失败');
    return response.json();
  }
  function waitForJob() {
    return new Promise<void>((resolve, reject) => {
      const aborted = () => { clearTimeout(timer); reject(controller.signal.reason); };
      const timer = setTimeout(() => { controller.signal.removeEventListener('abort', aborted); resolve(); }, 1500);
      controller.signal.addEventListener('abort', aborted, { once: true });
      if (controller.signal.aborted) aborted();
    });
  }
  async function fetchAnalysis(sentence: StudySentence): Promise<SentenceAnalysis> {
    const path = `/api/sentences/${encodeURIComponent(sentence.id)}/analyze?mode=intensive`;
    let response = await jsonRequest(path, 'POST');
    const deadline = Date.now() + 180_000;
    while (response.status !== 'ready') {
      if (!response.jobId || Date.now() > deadline) throw new Error('生成暂未完成');
      await waitForJob();
      const job = await jsonRequest(`/api/jobs/${encodeURIComponent(response.jobId)}`);
      if (job.status === 'failed') throw new Error('生成失败');
      if (job.status === 'succeeded') response = await jsonRequest(path, 'POST');
    }
    if (!response.result?.tokens || !response.result?.grammar) throw new Error('精读结果不完整');
    completed.set(cacheKey(sentence), response.result);
    return response.result;
  }
  async function selectSentence(sentence: StudySentence, source: HTMLElement, wordIndex: number | null) {
    selected = { sentence, element: source, wordIndex };
    panelOpen = true;
    pane.classList.add('is-open');
    close.hidden = false;
    highlightSelection();
    paneTitle.textContent = `第 ${sentence.sentenceIndex + 1} 句`;
    if (window.matchMedia('(max-width: 850px)').matches) {
      requestAnimationFrame(() => {
        if (!panelOpen || selected?.element !== source) return;
        const bottom = source.getBoundingClientRect().bottom;
        const top = pane.getBoundingClientRect().top;
        if (bottom > top - 20) window.scrollBy({ top: bottom - top + 20, behavior: 'instant' });
      });
    }
    const cached = completed.get(cacheKey(sentence));
    if (cached) { renderAnalysis(cached); return; }
    const loading = element('p', 'analysis-loading', '正在解析这一句…');
    loading.setAttribute('role', 'status');
    paneBody.replaceChildren(loading);
    try {
      let request = requests.get(sentence.id);
      if (!request) {
        request = fetchAnalysis(sentence).finally(() => requests.delete(sentence.id));
        requests.set(sentence.id, request);
      }
      const analysis = await request;
      if (!controller.signal.aborted && panelOpen && selected?.sentence.id === sentence.id) renderAnalysis(analysis);
    } catch {
      if (controller.signal.aborted || !panelOpen || selected?.sentence.id !== sentence.id) return;
      const message = element('p', 'analysis-empty', '暂时无法生成精读，请重试。');
      const retry = element('button', 'analysis-retry', '重试');
      retry.type = 'button';
      retry.addEventListener('click', () => {
        if (selected) void selectSentence(selected.sentence, selected.element, selected.wordIndex);
      });
      paneBody.replaceChildren(message, retry);
    }
  }
  function renderSentence(sentence: StudySentence) {
    const source = element('span', 'source-sentence');
    source.dataset.sentenceId = sentence.id;
    source.tabIndex = 0;
    source.setAttribute('role', 'group');
    source.setAttribute('aria-label', `第 ${sentence.sentenceIndex + 1} 句，按回车查看精读`);
    let offset = 0;
    let unit: HTMLSpanElement | null = null;
    for (const token of tokenize(sentence.source)) {
      if (token.charStart > offset) {
        source.append(document.createTextNode(sentence.source.slice(offset, token.charStart)));
        unit = null;
      }
      // Inline buttons can otherwise wrap separately from their following punctuation.
      if (!unit) { unit = element('span', 'source-unit'); source.append(unit); }
      if (token.kind === 'word') {
        const word = element('button', 'source-word', token.text);
        word.type = 'button';
        word.dataset.tokenIndex = String(token.index);
        word.setAttribute('aria-label', `${token.text}，查看词义`);
        word.setAttribute('aria-pressed', 'false');
        word.addEventListener('click', event => {
          event.stopPropagation();
          void selectSentence(sentence, source, token.index);
        });
        unit.append(word);
      } else unit.append(document.createTextNode(token.text));
      offset = token.charEnd;
    }
    source.append(document.createTextNode(sentence.source.slice(offset)));
    source.addEventListener('click', () => {
      if (!window.getSelection()?.toString()) void selectSentence(sentence, source, null);
    });
    source.addEventListener('keydown', event => {
      if (event.target === source && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        void selectSentence(sentence, source, null);
      }
    });
    return source;
  }
  function highlightRange(start: number, end: number) {
    selected?.element.querySelectorAll('.source-word').forEach(word => {
      const index = Number((word as HTMLElement).dataset.tokenIndex);
      word.classList.toggle('is-structure', index >= start && index < end);
    });
  }
  function renderAnalysis(analysis: SentenceAnalysis) {
    if (!selected) return;
    highlightSelection();
    paneBody.replaceChildren();
    if (selected.wordIndex !== null) {
      const token = analysis.tokens.find(token => token.index === selected?.wordIndex);
      if (token?.kind === 'word') {
        const detail = element('div', 'word-detail');
        const heading = element('div', 'word-heading');
        heading.append(element('strong', 'word-headword', token.text), element('span', 'word-pos', token.pos ?? ''));
        detail.append(heading);
        if (token.lemma && token.lemma.toLowerCase() !== token.text.toLowerCase()) detail.append(element('p', 'word-lemma', `原形 ${token.lemma}`));
        detail.append(element('p', 'word-meaning', token.contextMeaning ?? ''));
        paneBody.append(detail);
      }
    }
    const tabs = element('div', 'analysis-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '句子解析');
    const body = element('div', 'analysis-tab-content');
    body.id = 'sentence-analysis-content';
    body.setAttribute('role', 'tabpanel');
    const tabDefinitions: [AnalysisTab, string][] = [['translation', '翻译'], ['structure', '结构'], ['pattern', '句型']];
    for (const [index, [tab, label]] of tabDefinitions.entries()) {
      const button = element('button', 'analysis-tab', label);
      button.type = 'button';
      button.id = `analysis-tab-${tab}`;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(tab === activeTab));
      button.setAttribute('aria-controls', body.id);
      button.tabIndex = tab === activeTab ? 0 : -1;
      button.addEventListener('click', () => {
        activeTab = tab; renderAnalysis(analysis);
        paneBody.querySelector<HTMLButtonElement>(`#analysis-tab-${activeTab}`)?.focus({ preventScroll: true });
      });
      button.addEventListener('keydown', event => {
        if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
        activeTab = tabDefinitions[next]![0];
        renderAnalysis(analysis);
        paneBody.querySelector<HTMLButtonElement>(`#analysis-tab-${activeTab}`)?.focus();
      });
      tabs.append(button);
    }
    body.setAttribute('aria-labelledby', `analysis-tab-${activeTab}`);
    if (activeTab === 'translation') body.append(element('p', 'sentence-translation', analysis.translation));
    else if (activeTab === 'pattern') {
      body.append(element('p', 'sentence-pattern', analysis.pattern));
      const points = element('ul', 'analysis-key-points');
      for (const point of analysis.keyPoints ?? []) points.append(element('li', '', point));
      body.append(points);
    } else {
      body.append(element('p', 'grammar-summary', [analysis.grammar.sentenceType, analysis.grammar.tense, analysis.grammar.voice].filter(Boolean).join(' · ')));
      const structure = element('div', 'grammar-structure');
      for (const range of [...(analysis.grammar.components ?? []), ...(analysis.grammar.clauses ?? [])]) {
        const label = 'role' in range ? roleNames[range.role] ?? range.role : range.type;
        const row = element('button', 'grammar-component');
        row.type = 'button';
        row.append(element('span', 'component-label', label), element('span', 'component-explanation', range.explanation));
        row.addEventListener('click', () => highlightRange(range.tokenStart, range.tokenEnd));
        structure.append(row);
      }
      body.append(structure);
    }
    paneBody.append(tabs, body);
  }
  function showSection(section: StudySection) {
    dismiss(false);
    const block = element('section', 'passage-section');
    block.dataset.sectionKind = section.kind;
    block.append(element('h3', 'passage-title', section.title));
    const sentences = paper.sentences.filter(sentence => sentence.sectionId === section.id);
    if (section.kind === 'cloze' && paper.content_kind === 'imported') block.append(element('p', 'passage-note', '空格按参考答案补全'));
    if (section.kind === 'writing' && paper.content_kind !== 'imported') block.append(element('p', 'passage-paragraph', section.questions[0]?.prompt ?? ''));
    if (!sentences.length) {
      for (const text of section.paragraphs) block.append(element('p', 'passage-paragraph', text));
      showEmpty('本节保留中文原文');
    }
    let paragraphIndex = -1;
    let paragraph = element('p', 'passage-paragraph');
    for (const sentence of sentences) {
      if (sentence.paragraphIndex !== paragraphIndex) {
        paragraphIndex = sentence.paragraphIndex;
        paragraph = element('p', 'passage-paragraph');
        paragraph.lang = 'en';
        if (section.kind === 'matching') paragraph.append(element('span', 'paragraph-label', `${String.fromCharCode(65 + paragraphIndex % 100)} `));
        block.append(paragraph);
      } else paragraph.append(document.createTextNode(' '));
      paragraph.append(renderSentence(sentence));
    }
    documentColumn.replaceChildren(block);
    pane.hidden = !sentences.length;
  }
  const initialSection = paper.sections.find(section => section.kind === 'reading') ?? paper.sections[0];
  if (initialSection) selectSection(initialSection.id);
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && panelOpen) dismiss(); };
  document.addEventListener('keydown', escape);
  return () => { controller.abort(); document.removeEventListener('keydown', escape); };
}
