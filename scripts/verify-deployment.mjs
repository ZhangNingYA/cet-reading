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
const retainedId = 'original-cet4-2026-1';
const retainedPaper = papers.papers[0];
if (papers.papers.length !== 1 || retainedPaper?.id !== retainedId
  || retainedPaper.exam_level !== 'CET4' || retainedPaper.content_state !== 'local'
  || retainedPaper.content_kind !== 'original' || !retainedPaper.has_content) {
  throw new Error('Only the first local CET4 practice paper should be published');
}
const detailResponse = await fetchWithRetry(`/api/papers/${retainedId}`);
const paper = await detailResponse.json();
const sections = paper?.sections;
if (!Array.isArray(sections) || sections.length !== 6
  || sections.reduce((count, section) => count + section.questions.length, 0) !== 17
  || !Array.isArray(paper.sentences) || paper.sentences.length !== 40) {
  throw new Error('The retained CET4 paper must keep all six sections, 17 questions and 40 study sentences');
}

console.log(`Deployment verified: ${baseUrl} (${sectionPaths.length} categories, one complete CET4 paper)`);
