export type AnalysisErrorCode = 'timeout' | 'service_unavailable' | 'invalid_result' | 'generation_failed';

// The database retains technical errors; the public API only exposes safe categories.
export function analysisErrorCode(message: string | null): AnalysisErrorCode {
  if (/aborted|aborterror|timed? ?out|timeout/i.test(message ?? '')) return 'timeout';
  if (/AI request failed|fetch failed|AI response did not contain/i.test(message ?? '')) return 'service_unavailable';
  if (/Grammar|Vocabulary|Translation|AI word|word token|validation|"code"|JSON|Unexpected token/i.test(message ?? '')) return 'invalid_result';
  return 'generation_failed';
}

export function analysisErrorMessage(code: unknown): string {
  switch (code) {
    case 'timeout': return '这句精读生成超时，请重试。';
    case 'service_unavailable': return '精读服务暂时不可用，请稍后重试。';
    case 'invalid_result': return '精读结果未通过完整性检查，请重试。';
    default: return '暂时无法生成精读，请重试。';
  }
}
