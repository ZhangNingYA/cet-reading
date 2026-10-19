export type AnalysisRequestTrace = {
  id: string;
  round: number;
  transportAttempt: number;
  purpose: 'initial' | 'repair';
  model: string;
  sentAt: string;
  responseAt: string | null;
  firstContentAt: string | null;
  completedAt: string | null;
  validatedAt: string | null;
  httpStatus: number | null;
  providerRequestId: string | null;
  requestText: string;
  requestTruncated: boolean;
  responseText: string;
  responseBody: string;
  responseChars: number;
  responseTruncated: boolean;
  responseKind: 'model_content' | 'upstream_error' | 'invalid_response';
  finishReason: string | null;
  errorMessage: string | null;
  validationStatus: 'pending' | 'passed' | 'failed' | 'not_run';
  validationError: string | null;
  validationIssues: Array<{ path: string; message: string }>;
};

export type StoredAnalysisRequest = AnalysisRequestTrace & { workerAttempt: number; runId: string };
export type AdminJobDetail = {
  id: string; status: string; type: 'sentence' | 'text' | 'question'; attempts: number;
  model: string; promptVersion: string; mode: string;
  source: string; context: { title?: string; previousSentence?: string | null; nextSentence?: string | null };
  question: { prompt?: string; options?: Array<{ key: string; text: string }>; paragraphs?: string[]; instructions?: string } | null;
  title: string; paperId: string | null; articleId: string | null; examLevel: string | null;
  errorMessage: string | null;
  createdAt: string | null; startedAt: string | null; finishedAt: string | null; updatedAt: string | null;
  requests: StoredAnalysisRequest[]; requestsHasMore: boolean;
};

export function explainAnalysisFailure(message: string | null): string {
  if (!message) return '暂无错误信息。';
  const range = message.match(/Grammar range \[(\d+), (\d+)\).*?(\d+) source tokens/);
  if (range) return range[1] === range[2]
    ? `AI 返回的语法范围起止位置都是 ${range[1]}，没有选中任何原文词，因此无法保存这份解析。`
    : `AI 返回的语法范围 [${range[1]}, ${range[2]}) 超出原文的 ${range[3]} 个 token，或只覆盖标点，没有有效原文词。`;
  if (/Vocabulary must match/.test(message)) return 'AI 的词汇标注与原文不匹配：单词必须覆盖一个原文词，短语至少覆盖两个。下方列出具体错误和 AI 返回，便于核对。';
  if (/Vocabulary ranges/.test(message)) return 'AI 的词汇标注范围越界、重叠或顺序错误，无法对应原文。';
  if (/placeholder/.test(message)) return 'AI 使用了笼统的占位解释，没有说明这句原文的实际语法关系。';
  if (/word token|AI word|Token count/.test(message)) return 'AI 的逐词解析存在遗漏、重复或索引不匹配，未覆盖要求的原文词。';
  if (/timed? ?out|timeout|aborted/i.test(message)) return '模型请求超过生成期限或连接被中止。请结合每次请求的时间和部分返回内容核对。';
  if (/AI request failed: (\d+)/.test(message)) return `上游服务返回 HTTP ${message.match(/AI request failed: (\d+)/)?.[1]}。可在请求记录中查看服务的实际错误返回。`;
  if (/stream.*ended|stream.*event/i.test(message)) return '上游响应流提前结束或格式异常，未收到完整回答。已收到的部分内容会保留在请求记录中。';
  if (/fetch failed|ECONN|ENOTFOUND|socket/i.test(message)) return '请求未能正常连接上游服务，或连接被重置。请核对请求记录中的网络错误。';
  if (/JSON|Unexpected token|"code"/.test(message)) return 'AI 返回内容不符合要求的数据格式。可对照原始返回与具体字段错误查看原因。';
  if (/Question analysis/.test(message)) return 'AI 的做题解析未通过答案、选项或原文证据校验，具体不一致之处见下方错误。';
  return '本次处理未成功，具体错误与模型请求记录如下。';
}
