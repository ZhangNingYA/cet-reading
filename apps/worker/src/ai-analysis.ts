import { buildAnalysis, tokenize, type SentenceAnalysis } from '@cet-reading/contracts';
import type { RuntimeConfig } from '@cet-reading/contracts/config';

type AnalysisInput = {
  source_text: string;
  context_json: { title: string; previousSentence: string | null; nextSentence: string | null };
};
type AIConfig = Pick<RuntimeConfig, 'apiUrl' | 'apiKey' | 'model' | 'requestTimeoutMs'>;

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 524]);
const MAX_TRANSPORT_ATTEMPTS = 5;
// The upstream provider may keep an overloaded account in a short cooldown.
// A small backoff prevents the next attempt from immediately colliding with it.
const RETRY_BASE_DELAY_MS = 2000;

class AIRequestError extends Error {
  constructor(message: string, readonly retryable = false, readonly retryAfterMs?: number | null) {
    super(message);
    this.name = 'AIRequestError';
  }
}

function buildPrompt(job: AnalysisInput) {
  return JSON.stringify({
    task: '做英语四六级逐句精读。翻译必须自然准确；根据原文解释句型、时态、语态、主干和从句，并提取重点单词和词组。',
    output: {
      translation: '中文翻译，不能重复英文原句，不能包含错误提示',
      pattern: '本句使用的具体句型公式及中文用法',
      grammar: {
        sentenceType: '句子类型', tense: '时态', voice: '语态',
        clauses: [{ tokenStart: 0, tokenEnd: 1, type: '主句或具体从句类型', explanation: '引用本句英文，解释该分句表达什么，以及它与其他成分的关系' }],
        components: [{ tokenStart: 0, tokenEnd: 1, role: 'subject', explanation: '引用本句英文，解释它为什么属于该成分、中心词及修饰关系' }],
      },
      words: [{ index: 0, lemma: '原形', pos: '词性', contextMeaning: '当前语境含义' }],
      vocabulary: [{
        kind: 'word', expression: '原文重点单词', meaning: '当前语境中的中文含义',
        usage: '一句简短的中文用法说明', ranges: [{ tokenStart: 0, tokenEnd: 1 }],
      }, {
        kind: 'phrase', expression: '原文词组或搭配公式，如 attribute … to …',
        meaning: '当前语境中的中文含义', usage: '一句简短的中文用法说明',
        ranges: [{ tokenStart: 0, tokenEnd: 2 }],
      }],
      keyPoints: ['与本句有关的学习要点'],
    },
    rules: [
      'words 必须覆盖每一个 word token，index 必须来自 tokenSkeleton；不要解释标点。',
      'tokenStart 包含，tokenEnd 不包含；所有范围必须在 tokenSkeleton 内。',
      'grammar.clauses 和 grammar.components 都必须非空。简单句也要在 clauses 中分析主句；没有从句不等于没有主句。复合句先分析主句，再逐一分析实际存在的从句及其作用。',
      '每个 explanation 必须结合所选范围的具体英文，说明中心词、成分作用或主从关系。禁止只写“句子主要成分”“句子主干”“主语部分”“作用”这类标签，也不要照抄 output 中的字段说明。',
      'components 分别分析实际存在的主语、谓语、宾语、补语、修饰语和连接成分，role 使用 subject/predicate/object/complement/modifier/connector。谓语范围应对应动词或动词短语，宾语单独分析，不要把剩下的整句笼统标成谓语。',
      '语法范围必须包含实际英文词：0 <= tokenStart < tokenEnd <= tokenSkeleton.length。祈使句省略的主语或其他隐含成分只在 explanation 或 keyPoints 中说明，不得虚构 token 或返回空范围。句子片段应明确说明缺少哪些成分，不能虚构完整主谓结构。',
      'vocabulary 同时考虑重点单词和词组：较难的单词、熟词生义、考试常见用法、固定搭配和容易误解的表达。只收录本句值得学的内容，最多 6 项；没有时返回 []，不要凑数或重复列出所有单词。',
      'kind=word 对应一个原文 word token，kind=phrase 至少对应两个。meaning 和 usage 用中文，结合当前语境，简短说明搭配、词形或用法。',
      'ranges 按原文顺序排列且不重叠，可用多个范围表示被宾语隔开的搭配；只引用当前句子，不要把整句作为一个词组。',
      '只返回完整 JSON，不要 Markdown，不要增加字段。',
    ],
    sentence: job.source_text,
    context: job.context_json,
    tokenSkeleton: tokenize(job.source_text),
  });
}

function parseModelJson(content: string): unknown {
  return JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());
}

