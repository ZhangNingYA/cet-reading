import { buildAnalysis, tokenize, type SentenceAnalysis } from '@cet-reading/contracts';
import type { RuntimeConfig } from '@cet-reading/contracts/config';

type AnalysisInput = {
  source_text: string;
  context_json: { title: string; previousSentence: string | null; nextSentence: string | null };
};
type AIConfig = Pick<RuntimeConfig, 'apiUrl' | 'apiKey' | 'model' | 'requestTimeoutMs'>;

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

export async function generateAnalysis(job: AnalysisInput, config: AIConfig): Promise<SentenceAnalysis> {
  if (!config.apiUrl || !config.apiKey) throw new Error('AI_API_URL and AI_API_KEY are required in AI mode');
  const controller = new AbortController();
  let requestAttempt = 0;
  // Both the initial answer and one validation repair share the original deadline/lease.
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const messages = [
    { role: 'system', content: '你是英语四六级精读老师。结合具体原文解释语法，不使用空泛的占位说明。只返回符合要求的 JSON。' },
    { role: 'user', content: buildPrompt(job) },
  ];
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      requestAttempt = attempt + 1;
      const response = await fetch(`${config.apiUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, temperature: 0.1, response_format: { type: 'json_object' }, messages }),
      });
      if (!response.ok) throw new Error(`AI request failed: ${response.status}`);
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new Error('AI response did not contain JSON content');
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
