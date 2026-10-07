import 'dotenv/config';
import { Pool, type PoolClient } from 'pg';
import {
  AIAnalysisSchema,
  buildAnalysis,
  tokenize,
  type AIAnalysis,
  type SentenceAnalysis,
} from '@cet-reading/contracts';
import { readConfig } from '@cet-reading/contracts/config';

const config = readConfig();
const pool = new Pool({ connectionString: config.databaseUrl });

type Job = {
  id: string;
  attempts: number;
  sentence_id: string;
  source_text: string;
  source_hash: string;
  context_hash: string;
  context_json: { title: string; previousSentence: string | null; nextSentence: string | null };
};

async function claimJob(): Promise<Job | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<Job>(
      `WITH candidate AS (
         SELECT id FROM analysis_jobs
         WHERE mode = $1 AND model = $2 AND prompt_version = $3
           AND (status = 'pending' OR (status = 'running' AND lease_expires_at < NOW()))
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE analysis_jobs j
       SET status = 'running', attempts = j.attempts + 1,
           started_at = COALESCE(j.started_at, NOW()),
           lease_expires_at = NOW() + ($4 * INTERVAL '1 second'), updated_at = NOW()
       FROM candidate c
       WHERE j.id = c.id
       RETURNING j.id, j.attempts, j.sentence_id, j.source_text, j.source_hash,
                 j.context_hash, j.context_json`,
      [config.mode, config.model, config.promptVersion, config.leaseSeconds],
    );
    const job = result.rows[0] ?? null;
    await client.query(job ? 'COMMIT' : 'ROLLBACK');
    return job;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function demoRaw(source: string): AIAnalysis {
  const tokens = tokenize(source);
  const words = tokens.filter((token) => token.kind === 'word');
  return AIAnalysisSchema.parse({
    translation: source.startsWith('Although')
      ? '虽然这个计划成本很高，但它还是成功了。'
      : '这个结果鼓励团队继续开展研究。',
    pattern: source.startsWith('Although') ? 'Although + 让步状语从句，主句' : '主语 + 谓语 + 宾语 + 不定式补语',
    grammar: {
      sentenceType: source.startsWith('Although') ? '复合句' : '简单句',
      tense: '一般过去时',
      voice: '主动语态',
      clauses: [{ tokenStart: 0, tokenEnd: tokens.length, type: '主句', explanation: '句子主要成分' }],
      components: [
        { tokenStart: 0, tokenEnd: Math.min(2, tokens.length), role: 'subject', explanation: '主语部分' },
        { tokenStart: Math.min(2, tokens.length - 1), tokenEnd: tokens.length, role: 'predicate', explanation: '谓语及其补充成分' },
      ],
    },
    words: words.map((word) => ({
      index: word.index,
      lemma: word.text.toLowerCase(),
      pos: '词汇',
      contextMeaning: word.text.toLowerCase() === 'although' ? '虽然，尽管' : '演示语境释义',
    })),
    vocabulary: [],
    keyPoints: ['当前为演示模式；接入真实 AI 后会替换为正式精读。'],
  });
}

function parseModelJson(content: string): unknown {
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(cleaned);
}

