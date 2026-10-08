import { tokenize } from '@cet-reading/contracts/tokens';
import type { SentenceAnalysis } from '@cet-reading/contracts';
import { createSectionNavigation } from './section-navigation';
import { analysisErrorMessage } from '@cet-reading/contracts/analysis-jobs';
import type { SectionReference } from '@cet-reading/contracts/exam';
import { createSharedSectionNotice } from './section-reference';

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
  reference?: SectionReference;
};
type StudyPaper = {
  id: string;
  content_kind: string;
  sections: StudySection[];
  sentences: StudySentence[];
};
type Selection = { sentence: StudySentence; element: HTMLElement; wordIndex: number | null };
type AnalysisTab = 'translation' | 'structure' | 'pattern' | 'vocabulary';
type AnalysisRequest = { promise: Promise<SentenceAnalysis>; regenerating: boolean; controller: AbortController };
const completed = new Map<string, SentenceAnalysis>();
const requests = new Map<string, AnalysisRequest>();
const roleNames: Record<string, string> = {
  subject: '主语', predicate: '谓语', object: '宾语', complement: '补语', modifier: '修饰语', connector: '连接词',
};

class AnalysisFailure extends Error {}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function waitingDots() {
  const dots = element('span', 'waiting-dots');
  dots.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i += 1) dots.append(element('span', 'waiting-dot'));
  return dots;
}

