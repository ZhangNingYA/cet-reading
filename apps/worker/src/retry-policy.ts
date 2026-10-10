export const DEFAULT_MAX_ANALYSIS_ATTEMPTS = 3;

export function isRetryableAnalysisError(message: string) {
  return /AI request failed:\s*(?:stream|408|425|429|500|502|503|504|524)\b|fetch failed|AI response stream|timed? ?out/i.test(message);
}

export function retryDelaySeconds(attempt: number) {
  return Math.min(30, 2 ** Math.min(Math.max(1, attempt) - 1, 4));
}

export function shouldRetryAnalysis(attempt: number, retryable: boolean, maxAttempts: number) {
  return retryable && attempt < maxAttempts;
}
