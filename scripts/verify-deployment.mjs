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

await fetchWithRetry('/');
const papersResponse = await fetchWithRetry('/api/papers');
const papers = await papersResponse.json();
if (!Array.isArray(papers.papers)) {
  throw new Error('/api/papers returned an unexpected payload');
}

console.log(`Deployment verified: ${baseUrl} (${papers.papers.length} published papers)`);
