import 'dotenv/config';
import { Pool, type PoolClient } from 'pg';
import { SentenceAnalysisSchema, type SentenceAnalysis } from '@cet-reading/contracts';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://cet_reading:cet_reading@localhost:5432/cet_reading',
});
const promptVersion = process.env.PROMPT_VERSION ?? 'cet-reading-v1';
const model = process.env.AI_MODEL ?? 'unset';
const dryRun = process.env.AI_DRY_RUN !== 'false';

type Job = {
  id: string;
  sentence_id: string;
  source_hash: string;
  source_text: string;
  previous_sentence: string | null;
  next_sentence: string | null;
};

async function claimJob(): Promise<Job | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<Job>(
      `WITH ordered AS (
         SELECT s.id AS sentence_id, s.paper_id, s.source_text,
                lag(s.source_text) OVER w AS previous_sentence,
                lead(s.source_text) OVER w AS next_sentence
         FROM sentences s
         WINDOW w AS (PARTITION BY s.paper_id ORDER BY s.paragraph_index, s.sentence_index)
       )
       SELECT j.id, j.sentence_id, j.source_hash, o.source_text,
              o.previous_sentence, o.next_sentence
       FROM analysis_jobs j
       JOIN ordered o ON o.sentence_id = j.sentence_id
       WHERE j.status = 'pending'
       ORDER BY j.created_at
       FOR UPDATE OF j SKIP LOCKED
       LIMIT 1`,
    );
    const job = result.rows[0];
    if (!job) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query(
      `UPDATE analysis_jobs SET status = 'running', started_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [job.id],
    );
    await client.query('COMMIT');
    return job;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function demoAnalysis(source: string): SentenceAnalysis {
  const parts = source.match(/[A-Za-z]+|[^A-Za-z\s]/g) ?? [source];
  return SentenceAnalysisSchema.parse({
    translation: `（演示）${source}`,
    pattern: '待 AI 分析',
    grammar: {
      sentenceType: '待分析',
      clauses: [],
    },
    tokens: parts.map((text, index) => ({
      index,
      text,
      kind: /^[A-Za-z]+$/.test(text) ? 'word' : 'punctuation',
      lemma: /^[A-Za-z]+$/.test(text) ? text.toLowerCase() : undefined,
      clickable: /^[A-Za-z]+$/.test(text),
    })),
    keyPoints: ['当前使用演示模式，配置 AI 后会替换为真实精读。'],
  });
}

function parseModelJson(content: string): SentenceAnalysis {
  const cleaned = content.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
  return SentenceAnalysisSchema.parse(JSON.parse(cleaned));
}

async function generateAnalysis(job: Job): Promise<SentenceAnalysis> {
  if (dryRun) return demoAnalysis(job.source_text);

  const apiUrl = process.env.AI_API_URL;
  const apiKey = process.env.AI_API_KEY;
  if (!apiUrl || !apiKey || !process.env.AI_MODEL) {
    throw new Error('AI_API_URL, AI_API_KEY and AI_MODEL are required when AI_DRY_RUN=false');
  }

  const response = await fetch(`${apiUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.AI_MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: '你是英语四六级精读老师。只返回符合要求的 JSON，不要返回 Markdown。',
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: '分析当前句子的翻译、句型、语法结构和可点击单词。结构范围使用 token index。',
            sentence: job.source_text,
            previousSentence: job.previous_sentence,
            nextSentence: job.next_sentence,
          }),
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`AI request failed: ${response.status}`);
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI response did not contain JSON content');
  return parseModelJson(content);
}

async function processJob(job: Job) {
  const client: PoolClient = await pool.connect();
  try {
    const analysis = await generateAnalysis(job);
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO sentence_analyses
         (sentence_id, source_hash, prompt_version, model, analysis_json, status)
       VALUES ($1, $2, $3, $4, $5, 'succeeded')
       ON CONFLICT (sentence_id, source_hash, prompt_version, model)
       DO UPDATE SET analysis_json = EXCLUDED.analysis_json,
                     status = 'succeeded', updated_at = NOW()`,
      [job.sentence_id, job.source_hash, promptVersion, model, JSON.stringify(analysis)],
    );
    await client.query(
      `UPDATE analysis_jobs SET status = 'succeeded', finished_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [job.id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.query(
      `UPDATE analysis_jobs SET status = 'failed', error_message = $2, finished_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [job.id, error instanceof Error ? error.message : String(error)],
    );
  } finally {
    client.release();
  }
}

async function main() {
  process.stdout.write(`Worker started (${dryRun ? 'dry-run' : model})\n`);
  while (true) {
    const job = await claimJob();
    if (job) {
      await processJob(job);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exitCode = 1;
});