function getRetryAfterMs(response: Response): number | null {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function readStreamingContent(response: Response): Promise<string> {
  if (!response.body) throw new AIRequestError('AI response stream had no body', true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventData: string[] = [];
  let content = '';
  let sawDone = false;
  let sawFinish = false;

  const dispatch = (payload: string) => {
    if (!payload) return;
    if (payload === '[DONE]') {
      sawDone = true;
      return;
    }
    let event: { error?: { code?: string; message?: string }; choices?: Array<{ delta?: { content?: string }; message?: { content?: string }; text?: string; finish_reason?: string | null }> };
    try {
      event = JSON.parse(payload) as typeof event;
    } catch {
      throw new AIRequestError('AI response stream contained an invalid event', false);
    }
    if (event.error) {
      const code = event.error.code ? ` (${event.error.code})` : '';
      throw new AIRequestError(`AI request failed: stream${code}`, true);
    }
    const choice = event.choices?.[0];
    const piece = choice?.delta?.content ?? choice?.message?.content ?? choice?.text;
    if (piece) content += piece;
    if (choice?.finish_reason) {
      sawFinish = true;
      if (choice.finish_reason !== 'stop') {
        throw new AIRequestError('AI response stream ended before completion', true);
      }
    }
  };

  const consumeLines = (flush = false) => {
    const lines = buffer.split(/\r?\n/);
    buffer = flush ? '' : (lines.pop() ?? '');
    for (const line of lines) {
      if (line === '') {
        dispatch(eventData.join('\n'));
        eventData = [];
      } else if (line.startsWith('data:')) {
        eventData.push(line.slice(5).trimStart());
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      consumeLines();
    }
    buffer += decoder.decode();
    if (buffer) buffer += '\n';
    consumeLines(true);
    dispatch(eventData.join('\n'));
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (!sawDone && !sawFinish) throw new AIRequestError('AI response stream ended before completion', true);
  if (!content) throw new AIRequestError('AI response did not contain JSON content');
  return content;
}

async function readCompletionContent(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('text/event-stream')) return readStreamingContent(response);
  try {
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new AIRequestError('AI response did not contain JSON content');
    return content;
  } catch (error) {
    if (error instanceof AIRequestError) throw error;
    throw new AIRequestError('AI response was not valid JSON', true);
  }
}

async function requestCompletion(
  url: string,
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  controller: AbortController,
  deadline: number,
): Promise<string> {
  let lastError: unknown;
  for (let transportAttempt = 1; transportAttempt <= MAX_TRANSPORT_ATTEMPTS; transportAttempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model, temperature: 0.1, response_format: { type: 'json_object' }, stream: true, messages,
        }),
      });
      if (!response.ok) {
        // Consume the body before retrying so the connection can be reused and the
        // provider's transient error does not become a misleading parse/repair error.
        await response.text().catch(() => undefined);
        throw new AIRequestError(
          `AI request failed: ${response.status}`,
          TRANSIENT_HTTP_STATUSES.has(response.status),
          getRetryAfterMs(response),
        );
      }
      return await readCompletionContent(response);
    } catch (error) {
      if (controller.signal.aborted) throw error;
      const retryable = error instanceof AIRequestError ? error.retryable : true;
      lastError = error;
      if (!retryable || transportAttempt === MAX_TRANSPORT_ATTEMPTS) throw error;
      const remaining = deadline - Date.now();
      const requestedDelay = error instanceof AIRequestError && error.retryAfterMs != null
        ? error.retryAfterMs
        : RETRY_BASE_DELAY_MS * (2 ** (transportAttempt - 1));
      const delay = Math.min(requestedDelay, 3000, Math.max(0, remaining - 50));
      if (remaining <= delay + 50) throw error;
      await waitForRetry(delay, controller.signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('AI request failed');
}

export async function generateAnalysis(job: AnalysisInput, config: AIConfig): Promise<SentenceAnalysis> {
  if (!config.apiUrl || !config.apiKey) throw new Error('AI_API_URL and AI_API_KEY are required in AI mode');
  const controller = new AbortController();
  let requestAttempt = 0;
  const deadline = Date.now() + config.requestTimeoutMs;
  // Both the initial answer and one validation repair share the original deadline/lease.
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const messages = [
    { role: 'system', content: '你是英语四六级精读老师。结合具体原文解释语法，不使用空泛的占位说明。只返回符合要求的 JSON。' },
    { role: 'user', content: buildPrompt(job) },
  ];
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      requestAttempt = attempt + 1;
      const content = await requestCompletion(
        `${config.apiUrl.replace(/\/$/, '')}/chat/completions`, config.apiKey, config.model,
        messages, controller, deadline,
      );
      try {
        return buildAnalysis(job.source_text, parseModelJson(content));
      } catch (error) {
        if (attempt === 1) throw error;
        const reason = error instanceof Error ? error.message.slice(0, 1500) : '结果未通过校验';
        messages.push({ role: 'assistant', content }, {
          role: 'user',
          content: `上次结果未通过校验：${reason}。请修正并重新返回完整 JSON。grammar.clauses 和 components 都不得为空；简单句也要说明主句，用本句具体英文解释成分和关系。保留每个 word token 的释义及正确范围，禁止使用占位说明。`,
        });
      }
    }
    throw new Error('AI analysis did not pass validation');
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`AI analysis timed out during model request ${requestAttempt}`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
