import { mountIntensive } from './intensive-reader';
import { createSectionNavigation } from './section-navigation';
import { createSharedSectionNotice } from './section-reference';
import { appendMaterialText, appendSectionImages } from './section-material';

const library = document.querySelector('#library');
const apiBase = library.dataset.apiBase;
const examLevels = JSON.parse(library.dataset.examLevels);
const status = document.querySelector('#status');
const papers = document.querySelector('#papers');
const reader = document.querySelector('#reader');
const readerTitle = document.querySelector('#reader-title');
const readerMeta = document.querySelector('#reader-meta');
const readerStatus = document.querySelector('#reader-status');
const readerContent = document.querySelector('#reader-content');
const retryPapers = document.querySelector('#retry-papers');
const libraryResults = document.querySelector('#library-results');
const search = document.querySelector('#paper-search');
const paperCount = document.querySelector('#paper-count');
const modeButtons = [...document.querySelectorAll('[data-reader-mode]')];
let allPapers = [];
let activePaper = null;
let disposeIntensive = null;
let viewRequest = 0;

function levelName(level) { return level === 'CET6' ? '六级' : level === 'NEEP' ? '考研' : '四级'; }
function createModeButton(text, mode, paper) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'button button-small paper-mode-button'; button.textContent = text;
  button.dataset.mode = mode; button.setAttribute('aria-label', `${paper.title}，${text}`);
  button.addEventListener('click', () => openPaper(paper, mode)); return button;
}
function showPapers() {
  const query = search.value.trim().toLowerCase();
  const visible = allPapers.filter((paper) => examLevels.includes(paper.exam_level) && (!query || `${paper.title} ${paper.year} ${paper.exam_level}`.toLowerCase().includes(query)))
    .sort((a, b) => b.year - a.year || b.month - a.month || a.set_no - b.set_no);
  papers.replaceChildren();
  paperCount.textContent = visible.length ? `${visible.length} 套` : '';
  status.textContent = query ? `找到 ${visible.length} 套试卷` : '题库已加载';
  if (!visible.length) { const empty = document.createElement('div'); empty.className = 'empty-state'; const message = document.createElement('strong'); message.textContent = query ? '没有找到相关试卷' : '暂无试卷'; empty.append(message); papers.append(empty); return; }
  const groups = new Map();
  for (const paper of visible) {
    const groupKey = paper.exam_level === 'NEEP' ? String(paper.year) : `${paper.year}-${paper.month}`;
    if (!groups.has(groupKey)) {
      const group = document.createElement('section'); group.className = 'paper-group'; group.setAttribute('aria-label', paper.exam_level === 'NEEP' ? `${paper.year} 年试卷` : `${paper.year} 年 ${paper.month} 月试卷`);
      const date = document.createElement('h2'); date.className = 'paper-group-heading'; date.textContent = paper.year;
      if (paper.exam_level !== 'NEEP') { const month = document.createElement('span'); month.className = 'paper-group-month'; month.textContent = `· ${paper.month}月`; date.append(month); }
      const list = document.createElement('div'); list.className = 'paper-group-list'; group.append(date, list); papers.append(group); groups.set(groupKey, list);
    }
    const item = document.createElement('article'); item.className = 'paper-card';
    const heading = document.createElement('h3'); heading.className = 'paper-card-title';
    const fullTitle = document.createElement('span'); fullTitle.className = 'sr-only'; fullTitle.textContent = paper.title;
    const edition = document.createElement('span'); edition.className = 'paper-edition'; edition.setAttribute('aria-hidden', 'true'); edition.textContent = paper.variant || `第 ${paper.set_no} 套`;
    heading.append(fullTitle, edition); item.append(heading);
    const bottom = document.createElement('div'); bottom.className = 'paper-card-bottom';
    const typeLabel = paper.content_state === 'external' ? '原站资料' : paper.content_kind === 'original' ? '原创练习' : paper.is_demo ? '本地演示' : '';
    if (typeLabel) { const type = document.createElement('span'); type.className = 'paper-type'; type.textContent = typeLabel; bottom.append(type); }
    if (typeLabel) item.append(bottom);
    const actions = document.createElement('div'); actions.className = 'paper-card-actions';
    if (paper.content_state === 'external') {
      const source = document.createElement('a'); source.className = 'button button-small paper-source'; source.href = paper.source_url; source.target = '_blank'; source.rel = 'noreferrer'; source.textContent = '原站查看'; actions.append(source);
      const note = document.createElement('span'); note.className = 'paper-mode-note'; note.textContent = '内容未托管'; actions.append(note);
    } else actions.append(createModeButton('精读', 'intensive', paper), createModeButton('做题', 'practice', paper));
    item.append(actions); groups.get(groupKey).append(item);
  }
}
async function fetchPaper(id) { const response = await fetch(`${apiBase}/api/papers/${encodeURIComponent(id)}`); if (!response.ok) throw new Error('paper request failed'); return response.json(); }
function updateUrl(paperId, mode) {
  const url = new URL(window.location.href);
  url.search = `?paper=${encodeURIComponent(paperId)}&mode=${mode}`;
  if (url.href !== location.href) history.pushState({}, '', url);
}
async function openPaper(summary, mode, writeHistory = true) {
  if (!summary) return;
  const request = ++viewRequest;
  disposeIntensive?.(); disposeIntensive = null;
  try {
    const paper = activePaper?.id === summary.id ? activePaper : await fetchPaper(summary.id);
    if (request !== viewRequest || paper.content_state !== 'local') return;
    activePaper = paper;
    if (writeHistory) updateUrl(summary.id, mode);
    library.hidden = true; reader.hidden = false;
    document.body.classList.add('reader-page');
    modeButtons.forEach((button) => { button.classList.toggle('active', button.dataset.readerMode === mode); button.setAttribute('aria-pressed', String(button.dataset.readerMode === mode)); });
    readerMeta.textContent = `${levelName(paper.exam_level)} · ${paper.year} · ${paper.variant || `第 ${paper.set_no} 套`}`;
    readerTitle.textContent = paper.title;
    readerStatus.textContent = '';
    readerContent.replaceChildren();
    if (mode === 'intensive') disposeIntensive = mountIntensive(paper, apiBase, readerContent);
    else await renderPractice(paper, request);
    window.scrollTo({ top: 0, behavior: 'instant' });
    readerTitle.focus({ preventScroll: true });
  } catch {
    if (request === viewRequest) { status.textContent = '试卷加载失败，请重试。'; status.classList.remove('sr-only'); }
  }
}
async function renderPractice(paper, request) {
  const response = await fetch(`${apiBase}/api/papers/${paper.id}/attempts`, { method: 'POST' }); if (request !== viewRequest) return; if (!response.ok) { readerContent.innerHTML = '<div class="empty-state error-state"><strong>做题模式暂不可用</strong></div>'; return; }
  const attempt = await response.json(); const form = document.createElement('form'); form.className = 'practice-form';
  const blocks = new Map();
  for (const section of paper.sections) {
    const block = document.createElement('section'); block.className = 'practice-section';
    const material = document.createElement('div'); material.className = 'practice-material';
    const heading = document.createElement('h2'); heading.textContent = section.title; material.append(heading); block.append(material);
    block.dataset.sectionKind = section.kind; blocks.set(section.id, block);
    if (section.reference) {
      block.classList.add('is-shared-section');
      material.append(createSharedSectionNotice(section.reference, 'practice'));
      form.append(block);
      continue;
    }
    if (section.instructions) { const note = document.createElement('p'); note.className = 'section-instructions'; note.textContent = section.instructions; material.append(note); }
    const sharedWordBank = section.kind === 'cloze' && paper.exam_level !== 'NEEP';
    if (sharedWordBank) {
      const bank = document.createElement('div'); bank.className = 'word-bank'; bank.setAttribute('aria-label', '选词填空词库');
      for (const option of section.questions[0]?.options ?? []) { const word = document.createElement('span'); word.textContent = `${option.key}. ${option.text}`; bank.append(word); }
      material.append(bank);
    }
    for (const paragraph of section.paragraphs ?? []) { const text = document.createElement('p'); text.className = 'practice-paragraph'; text.lang = section.kind === 'translation' && paper.exam_level !== 'NEEP' ? 'zh-CN' : 'en'; appendMaterialText(text, paragraph, section, paper.exam_level); material.append(text); }
    appendSectionImages(material, section);
    const questions = document.createElement('div'); questions.className = `practice-questions${sharedWordBank || section.kind === 'matching' ? ' compact-questions' : ''}`;
    for (const question of section.questions) {
      const item = document.createElement('fieldset'); item.className = 'practice-question'; const legend = document.createElement('legend'); legend.textContent = question.prompt; item.append(legend);
      if (question.type === 'choice' && (sharedWordBank || section.kind === 'matching')) {
        const select = document.createElement('select'); select.name = question.id; select.setAttribute('aria-label', question.prompt);
        const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '选择答案'; select.append(placeholder);
        for (const option of question.options) { const choice = document.createElement('option'); choice.value = option.key; choice.textContent = option.text === option.key ? option.key : `${option.key}. ${option.text}`; select.append(choice); }
        item.append(select);
      }
      else if (question.type === 'choice') for (const option of question.options) { const label = document.createElement('label'); const input = document.createElement('input'); input.type = 'radio'; input.name = question.id; input.value = option.key; label.append(input, document.createTextNode(` ${option.key}. ${option.text}`)); item.append(label); }
      else { const textarea = document.createElement('textarea'); textarea.name = question.id; textarea.rows = 5; textarea.placeholder = '在这里作答'; item.append(textarea); }
      questions.append(item);
    }
    block.append(questions);
    form.append(block);
  }
  const { navigation, selectSection } = createSectionNavigation(paper.sections, section => {
    for (const [id, block] of blocks) block.hidden = id !== section.id;
  }, '做题章节', paper.exam_level);
  navigation.classList.add('practice-navigation');
  selectSection(paper.sections[0].id);
  const submitBar = document.createElement('div'); submitBar.className = 'practice-submit-bar';
  const progress = document.createElement('span'); progress.className = 'practice-progress'; progress.setAttribute('role', 'status');
  const questionCount = paper.sections.reduce((count, section) => count + section.questions.length, 0);
  const updateProgress = () => { const answered = [...form.querySelectorAll('input:checked, textarea, select')].filter(input => input.value.trim()).length; const text = `${answered} / ${questionCount} 已作答`; if (progress.textContent !== text) progress.textContent = text; };
  form.addEventListener('input', updateProgress); updateProgress();
  const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'button button-primary'; submit.textContent = '提交答案'; const result = document.createElement('div'); result.className = 'practice-result'; submitBar.append(progress, submit); form.append(submitBar, result);
  form.addEventListener('submit', async (event) => { event.preventDefault(); submit.disabled = true; const answers = Object.fromEntries([...form.querySelectorAll('input:checked, textarea, select')].map((input) => [input.name, input.value]));
    try { const saved = await fetch(`${apiBase}/api/attempts/${attempt.id}/answers`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answers }) }); if (!saved.ok) throw new Error('save failed'); const submittedResponse = await fetch(`${apiBase}/api/attempts/${attempt.id}/submit`, { method: 'POST' }); if (!submittedResponse.ok) throw new Error('submit failed'); renderPracticeResult((await submittedResponse.json()).result, result); }
    catch { result.textContent = '提交失败，请重试。'; submit.disabled = false; }
  });
  readerContent.append(navigation, form);
}
function renderPracticeResult(summary, target) {
  target.replaceChildren();
  const heading = document.createElement('strong'); heading.textContent = summary.objectiveCount ? `客观题 ${summary.objectiveScore} / ${summary.objectiveTotal} · ${summary.manualCount} 道主观题已保存` : `${summary.manualCount} 道主观题已保存`; target.append(heading);
  if (activePaper.content_kind === 'imported' && summary.objectiveCount) { const note = document.createElement('p'); note.textContent = '客观题按依据原文整理的参考答案核对。'; target.append(note); }
  const prompts = new Map(activePaper.sections.flatMap(section => section.questions.map(question => [question.id, question.prompt])));
  for (const question of summary.questions) {
    const line = document.createElement('p'); const title = prompts.get(question.id) ?? question.id;
    line.textContent = question.status === 'manual' ? `${title}：已保存作答${question.correctAnswer ? `；参考答案：${question.correctAnswer}` : '，请自行核对。'}` : `${title}：${question.status === 'correct' ? '正确' : question.status === 'unanswered' ? '未作答' : `错误，参考答案 ${question.correctAnswer}`} · ${question.explanation}`;
    target.append(line);
  }
}
async function loadPapers() {
  retryPapers.hidden = true; status.textContent = '正在加载'; libraryResults.setAttribute('aria-busy', 'true');
  try { const response = await fetch(`${apiBase}/api/papers`); if (!response.ok) throw new Error('paper request failed'); allPapers = (await response.json()).papers ?? []; status.textContent = '题库已加载'; showPapers(); const params = new URLSearchParams(location.search); const paper = allPapers.find((item) => item.id === params.get('paper')); if (paper && paper.content_state === 'local') await openPaper(paper, params.get('mode') === 'practice' ? 'practice' : 'intensive'); }
  catch { status.textContent = '暂时无法连接阅读题库。'; retryPapers.hidden = false; papers.innerHTML = '<div class="empty-state error-state"><strong>阅读内容加载失败</strong><span>请稍后再试，或确认后端服务正在运行。</span></div>'; }
  finally { libraryResults.setAttribute('aria-busy', 'false'); }
}
modeButtons.forEach((button) => button.addEventListener('click', () => { if (activePaper) openPaper(allPapers.find((paper) => paper.id === activePaper.id), button.dataset.readerMode); }));
retryPapers.addEventListener('click', loadPapers);
function closeReader(writeHistory = true) {
  ++viewRequest; disposeIntensive?.(); disposeIntensive = null;
  reader.hidden = true; library.hidden = false;
  document.body.classList.remove('reader-page');
  if (writeHistory) history.pushState({}, '', location.pathname);
  library.scrollIntoView({ behavior: 'instant' });
}
document.querySelector('#close-reader').addEventListener('click', () => closeReader());
window.addEventListener('popstate', () => {
  const params = new URLSearchParams(location.search);
  const paper = allPapers.find(item => item.id === params.get('paper'));
  if (paper) openPaper(paper, params.get('mode') === 'practice' ? 'practice' : 'intensive', false);
  else closeReader(false);
});
search.addEventListener('input', showPapers); loadPapers();