export function mountIntensive(paper: StudyPaper, apiBase: string, target: HTMLElement) {
  const controller = new AbortController();
  const ownedRequests = new Set<AnalysisRequest>();
  const feedback = new Map<string, string>();
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
  const actions = element('div', 'analysis-actions');
  const regenerate = element('button', 'analysis-regenerate', '重新生成');
  regenerate.type = 'button';
  regenerate.hidden = true;
  regenerate.addEventListener('click', () => {
    if (selected && !requests.has(cacheKey(selected.sentence))) {
      void selectSentence(selected.sentence, selected.element, selected.wordIndex, true);
    }
  });
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
  actions.append(regenerate, close);
  paneHeader.append(paneTitle, actions);
  const notice = element('p', 'analysis-feedback');
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  const paneBody = element('div', 'analysis-body');
  paneBody.setAttribute('aria-live', 'polite');
  pane.append(paneHeader, notice, paneBody);
  layout.append(documentColumn, pane);
  target.append(navigation, layout);

  function showEmpty(message = '点击原文中的单词或句子') {
    paneTitle.textContent = '精读';
    updateActions();
    paneBody.replaceChildren(element('p', 'analysis-empty', message));
  }
  function updateActions() {
    const sentence = selected?.sentence;
    const request = sentence ? requests.get(cacheKey(sentence)) : undefined;
    regenerate.hidden = !sentence || !completed.has(cacheKey(sentence));
    regenerate.disabled = Boolean(request);
    regenerate.replaceChildren(document.createTextNode(request?.regenerating ? '重新生成中' : '重新生成'));
    if (request?.regenerating) regenerate.append(waitingDots());
    const message = sentence ? feedback.get(sentence.id) ?? '' : '';
    notice.textContent = message;
    notice.hidden = !message;
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

  async function jsonRequest(path: string, method: string, signal: AbortSignal) {
    const requestController = new AbortController();
    const cancel = () => requestController.abort(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const timeout = setTimeout(() => requestController.abort(), 15_000);
    try {
      const response = await fetch(`${apiBase}${path}`, { method, signal: requestController.signal });
      if (!response.ok) throw new AnalysisFailure('精读服务暂时不可用，请稍后重试。');
      return await response.json();
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
    }
  }
  function waitForJob(signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const aborted = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, 1500);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
    });
  }
  async function fetchAnalysis(sentence: StudySentence, regenerate: boolean, signal: AbortSignal): Promise<SentenceAnalysis> {
    const path = `/api/sentences/${encodeURIComponent(sentence.id)}/analyze?mode=intensive`;
    let response = await jsonRequest(regenerate ? `${path}&regenerate=true` : path, 'POST', signal);
    // Several sentences can be queued by the same reader; queue time is separate
    // from the worker's three-minute generation and repair deadline.
    const deadline = Date.now() + 600_000;
    while (response.status !== 'ready') {
      if (!response.jobId) throw new AnalysisFailure(analysisErrorMessage('invalid_result'));
      if (Date.now() > deadline) throw new AnalysisFailure('精读仍未完成，请稍后重试。');
      await waitForJob(signal);
      const job = await jsonRequest(`/api/jobs/${encodeURIComponent(response.jobId)}`, 'GET', signal);
      if (job.status === 'failed') throw new AnalysisFailure(analysisErrorMessage(job.errorCode));
      if (selected?.sentence.id === sentence.id && !completed.has(cacheKey(sentence))) {
        const loading = paneBody.querySelector('.analysis-loading-text');
        const message = job.status === 'pending' ? '正在排队，稍候开始' : '正在解析这一句';
        if (loading && loading.textContent !== message) loading.textContent = message;
      }
      if (job.status === 'succeeded') response = await jsonRequest(path, 'POST', signal);
    }
    if (!response.result?.tokens || !response.result?.grammar) throw new AnalysisFailure(analysisErrorMessage('invalid_result'));
    completed.set(cacheKey(sentence), response.result);
    return response.result;
  }
  async function selectSentence(sentence: StudySentence, source: HTMLElement, wordIndex: number | null, regenerate = false) {
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
    const key = cacheKey(sentence);
    let request = requests.get(key);
    if (cached && !regenerate && !request) { renderAnalysis(cached); return; }
    if (!request) {
      feedback.delete(sentence.id);
      const requestController = new AbortController();
      request = {
        regenerating: regenerate,
        controller: requestController,
        promise: fetchAnalysis(sentence, regenerate, requestController.signal).finally(() => {
          requests.delete(key);
          ownedRequests.delete(request!);
        }),
      };
      requests.set(key, request);
      ownedRequests.add(request);
    }
    if (cached) renderAnalysis(cached);
    else {
      const loading = element('p', 'analysis-loading');
      loading.append(element('span', 'analysis-loading-text', '正在解析这一句'), waitingDots());
      loading.setAttribute('role', 'status');
      paneBody.replaceChildren(loading);
    }
    updateActions();
    try {
      const analysis = await request.promise;
      feedback.delete(sentence.id);
      if (!controller.signal.aborted && panelOpen && selected?.sentence.id === sentence.id) renderAnalysis(analysis);
    } catch (error) {
      const failure = error instanceof AnalysisFailure ? error.message : '连接失败，请稍后重试。';
      if (!controller.signal.aborted && cached) feedback.set(sentence.id, `${failure}已保留原结果。`);
      if (controller.signal.aborted || !panelOpen || selected?.sentence.id !== sentence.id) return;
      if (cached) { renderAnalysis(cached); return; }
      const message = element('p', 'analysis-empty', failure);
      const retry = element('button', 'analysis-retry', '重试');
      retry.type = 'button';
      retry.addEventListener('click', () => {
        if (selected) void selectSentence(selected.sentence, selected.element, selected.wordIndex);
      });
      paneBody.replaceChildren(message, retry);
      updateActions();
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
    highlightRanges([{ tokenStart: start, tokenEnd: end }]);
  }
  function highlightRanges(ranges: { tokenStart: number; tokenEnd: number }[]) {
    selected?.element.querySelectorAll('.source-word').forEach(word => {
      const index = Number((word as HTMLElement).dataset.tokenIndex);
      word.classList.toggle('is-structure', ranges.some(range => index >= range.tokenStart && index < range.tokenEnd));
    });
  }
  function renderAnalysis(analysis: SentenceAnalysis) {
    if (!selected) return;
    updateActions();
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
    const tabDefinitions: [AnalysisTab, string][] = [['translation', '翻译'], ['structure', '结构'], ['pattern', '句型'], ['vocabulary', '词汇']];
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
        const count = tabDefinitions.length;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : (index + (event.key === 'ArrowRight' ? 1 : count - 1)) % count;
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
    } else if (activeTab === 'vocabulary') {
      if (!analysis.vocabulary?.length) {
        body.append(element('p', 'analysis-empty', analysis.vocabulary ? '暂无重点词汇' : '重新生成以补充重点单词和词组'));
      } else {
        const list = element('div', 'vocabulary-list');
        for (const item of analysis.vocabulary) {
          const row = element('button', 'vocabulary-item');
          row.type = 'button';
          row.dataset.kind = item.kind;
          row.append(element('strong', 'vocabulary-expression', item.expression),
            element('span', 'vocabulary-meaning', item.meaning),
            element('span', 'vocabulary-usage', item.usage));
          row.addEventListener('click', () => highlightRanges(item.ranges));
          list.append(row);
        }
        body.append(list);
      }
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
    layout.classList.toggle('has-shared-section', Boolean(section.reference));
    if (section.reference) {
      block.append(createSharedSectionNotice(section.reference, 'intensive'));
      documentColumn.replaceChildren(block);
      pane.hidden = true;
      return;
    }
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
        if (section.kind === 'matching') {
          const label = section.paragraphs[paragraphIndex % 100]?.match(/^\[([A-Z])\]/)?.[1];
          if (label) paragraph.append(element('span', 'paragraph-label', `${label} `));
        }
        block.append(paragraph);
      } else paragraph.append(document.createTextNode(' '));
      paragraph.append(renderSentence(sentence));
    }
    documentColumn.replaceChildren(block);
    pane.hidden = !sentences.length;
  }
  const initialSection = paper.sections.find(section => section.kind === 'reading' && !section.reference) ?? paper.sections.find(section => !section.reference) ?? paper.sections[0];
  if (initialSection) selectSection(initialSection.id);
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && panelOpen) dismiss(); };
  document.addEventListener('keydown', escape);
  return () => {
    controller.abort();
    // Regeneration can finish and update its cache while the user changes modes/papers.
    for (const request of ownedRequests) if (!request.regenerating) request.controller.abort();
    document.removeEventListener('keydown', escape);
  };
}