function buildPrompt(job: Job) {
  const tokens = tokenize(job.source_text);
  return JSON.stringify({
    task: '做英语四六级逐句精读。翻译必须自然准确；解释句型、时态、语态、主干和从句，并提取重点单词和词组。',
    output: {
      translation: '中文翻译，不能重复英文原句，不能包含错误提示',
      pattern: '简洁句型公式',
      grammar: {
        sentenceType: '句子类型', tense: '时态', voice: '语态',
        clauses: [{ tokenStart: 0, tokenEnd: 1, type: '从句类型', explanation: '作用' }],
        components: [{ tokenStart: 0, tokenEnd: 1, role: 'subject', explanation: '成分作用' }],
      },
      words: [{ index: 0, lemma: '原形', pos: '词性', contextMeaning: '当前语境含义' }],
      vocabulary: [{
        kind: 'word',
        expression: '原文重点单词',
        meaning: '当前语境中的中文含义',
        usage: '一句简短的中文用法说明',
        ranges: [{ tokenStart: 0, tokenEnd: 1 }],
      }, {
        kind: 'phrase',
        expression: '原文词组或搭配公式，如 attribute … to …',
        meaning: '当前语境中的中文含义',
        usage: '一句简短的中文用法说明',
        ranges: [{ tokenStart: 0, tokenEnd: 2 }],
      }],
      keyPoints: ['学习要点'],
    },
    rules: [
      'words 必须覆盖每一个 word token，index 必须来自 token skeleton；不要解释标点。',
      'tokenStart 包含，tokenEnd 不包含；所有范围必须在 token skeleton 内。',
      'grammar 的 components 和 clauses 必须对应原文中实际存在的非空范围：0 <= tokenStart < tokenEnd <= tokenSkeleton.length。',
      '祈使句省略的主语或其他隐含成分只在 explanation 或 keyPoints 中说明，不得虚构 token，不得返回 tokenStart=tokenEnd 的空范围。',
      'vocabulary 同时考虑重点单词和词组：较难的单词、熟词生义、考试常见用法、固定搭配和容易误解的表达。只收录本句值得学的内容，最多 6 项；没有时返回 []，不要凑数或重复列出所有单词。',
      'kind=word 对应一个原文 word token，kind=phrase 至少对应两个。meaning 和 usage 用中文，结合当前语境，简短说明搭配、词形或用法。',
      'ranges 按原文顺序排列且不重叠，可用多个范围表示被宾语隔开的搭配；只引用当前句子，不要把整句作为一个词组。',
      '只返回 JSON，不要 Markdown，不要增加字段。',
    ],
    sentence: job.source_text,
    context: job.context_json,
    tokenSkeleton: tokens,
  });
}

async function requestAI(job: Job): Promise<SentenceAnalysis> {
  if (config.mode === 'demo') return buildAnalysis(job.source_text, demoRaw(job.source_text));
  if (!config.apiUrl || !config.apiKey) throw new Error('AI_API_URL and AI_API_KEY are required in AI mode');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(`${config.apiUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model, temperature: 0.1, response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: '你是英语四六级精读老师。只返回符合要求的 JSON。' },
          { role: 'user', content: buildPrompt(job) },
        ],
      }),
    });
    if (!response.ok) throw new Error(`AI request failed: ${response.status}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error('AI response did not contain JSON content');
    return buildAnalysis(job.source_text, parseModelJson(content));
  } finally {
    clearTimeout(timeout);
  }
}

async function processJob(job: Job) {
  const client: PoolClient = await pool.connect();
  try {
    const analysis = await requestAI(job);
    await client.query('BEGIN');
    const finished = await client.query(
      `UPDATE analysis_jobs SET status = 'succeeded', error_message = NULL,
       lease_expires_at = NULL, finished_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND attempts = $2 AND status = 'running' RETURNING id`,
      [job.id, job.attempts],
    );
    // A worker whose lease was reclaimed must not overwrite a newer result.
    if (!finished.rowCount) { await client.query('ROLLBACK'); return; }
    await client.query(
      `INSERT INTO sentence_analyses
         (sentence_id, source_hash, context_hash, context_json, prompt_version,
          model, mode, analysis_json, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'succeeded')
       ON CONFLICT (sentence_id, source_hash, context_hash, prompt_version, model, mode)
       DO UPDATE SET analysis_json = EXCLUDED.analysis_json,
                     status = 'succeeded', updated_at = NOW()`,
      [job.sentence_id, job.source_hash, job.context_hash, JSON.stringify(job.context_json),
        config.promptVersion, config.model, config.mode, JSON.stringify(analysis)],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.query(
      `UPDATE analysis_jobs SET status = 'failed', error_message = $2,
       lease_expires_at = NULL, finished_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND attempts = $3 AND status = 'running'`,
      [job.id, error instanceof Error ? error.message : String(error), job.attempts],
    );
  } finally {
    client.release();
  }
}

async function main() {
  process.stdout.write(`Worker started (${config.mode}, ${config.model})\n`);
  while (true) {
    const job = await claimJob();
    if (job) await processJob(job);
    else await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exitCode = 1;
});
