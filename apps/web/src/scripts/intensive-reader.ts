import { hasWordTokens, tokenize } from '@cet-reading/contracts/tokens';
import type { QuestionAnalysis, SentenceAnalysis } from '@cet-reading/contracts';
import { createSectionNavigation } from './section-navigation';
import { analysisErrorMessage } from '@cet-reading/contracts/analysis-jobs';
import type { SectionReference } from '@cet-reading/contracts/exam';
import { createSharedSectionNotice } from './section-reference';
import { appendSectionImages } from './section-material';
import { createReaderToolbar } from './reader-toolbar';
import { createArticleChat } from './article-chat';

type StudySentence = {
  id: string;
  sectionId: string;
  source: string;
  paragraphIndex: number;
  sentenceIndex: number;
  label?: string;
};
type StudySection = {
  id: string;
  title: string;
  kind: string;
  instructions?: string;
  paragraphs: string[];
  questions: { id: string; prompt: string; options: { key: string; text: string }[] }[];
  reference?: SectionReference;
  images?: { src: string; alt: string }[];
};
type StudyPaper = {
  id: string;
  content_kind: string;
  exam_level: string;
  sections: StudySection[];
  sentences: StudySentence[];
};
type Selection = { sentence: StudySentence; element: HTMLElement; wordIndex: number | null };
type AnalysisTab = 'translation' | 'structure' | 'pattern' | 'vocabulary';
const analysisTabs: [AnalysisTab, string][] = [['translation', '翻译'], ['structure', '结构'], ['pattern', '句型'], ['vocabulary', '词汇']];
type AnalysisRequest = { promise: Promise<SentenceAnalysis>; regenerating: boolean; controller: AbortController };
type QuestionTextReference = { questionId: string; textKey: string };
const completed = new Map<string, SentenceAnalysis>();
const requests = new Map<string, AnalysisRequest>();
const questionTextReferences = new Map<string, QuestionTextReference>();
const questionAnalyses = new Map<string, QuestionAnalysis>();
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

