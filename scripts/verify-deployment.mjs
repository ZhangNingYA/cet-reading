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

console.log(`Deployment verified: ${baseUrl} (${sectionPaths.length} sections, ${papers.papers.length} published papers)`);
