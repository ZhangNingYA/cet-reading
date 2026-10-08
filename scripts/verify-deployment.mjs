import { isDeepStrictEqual } from 'node:util';
import { readPaperSources, splitStudyParagraph } from './lib/paper-sources.mjs';
import { presentPaper } from '../packages/contracts/dist/shared-reading.js';

const baseUrl = (process.env.DEPLOY_URL || 'http://localhost:8081').replace(/\/+$/, '');
const timeoutMs = Number(process.env.DEPLOY_VERIFY_TIMEOUT_MS || 15_000);
const attempts = Number(process.env.DEPLOY_VERIFY_ATTEMPTS || 5);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(path) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}${path}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(3_000);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`${path} failed after ${attempts} attempts: ${lastError?.message || lastError}`);
}

const homeResponse = await fetchWithRetry('/');
const homeHtml = await homeResponse.text();
if (!homeHtml.includes('class="home-section container"') || homeHtml.includes('id="papers"')) {
  throw new Error('The home page must show section navigation rather than a paper list');
}
const sectionPaths = [...new Set([...homeHtml.matchAll(/class="section-entry"\s+href="(\/[^/"?]+\/)"/g)].map((match) => match[1]))];
if (!sectionPaths.length) throw new Error('The home page has no section links');
await Promise.all(sectionPaths.map(async (path) => {
  const response = await fetchWithRetry(path);
  const html = await response.text();
  if (!html.includes('id="library-title"') || !html.includes('id="papers"') || html.includes('class="home-section container"')) {
    throw new Error(`${path} must serve its paper list instead of falling back to the home page`);
  }
}));
const papersResponse = await fetchWithRetry('/api/papers');
const papers = await papersResponse.json();
if (!Array.isArray(papers.papers)) {
  throw new Error('/api/papers returned an unexpected payload');
}
const sources = readPaperSources();
function sectionViews(paper) {
  return paper.sections.map(section => ({
    id: section.id,
    kind: section.kind,
    title: section.title,
    instructions: section.instructions ?? '',
    paragraphs: section.paragraphs ?? [],
    questions: (section.questions ?? []).map(({ id, type, prompt, options = [] }) => ({ id, type, prompt, options })),
  }));
}
if (!isDeepStrictEqual(papers.papers.map(paper => paper.id).sort(), sources.map(({ paper }) => paper.id).sort())) {
  throw new Error('The published paper list does not match data/papers');
}
await Promise.all(sources.map(async ({ file, paper: source }) => {
  const expected = { variant: '', content_kind: 'original', sections: [], ...source };
  const summary = papers.papers.find(paper => paper.id === expected.id);
  for (const key of ['exam_level', 'year', 'month', 'set_no', 'variant', 'title', 'content_state', 'content_kind', 'description', 'reference_paper_id']) {
    if (summary[key] !== expected[key]) throw new Error(`Incorrect ${key} for ${file}`);
  }
  if (summary.has_content !== (expected.sections.length > 0)) throw new Error(`Incorrect content state for ${file}`);

  const response = await fetchWithRetry(`/api/papers/${expected.id}`);
  const actual = await response.json();
  const sections = sectionViews(expected);
  const sentences = expected.sections.flatMap((section, sectionIndex) =>
    (section.study_paragraphs ?? []).flatMap((paragraph, paragraphIndex) =>
      splitStudyParagraph(paragraph).map((source, sentenceIndex) => ({
        id: `${section.id}-sentence-${paragraphIndex + 1}-${sentenceIndex + 1}`,
        paragraphIndex: sectionIndex * 100 + paragraphIndex,
        sentenceIndex,
        source,
        sectionId: section.id,
      })),
    ),
  );
  const original = sources.find(({ paper }) => paper.id === expected.reference_paper_id)?.paper;
  const presented = presentPaper({ ...expected, sections, sentences }, original ? { ...original, sections: sectionViews(original) } : null);
  if (!isDeepStrictEqual(actual.sections, presented.sections) || !isDeepStrictEqual(actual.sentences, presented.sentences)) {
    throw new Error(`The deployed sections, questions or study sentences do not match ${file}`);
  }
}));

console.log(`Deployment verified: ${baseUrl} (${sectionPaths.length} categories, ${sources.length} papers)`);