export function mountIntensive(paper: StudyPaper, apiBase: string, target: HTMLElement, options: {
  analysisPath?: string;
  hideNavigation?: boolean;
  initialSectionId?: string;
  initialSentenceId?: string;
  onPositionChange?: (sectionId: string, sentenceId?: string) => void;
} = {}) {
  const controller = new AbortController();
  const ownedRequests = new Set<AnalysisRequest>();
  const feedback = new Map<string, string>();
  const prefetchedSections = new Set<string>();
  const renderedSentences = new Map<string, Selection>();
  let selected: Selection | null = null;
  let lastSelection: Selection | null = null;
  let activeTab: AnalysisTab = 'translation';
  let panelOpen = false;
  let activeSentences: StudySentence[] = [];
  let positionTimer: ReturnType<typeof setTimeout> | undefined;
  let restoringPosition = false;
  let lastReadSentenceId = options.initialSentenceId;
  let currentSectionId: string | null = null;
  let scrollFrame = 0;
  let revealFrame = 0;
  let revealScrollY: number | null = null;
  let keepPanePosition = false;
  let lastShortcutTime = 0;
  let disposeChat: (() => void) | undefined;
  let splitParagraph: { original: HTMLParagraphElement; continuation: HTMLParagraphElement | null } | null = null;
  const { navigation, selectSection } = createSectionNavigation(paper.sections, showSection, '精读章节', paper.exam_level);
  const layout = element('div', 'intensive-layout');
  const documentColumn = element('div', 'reading-document');
  const pane = element('aside', 'analysis-pane');
  pane.setAttribute('aria-label', '当前句子精读');
  pane.hidden = true;
  const paneHeader = element('div', 'analysis-heading');
  const context = element('div', 'analysis-context');
  const paneTitle = element('h3', 'analysis-title', '精读');
  const wordDetail = element('div', 'word-detail');
  wordDetail.hidden = true;
  wordDetail.setAttribute('aria-live', 'polite');
  context.append(paneTitle, wordDetail);
  const actions = element('div', 'analysis-actions');
  const regenerate = element('button', 'analysis-regenerate', '重新生成');
  regenerate.type = 'button';
  regenerate.hidden = true;
  regenerate.addEventListener('click', () => {
    if (selected && !requests.has(cacheKey(selected.sentence))) {
      void selectSentence(selected.sentence, selected.element, selected.wordIndex, true);
    }
  });
  const next = element('button', 'analysis-next', '下一句');
  next.type = 'button';
  next.title = '下一句（D 键）';
  next.setAttribute('aria-keyshortcuts', 'D');
  next.addEventListener('click', () => {
    moveSentence(1, true);
  });
  const close = element('button', 'analysis-close', '收起');
  close.type = 'button';
  close.title = '收起精读（空格）';
  close.setAttribute('aria-keyshortcuts', 'Space');
  close.hidden = true;
  const dismiss = (restoreFocus = true) => {
    const previous = selected;
    selected = null;
    panelOpen = false;
    pane.classList.remove('is-open');
    pane.hidden = true;
    layout.append(pane);
    restoreParagraph();
    cancelAnimationFrame(revealFrame);
    revealScrollY = null;
    keepPanePosition = false;
    layout.classList.remove('keeps-analysis-position');
    layout.style.paddingBottom = '';
    close.hidden = true;
    clearHighlights();
    paneTitle.textContent = '精读';
    paneTitle.hidden = false;
    wordDetail.hidden = true;
    wordDetail.replaceChildren();
    paneBody.replaceChildren();
    paneBody.setAttribute('aria-busy', 'false');
    updateActions();
    if (restoreFocus && previous) {
      previous.element.focus({ preventScroll: true });
      const bounds = previous.element.getBoundingClientRect();
      const topbar = target.closest('.reader-section')?.querySelector('.reader-topline');
      const inset = Math.max(80, (topbar?.getBoundingClientRect().bottom ?? 60) + 16);
      if (bounds.top < inset || bounds.top > window.innerHeight - 40) {
        window.scrollBy({ top: bounds.top - inset, behavior: 'instant' });
      }
    }
    updateProgress();
  };
  close.addEventListener('click', () => dismiss());
  actions.append(next, close);
  paneHeader.append(context, actions);
  const notice = element('p', 'analysis-feedback');
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  const paneBody = element('div', 'analysis-body');
  paneBody.setAttribute('aria-live', 'polite');
  paneBody.setAttribute('aria-busy', 'false');
  const paneFooter = element('div', 'analysis-footer');
  const shortcuts = element('p', 'analysis-shortcuts');
  for (const [key, label] of [['A', '上一句'], ['D', '下一句'], ['W / S', '切换解析'], ['空格', '展开 / 收起'], ['Q', '回到顶部'], ['E', '回到底部']]) {
    const hint = element('span', '');
    hint.append(element('kbd', '', key), document.createTextNode(` ${label}`));
    shortcuts.append(hint);
  }
  paneFooter.append(shortcuts, regenerate);
  pane.append(paneHeader, notice, paneBody, paneFooter);
  layout.append(documentColumn, pane);
  const toolbar = createReaderToolbar(target);
  const progress = element('progress', 'reading-progress');
  progress.max = 100;
  progress.value = 0;
  progress.setAttribute('aria-label', '正文阅读进度');
  target.append(progress);
  if (!options.hideNavigation) target.append(navigation);
  target.append(layout);

  function adjacentSentence(direction: -1 | 1) {
    if (!selected) return null;
    const index = activeSentences.findIndex(sentence => sentence.id === selected?.sentence.id);
    if (index < 0) return null;
    for (let nextIndex = index + direction; nextIndex >= 0 && nextIndex < activeSentences.length; nextIndex += direction) {
      const candidate = renderedSentences.get(activeSentences[nextIndex]!.id);
      if (candidate) return candidate;
    }
    return null;
  }
  function moveSentence(direction: -1 | 1, focusNext = false) {
    const adjacent = adjacentSentence(direction);
    if (!focusNext && document.activeElement instanceof HTMLElement && target.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    if (!adjacent) return;
    preservePanePosition(() => {
      void selectSentence(adjacent.sentence, adjacent.element, null, false, true);
    });
    if (focusNext) (next.disabled ? adjacent.element : next).focus({ preventScroll: true });
  }
  function updateActions() {
    const sentence = selected?.sentence;
    const request = sentence ? requests.get(cacheKey(sentence)) : undefined;
    next.hidden = !sentence || questionTextReferences.has(sentence.id);
    next.disabled = !adjacentSentence(1);
    next.textContent = next.disabled ? '已到末句' : '下一句';
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
    target.querySelector('.is-resume-point')?.classList.remove('is-resume-point');
    selected.element.classList.add('is-selected');
    if (selected.wordIndex !== null) {
      const word = selected.element.querySelector(`[data-token-index="${selected.wordIndex}"]`);
      word?.classList.add('is-active-word');
      word?.setAttribute('aria-pressed', 'true');
    }
  }
  function cacheKey(sentence: StudySentence) { return `${paper.id}:${sentence.id}:${sentence.source}`; }

  function preservePanePosition(update: () => void) {
    const bounds = pane.getBoundingClientRect();
    // If the reader scrolls past a pending result, preserve what they are reading.
    const anchor = bounds.bottom > 0 && bounds.top < window.innerHeight ? pane
      : [...documentColumn.querySelectorAll<HTMLElement>('.source-word')].find(word => {
        const bounds = word.getBoundingClientRect();
        return bounds.top >= 80 && bounds.top < window.innerHeight;
      }) ?? pane;
    const top = anchor.getBoundingClientRect().top;
    layout.style.paddingBottom = '';
    update();
    const scrollTop = window.scrollY + anchor.getBoundingClientRect().top - top;
    const maxScroll = document.documentElement.scrollHeight - document.documentElement.clientHeight;
    // Allow a shorter result near the article's end without clamping the scroll.
    if (scrollTop > maxScroll) {
      const contentBottom = (target.closest('.reader-section') ?? layout).getBoundingClientRect().bottom + window.scrollY;
      const unusedHeight = Math.max(0, document.documentElement.clientHeight - contentBottom);
      const padding = parseFloat(layout.style.paddingBottom) || 0;
      layout.style.paddingBottom = `${Math.ceil(padding + scrollTop - maxScroll + unusedHeight)}px`;
    }
    if (Math.abs(window.scrollY - scrollTop) > 0.5) window.scrollTo({ top: scrollTop, behavior: 'instant' });
  }

  function restoreParagraph() {
    if (!splitParagraph) return;
    const { original, continuation } = splitParagraph;
    if (continuation) {
      original.append(...continuation.childNodes);
      continuation.remove();
    }
    original.classList.remove('has-inline-analysis');
    splitParagraph = null;
  }

  function placeAnalysisPane(source: HTMLElement) {
    const focusAnchor = selected?.wordIndex == null ? source
      : source.querySelector<HTMLElement>(`[data-token-index="${selected.wordIndex}"]`) ?? source;
    const sourceTop = focusAnchor.getBoundingClientRect().top;
    const active = document.activeElement;
    const preserveFocus = active instanceof HTMLElement && source.contains(active);
    layout.append(pane);
    restoreParagraph();
    const paragraph = source.closest<HTMLParagraphElement>('.passage-paragraph');
    if (paragraph && source.parentElement === paragraph) {
      const continuation = element('p', 'passage-paragraph passage-continuation');
      continuation.lang = paragraph.lang;
      // Move the existing sentence nodes so IDs, highlights and click handlers survive.
      while (source.nextSibling) continuation.append(source.nextSibling);
      paragraph.classList.add('has-inline-analysis');
      paragraph.after(pane);
      if (continuation.hasChildNodes()) pane.after(continuation);
      splitParagraph = { original: paragraph, continuation: continuation.hasChildNodes() ? continuation : null };
    } else {
      const anchor = paragraph ?? source.closest('.intensive-question-line, .intensive-question-option') ?? source;
      anchor.after(pane);
    }
    pane.hidden = false;
    if (preserveFocus) active.focus({ preventScroll: true });
    const shift = focusAnchor.getBoundingClientRect().top - sourceTop;
    if (shift) window.scrollBy({ top: shift, behavior: 'instant' });
    revealScrollY = window.scrollY;
  }

  function revealInlineAnalysis() {
    cancelAnimationFrame(revealFrame);
    if (!panelOpen || !selected || keepPanePosition) return;
    revealFrame = requestAnimationFrame(() => {
      if (controller.signal.aborted || !panelOpen || !selected) return;
      if (revealScrollY === null || Math.abs(window.scrollY - revealScrollY) > 32) return;
      const source = selected.element.getBoundingClientRect();
      const bounds = pane.getBoundingClientRect();
      // A delayed result must not pull the reader back after they scroll away.
      if (bounds.bottom < 80 || source.top > window.innerHeight) return;
      const previewBottom = bounds.top + Math.min(bounds.height, 220);
      if (previewBottom > window.innerHeight - 16) {
        window.scrollBy({ top: previewBottom - window.innerHeight + 16, behavior: 'instant' });
        revealScrollY = window.scrollY;
      }
    });
  }

  async function prefetchCachedAnalyses(section: StudySection) {
    if (prefetchedSections.has(section.id)) return;
    prefetchedSections.add(section.id);
    try {
      const response = await jsonRequest(`${options.analysisPath || `/api/papers/${encodeURIComponent(paper.id)}/analyses`}?mode=intensive&section=${encodeURIComponent(section.id)}`, 'GET', controller.signal);
      if (controller.signal.aborted || !Array.isArray(response.analyses)) return;
      for (const entry of response.analyses) {
        const sentence = paper.sentences.find(item => item.id === entry.sentenceId && item.sectionId === section.id && item.source === entry.source);
        if (!sentence || !entry.result?.tokens || !entry.result?.grammar) continue;
        const key = cacheKey(sentence);
        // A delayed prefetch must not replace a newly generated result.
        if (!completed.has(key) && !requests.has(key)) completed.set(key, entry.result);
      }
    } catch {
      // Prefetch only reads saved results. A click still works when it fails.
      prefetchedSections.delete(section.id);
    }
  }

  async function jsonRequest(path: string, method: string, signal: AbortSignal) {
    const requestController = new AbortController();
    const cancel = () => requestController.abort(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const timeout = setTimeout(() => requestController.abort(), 15_000);
    try {
      const response = await fetch(`${apiBase}${path}`, { method, signal: requestController.signal });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 429 && body?.error === 'analysis_queue_full') {
          throw new AnalysisFailure('当前精读任务较多，请稍后再试。');
        }
        if (response.status === 503 && body?.error === 'analysis_temporarily_paused') {
          throw new AnalysisFailure('精读生成正在维护中，请稍后重试。');
        }
        throw new AnalysisFailure('精读服务暂时不可用，请稍后重试。');
      }
      return body;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
    }
  }
  function waitForJob(signal: AbortSignal, delayMs = 500) {
    return new Promise<void>((resolve, reject) => {
      const aborted = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, delayMs);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
    });
  }
  async function fetchAnalysis(sentence: StudySentence, regenerate: boolean, signal: AbortSignal): Promise<SentenceAnalysis> {
    const questionText = questionTextReferences.get(sentence.id);
    const path = questionText
      ? `/api/question-texts/${encodeURIComponent(questionText.questionId)}/analyze?mode=intensive&textKey=${encodeURIComponent(questionText.textKey)}`
      : `/api/sentences/${encodeURIComponent(sentence.id)}/analyze?mode=intensive&interactive=true`;
    let response = await jsonRequest(regenerate ? `${path}&regenerate=true` : path, 'POST', signal);
    // Several sentences can be queued by the same reader; queue time is separate
    // from the worker's three-minute generation and repair deadline.
    const deadline = Date.now() + 600_000;
    let pollDelay = 500;
    while (response.status !== 'ready') {
      if (!response.jobId) throw new AnalysisFailure(analysisErrorMessage('invalid_result'));
      if (Date.now() > deadline) throw new AnalysisFailure('精读仍未完成，请稍后重试。');
      await waitForJob(signal, pollDelay);
      const job = await jsonRequest(`/api/jobs/${encodeURIComponent(response.jobId)}`, 'GET', signal);
      if (job.status === 'failed') throw new AnalysisFailure(analysisErrorMessage(job.errorCode));
      if (selected?.sentence.id === sentence.id && !completed.has(cacheKey(sentence))) {
        const loading = paneBody.querySelector('.analysis-loading-text');
        const message = job.status === 'pending' ? '正在排队，稍候开始' : questionText ? '正在解析这段文字' : '正在解析这一句';
        if (loading && loading.textContent !== message) loading.textContent = message;
      }
      if (job.status === 'pending' && job.next_attempt_at) {
        pollDelay = Math.min(5_000, Math.max(500, Date.parse(job.next_attempt_at) - Date.now()));
      } else {
        pollDelay = 500;
      }
      if (job.status === 'succeeded') {
        response = job.result ? { status: 'ready', result: job.result } : await jsonRequest(path, 'POST', signal);
      }
    }
    if (!response.result?.tokens || !response.result?.grammar) throw new AnalysisFailure(analysisErrorMessage('invalid_result'));
    completed.set(cacheKey(sentence), response.result);
    return response.result;
  }

  async function fetchQuestionResult(path: string, signal: AbortSignal) {
    let response = await jsonRequest(path, 'POST', signal);
    const deadline = Date.now() + 600_000;
    let pollDelay = 500;
    while (response.status !== 'ready') {
      if (!response.jobId) throw new AnalysisFailure(analysisErrorMessage('invalid_result'));
      if (Date.now() > deadline) throw new AnalysisFailure('精读仍未完成，请稍后重试。');
      await waitForJob(signal, pollDelay);
      const job = await jsonRequest(`/api/jobs/${encodeURIComponent(response.jobId)}`, 'GET', signal);
      if (job.status === 'failed') throw new AnalysisFailure(analysisErrorMessage(job.errorCode));
      if (job.status === 'succeeded') {
        response = job.result ? { status: 'ready', result: job.result } : await jsonRequest(path, 'POST', signal);
      } else pollDelay = job.status === 'pending' ? 1_500 : 700;
    }
    return response.result;
  }

  function createQuestionTextSentence(section: StudySection, questionId: string, textKey: string, source: string, label: string, index: number): StudySentence {
    const sentence: StudySentence = {
      id: `question-text:${section.id}:${questionId}:${textKey}`,
      sectionId: section.id,
      source,
      paragraphIndex: -1,
      sentenceIndex: index,
      label,
    };
    questionTextReferences.set(sentence.id, { questionId, textKey });
    return sentence;
  }

  function renderQuestionAnalysis(container: HTMLElement, analysis: QuestionAnalysis) {
    const result = element('div', 'question-solving-analysis');
    result.append(element('p', 'sentence-translation', `题干翻译：${analysis.questionTranslation}`));
    result.append(element('p', 'question-analysis-focus', analysis.focus));
    const options = element('div', 'question-analysis-options');
    for (const option of analysis.options) {
      const item = element('div', `question-analysis-option${option.correct ? ' is-correct' : ''}`);
      item.append(element('strong', 'question-option-title', `${option.key}${option.correct ? ' · 正确项' : ''}｜${option.translation}`));
      item.append(element('p', 'question-option-analysis', option.analysis));
      options.append(item);
    }
    result.append(options);
    result.append(element('p', 'question-analysis-answer', `参考答案：${analysis.correctAnswer}`));
    const evidence = element('div', 'question-analysis-evidence');
    evidence.append(element('h5', '', '原文依据'));
    for (const item of analysis.evidence) {
      const quote = element('blockquote', '');
      quote.append(element('strong', '', item.location), element('p', '', `“${item.excerpt}”`), element('p', '', item.explanation));
      evidence.append(quote);
    }
    result.append(evidence, element('p', 'question-analysis-reasoning', analysis.reasoning));
    for (const [title, entries] of [['易错点', analysis.traps], ['解题步骤', analysis.steps]] as const) {
      const group = element('div', 'question-analysis-list');
      group.append(element('h5', '', title));
      const list = element('ul', '');
      for (const entry of entries) list.append(element('li', '', entry));
      group.append(list);
      result.append(group);
    }
    container.replaceChildren(result);
  }

  function renderStudyQuestions(section: StudySection, block: HTMLElement) {
    if (!['reading', 'matching'].includes(section.kind) || !section.questions.length) return;
    const list = element('section', 'intensive-questions');
    const heading = element('div', 'intensive-questions-heading');
    const title = element('h3', '', '题目与解析');
    title.id = `questions-${section.id}`;
    list.setAttribute('aria-labelledby', title.id);
    heading.append(title, element('span', '', `${section.questions.length} 题`));
    list.append(heading, element('p', 'intensive-questions-note', section.kind === 'reading' ? '点击题干或选项查看精读。' : '点击题干查看精读。'));
    for (const [index, question] of section.questions.entries()) {
      const card = element('article', 'intensive-question');
      const questionNumber = question.prompt.match(/^\s*(\d+)\s*[.)]/)?.[1] ?? String(index + 1);
      const promptText = question.prompt.replace(/^\s*\d+\s*[.)]\s*/, '');
      const prompt = element('h4', 'intensive-question-line');
      prompt.append(element('span', 'intensive-question-title', `第 ${questionNumber} 题`));
      const promptSentence = createQuestionTextSentence(section, question.id, 'prompt', promptText, '题干', index);
      const promptSource = renderSentence(promptSentence);
      promptSource.setAttribute('aria-label', '题干，点击查看精读');
      prompt.append(promptSource);
      card.append(prompt);

      if (section.kind === 'reading') {
        const options = element('div', 'intensive-question-options');
        for (const option of question.options) {
          const optionCard = element('div', 'intensive-question-option');
          optionCard.append(element('strong', 'question-option-key', `${option.key}.`));
          const optionSentence = createQuestionTextSentence(section, question.id, `option:${option.key}`, option.text, `选项 ${option.key}`, index);
          const optionSource = renderSentence(optionSentence);
          optionSource.setAttribute('aria-label', `选项 ${option.key}，点击查看精读`);
          optionCard.append(optionSource);
          options.append(optionCard);
        }
        card.append(options);
      }

      if (section.kind === 'reading') {
        const solvingDisclosure = element('details', 'question-solving-disclosure');
        const solvingSummary = element('summary', 'question-solving-summary', '查看解题思路与原文依据');
        const solving = element('div', 'question-solving-result');
        const cached = questionAnalyses.get(question.id);
        let questionRequest: Promise<QuestionAnalysis> | null = null;
        if (cached) renderQuestionAnalysis(solving, cached);
        solvingDisclosure.addEventListener('toggle', () => {
          if (!solvingDisclosure.open || questionAnalyses.has(question.id) || questionRequest) return;
          const loading = element('p', 'analysis-loading');
          loading.append(element('span', 'analysis-loading-text', '正在生成做题精读'), waitingDots());
          loading.setAttribute('role', 'status');
          solving.replaceChildren(loading);
          questionRequest = fetchQuestionResult(`/api/questions/${encodeURIComponent(question.id)}/analyze?mode=question`, controller.signal)
            .then((analysis: QuestionAnalysis) => {
              questionAnalyses.set(question.id, analysis);
              renderQuestionAnalysis(solving, analysis);
              return analysis;
            })
            .catch(error => {
              solving.replaceChildren(element('p', 'analysis-empty', error instanceof Error ? error.message : '做题精读失败，请重试。'));
              throw error;
            })
            .finally(() => { questionRequest = null; });
          void questionRequest.catch(() => undefined);
        });
        solvingDisclosure.append(solvingSummary, solving);
        card.append(solvingDisclosure);
      }
      list.append(card);
    }
    block.append(list);
  }
  async function selectSentence(sentence: StudySentence, source: HTMLElement, wordIndex: number | null, regenerate = false, keepPosition = false) {
    keepPanePosition = keepPosition;
    layout.classList.toggle('keeps-analysis-position', keepPosition);
    if (!keepPosition) layout.style.paddingBottom = '';
    clearTimeout(positionTimer);
    lastReadSentenceId = sentence.id;
    options.onPositionChange?.(sentence.sectionId, sentence.id);
    selected = { sentence, element: source, wordIndex };
    lastSelection = selected;
    panelOpen = true;
    placeAnalysisPane(source);
    pane.classList.add('is-open');
    close.hidden = false;
    highlightSelection();
    paneTitle.textContent = sentence.label ?? `第 ${sentence.sentenceIndex + 1} 句`;
    paneTitle.hidden = false;
    wordDetail.hidden = true;
    wordDetail.replaceChildren();
    updateProgress();
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
      paneBody.setAttribute('aria-busy', 'true');
      paneBody.replaceChildren(loading);
    }
    updateActions();
    revealInlineAnalysis();
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
      const showFailure = () => {
        paneBody.setAttribute('aria-busy', 'false');
        paneBody.replaceChildren(message, retry);
        updateActions();
      };
      if (keepPanePosition) preservePanePosition(showFailure);
      else showFailure();
      revealInlineAnalysis();
    }
  }
  function renderSentence(sentence: StudySentence, underlined: { start: number; end: number }[] = []) {
    const source = element('span', 'source-sentence');
    source.dataset.sentenceId = sentence.id;
    if (!hasWordTokens(sentence.source)) {
      source.classList.add('is-static');
      source.removeAttribute('tabindex');
      source.removeAttribute('role');
      source.textContent = sentence.source;
      return source;
    }
    source.tabIndex = 0;
    renderedSentences.set(sentence.id, { sentence, element: source, wordIndex: null });
    source.setAttribute('role', 'group');
    source.setAttribute('aria-label', `第 ${sentence.sentenceIndex + 1} 句，按回车查看精读，按空格展开或收起`);
    source.setAttribute('aria-keyshortcuts', 'Enter Space');
    let offset = 0;
    let unit: HTMLSpanElement | null = null;
    for (const token of tokenize(sentence.source)) {
      if (token.charStart > offset) {
        source.append(document.createTextNode(sentence.source.slice(offset, token.charStart)));
        unit = null;
      }
      // Inline buttons can otherwise wrap separately from their following punctuation.
      if (!unit) { unit = element('span', 'source-unit'); source.append(unit); }
      if (underlined.some(range => token.charStart >= range.start && token.charEnd <= range.end)) unit.classList.add('is-translation-target');
      if (token.kind === 'word') {
        const word = element('button', 'source-word', token.text);
        word.type = 'button';
        word.dataset.tokenIndex = String(token.index);
        word.setAttribute('aria-label', `${token.text}，查看词义`);
        word.setAttribute('aria-pressed', 'false');
        word.addEventListener('click', event => {
          event.stopPropagation();
          if (!window.getSelection()?.toString()) void selectSentence(sentence, source, token.index);
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
      if (event.target === source && event.key === 'Enter') {
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
    if (keepPanePosition) preservePanePosition(() => renderAnalysisContent(analysis));
    else renderAnalysisContent(analysis);
  }
  function renderAnalysisContent(analysis: SentenceAnalysis) {
    if (!selected) return;
    updateActions();
    highlightSelection();
    paneBody.setAttribute('aria-busy', 'false');
    paneBody.replaceChildren();
    wordDetail.replaceChildren();
    wordDetail.hidden = true;
    paneTitle.hidden = false;
    if (selected.wordIndex !== null) {
      const token = analysis.tokens.find(token => token.index === selected?.wordIndex);
      if (token?.kind === 'word') {
        const heading = element('div', 'word-heading');
        heading.append(element('strong', 'word-headword', token.text), element('span', 'word-pos', token.pos ?? ''));
        if (token.lemma && token.lemma.toLowerCase() !== token.text.toLowerCase()) heading.append(element('span', 'word-lemma', `原形 ${token.lemma}`));
        wordDetail.append(heading, element('p', 'word-meaning', token.contextMeaning ?? ''));
        wordDetail.hidden = false;
        paneTitle.hidden = true;
      }
    }
    const tabs = element('div', 'analysis-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '句子解析');
    const body = element('div', 'analysis-tab-content');
    body.id = 'sentence-analysis-content';
    body.setAttribute('role', 'tabpanel');
    tabs.setAttribute('aria-keyshortcuts', 'W S');
    for (const [index, [tab, label]] of analysisTabs.entries()) {
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
        const count = analysisTabs.length;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : (index + (event.key === 'ArrowRight' ? 1 : count - 1)) % count;
        activeTab = analysisTabs[next]![0];
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
    updateProgress();
    revealInlineAnalysis();
  }
  function showSection(section: StudySection) {
    disposeChat?.();
    disposeChat = undefined;
    const isInitialSection = currentSectionId === null;
    currentSectionId = section.id;
    if (!isInitialSection && !options.hideNavigation) requestAnimationFrame(() => {
      if (!controller.signal.aborted && currentSectionId === section.id) {
        navigation.scrollIntoView({ block: 'start', behavior: 'instant' });
      }
    });
    clearTimeout(positionTimer);
    activeSentences = [];
    options.onPositionChange?.(section.id);
    dismiss(false);
    lastSelection = null;
    renderedSentences.clear();
    toolbar.updateStats(section.paragraphs.join(' '));
    progress.value = 0;
    const block = element('section', 'passage-section');
    block.dataset.sectionKind = section.kind;
    if (!options.hideNavigation) block.append(element('h3', 'passage-title', section.title));
    layout.classList.toggle('has-shared-section', Boolean(section.reference));
    if (section.reference) {
      block.append(createSharedSectionNotice(section.reference, 'intensive'));
      documentColumn.replaceChildren(block);
      pane.hidden = true;
      return;
    }
    const sentences = paper.sentences.filter(sentence => sentence.sectionId === section.id);
    activeSentences = sentences;
    if (section.kind === 'cloze' && paper.content_kind === 'imported') block.append(element('p', 'passage-note', '空格按参考答案补全'));
    if (['reading', 'matching'].includes(section.kind) && section.instructions) {
      const instructions = element('details', 'reading-instructions');
      instructions.append(element('summary', '', '考试说明'), element('p', 'section-instructions', section.instructions));
      block.append(instructions);
    }
    if (section.kind === 'writing' && paper.content_kind !== 'imported') block.append(element('p', 'passage-paragraph', section.questions[0]?.prompt ?? ''));
    if (!sentences.length) {
      for (const text of section.paragraphs) block.append(element('p', 'passage-paragraph', text));
    }
    let paragraphIndex = -1;
    let paragraphOffset = 0;
    let underlined: { start: number; end: number }[] = [];
    let paragraph = element('p', 'passage-paragraph');
    for (const sentence of sentences) {
      if (sentence.paragraphIndex !== paragraphIndex) {
        paragraphIndex = sentence.paragraphIndex;
        paragraphOffset = 0;
        const text = sentences.filter(item => item.paragraphIndex === paragraphIndex).map(item => item.source).join(' ');
        underlined = section.kind === 'translation' && paper.exam_level === 'NEEP' ? section.questions.map(question => {
          const segment = question.prompt.replace(/^\d+\.\s*/, '');
          const start = text.indexOf(segment);
          return { start, end: start + segment.length };
        }).filter(range => range.start >= 0) : [];
        paragraph = element('p', 'passage-paragraph');
        paragraph.lang = 'en';
        if (section.kind === 'matching') {
          const original = section.paragraphs.find(item => item.replace(/^\[[A-Z]\]\s*/, '').trim() === text) ?? section.paragraphs[paragraphIndex % 100];
          const label = original?.match(/^\[([A-Z])\]/)?.[1];
          if (label) paragraph.append(element('span', 'paragraph-label', `${label} `));
        }
        block.append(paragraph);
      } else paragraph.append(document.createTextNode(' '));
      paragraph.append(renderSentence(sentence, underlined.map(range => ({ start: range.start - paragraphOffset, end: range.end - paragraphOffset }))));
      paragraphOffset += sentence.source.length + 1;
    }
    appendSectionImages(block, section);
    renderStudyQuestions(section, block);
    if (['reading', 'matching', 'cloze', 'translation'].includes(section.kind) && section.paragraphs.some(text => text.trim())) {
      const chat = createArticleChat(apiBase, paper.content_kind === 'news'
        ? { kind: 'news', id: paper.id }
        : { kind: 'paper', id: paper.id, sectionId: section.id }, section.title);
      block.append(chat.element);
      disposeChat = chat.dispose;
    }
    documentColumn.replaceChildren(block);
    if (sentences.length) {
      void prefetchCachedAnalyses(section);
      if (isInitialSection && options.initialSectionId === section.id && options.initialSentenceId) {
        const sentence = sentences.find(item => item.id === options.initialSentenceId);
        if (sentence) requestAnimationFrame(() => {
          if (controller.signal.aborted) return;
          const source = documentColumn.querySelector<HTMLElement>(`[data-sentence-id="${CSS.escape(sentence.id)}"]`);
          if (!source) return;
          restoringPosition = true;
          source.scrollIntoView({ block: 'center', behavior: 'instant' });
          // Restore the reading point without opening an analysis or generating AI work.
          source.classList.add('is-resume-point');
          requestAnimationFrame(() => { restoringPosition = false; });
        });
      }
    }
  }
  const initialSection = paper.sections.find(section => section.id === options.initialSectionId)
    ?? paper.sections.find(section => section.kind === 'reading' && !section.reference)
    ?? paper.sections.find(section => !section.reference) ?? paper.sections[0];
  if (initialSection) selectSection(initialSection.id);
  function updateProgress() {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      let total = 0;
      let visible = 0;
      for (const paragraph of documentColumn.querySelectorAll<HTMLElement>('.passage-paragraph, .passage-section > .section-image')) {
        const bounds = paragraph.getBoundingClientRect();
        total += bounds.height;
        visible += Math.min(bounds.height, Math.max(0, window.innerHeight - bounds.top));
      }
      progress.value = total ? Math.round(visible / total * 100) : 0;
    });
  }
  const saveReadingPosition = () => {
    if (panelOpen || restoringPosition) return;
    clearTimeout(positionTimer);
    positionTimer = setTimeout(() => {
      const source = [...documentColumn.querySelectorAll<HTMLElement>('.passage-paragraph .source-sentence')].find(node => {
        const bounds = node.getBoundingClientRect();
        return bounds.bottom > 100 && bounds.top < window.innerHeight;
      });
      const sentence = activeSentences.find(item => item.id === source?.dataset.sentenceId);
      if (!sentence || sentence.id === lastReadSentenceId) return;
      lastReadSentenceId = sentence.id;
      options.onPositionChange?.(sentence.sectionId, sentence.id);
    }, 200);
  };
  window.addEventListener('scroll', updateProgress, { passive: true, signal: controller.signal });
  window.addEventListener('scroll', saveReadingPosition, { passive: true, signal: controller.signal });
  window.addEventListener('resize', updateProgress, { passive: true, signal: controller.signal });
  target.addEventListener('load', updateProgress, { capture: true, signal: controller.signal });
  updateProgress();
  function selectionToOpen(origin: HTMLElement) {
    const focusedSource = origin.closest<HTMLElement>('.source-sentence');
    const focused = focusedSource && renderedSentences.get(focusedSource.dataset.sentenceId ?? '');
    if (focused) {
      const word = origin.closest<HTMLElement>('.source-word');
      return { ...focused, wordIndex: word ? Number(word.dataset.tokenIndex) : lastSelection?.sentence.id === focused.sentence.id ? lastSelection.wordIndex : null };
    }
    if (lastSelection?.element.isConnected) return lastSelection;
    const resumed = lastReadSentenceId && renderedSentences.get(lastReadSentenceId);
    if (resumed) return resumed;
    const sentences = activeSentences.map(sentence => renderedSentences.get(sentence.id)).filter((entry): entry is Selection => Boolean(entry));
    return sentences.find(entry => {
      const bounds = entry.element.getBoundingClientRect();
      return bounds.bottom > 100 && bounds.top < window.innerHeight;
    }) ?? sentences[0];
  }
  const shortcutsKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || target.closest('[hidden]')) return;
    const origin = event.target instanceof HTMLElement ? event.target : document.body;
    if (origin.isContentEditable || origin.closest('input, textarea, select, [role="textbox"], [role="combobox"], [role="dialog"], [aria-modal="true"]')) return;
    if (event.key === 'Escape') {
      if (panelOpen) dismiss();
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'q' || key === 'e') {
      event.preventDefault();
      cancelAnimationFrame(revealFrame);
      revealScrollY = null;
      window.scrollTo({ top: key === 'q' ? 0 : document.documentElement.scrollHeight, behavior: 'instant' });
      return;
    }
    if (event.key === ' ') {
      // Preserve native Space activation for controls outside the sentence reader.
      if (origin.closest('button, a, summary, [role="button"], [role="tab"], [role="option"], [role="slider"]')
        && !origin.closest('.source-sentence, .analysis-pane')) return;
      const selection = panelOpen ? selected : selectionToOpen(origin);
      if (!selection) return;
      event.preventDefault();
      if (event.repeat) return;
      if (panelOpen) dismiss();
      else void selectSentence(selection.sentence, selection.element, selection.wordIndex);
      return;
    }
    if (!panelOpen || !selected || !['a', 'd', 'w', 's'].includes(key)) return;
    event.preventDefault();
    // Keep held keys useful without navigating at the keyboard's full repeat rate.
    const now = performance.now();
    if (event.repeat && now - lastShortcutTime < 200) return;
    lastShortcutTime = now;
    if (key === 'a' || key === 'd') {
      moveSentence(key === 'a' ? -1 : 1);
    } else {
      const index = analysisTabs.findIndex(([tab]) => tab === activeTab);
      activeTab = analysisTabs[(index + (key === 'w' ? -1 : 1) + analysisTabs.length) % analysisTabs.length]![0];
      const analysis = completed.get(cacheKey(selected.sentence));
      if (analysis) {
        const restoreTabFocus = paneBody.contains(document.activeElement);
        renderAnalysis(analysis);
        if (restoreTabFocus) paneBody.querySelector<HTMLButtonElement>(`#analysis-tab-${activeTab}`)?.focus({ preventScroll: true });
      }
    }
  };
  document.addEventListener('keydown', shortcutsKeydown, { signal: controller.signal });
  return () => {
    controller.abort();
    disposeChat?.();
    clearTimeout(positionTimer);
    cancelAnimationFrame(scrollFrame);
    cancelAnimationFrame(revealFrame);
    restoreParagraph();
    toolbar.dispose();
    // Regeneration can finish and update its cache while the user changes modes/papers.
    for (const request of ownedRequests) if (!request.regenerating) request.controller.abort();
  };
}
