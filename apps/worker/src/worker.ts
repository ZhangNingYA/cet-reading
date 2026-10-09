import 'dotenv/config';
import { Pool, type PoolClient } from 'pg';
import {
  AIAnalysisSchema,
  buildAnalysis,
  tokenize,
  type AIAnalysis,
} from '@cet-reading/contracts';
import { readConfig } from '@cet-reading/contracts/config';
import { generateAnalysis } from './ai-analysis.js';
import { analysisErrorCode } from '@cet-reading/contracts/analysis-jobs';
import { runJobQueue } from './job-queue.js';

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
  created_at: Date;
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
                 j.context_hash, j.context_json, j.created_at`,
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
      clauses: [{ tokenStart: 0, tokenEnd: tokens.length, type: '主句', explanation: '演示结果：整句作为主句展示，接入 AI 后按原句分析。' }],
      components: [
        { tokenStart: 0, tokenEnd: Math.min(2, tokens.length), role: 'subject', explanation: '演示范围：前两个词暂作为主语展示。' },
        { tokenStart: Math.min(2, tokens.length - 1), tokenEnd: tokens.length, role: 'predicate', explanation: '演示范围：后续词暂作为谓语及补充成分展示。' },
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

async function processJob(job: Job) {
  const startedAt = Date.now();
  const client: PoolClient = await pool.connect();
  try {
    const analysis = config.mode === 'demo'
      ? buildAnalysis(job.source_text, demoRaw(job.source_text))
      : await generateAnalysis(job, config);
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
    console.log(JSON.stringify({
      event: 'analysis_succeeded', jobId: job.id, sentenceId: job.sentence_id,
      attempt: job.attempts, queueMs: startedAt - job.created_at.getTime(),
      durationMs: Date.now() - startedAt,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      event: 'analysis_failed', jobId: job.id, sentenceId: job.sentence_id,
      attempt: job.attempts, errorCode: analysisErrorCode(message),
      durationMs: Date.now() - startedAt,
      modelRequest: message.match(/model request (\d+)/)?.[1] ?? null,
    }));
    await client.query('ROLLBACK').catch(() => undefined);
    await client.query(
      `UPDATE analysis_jobs SET status = 'failed', error_message = $2,
       lease_expires_at = NULL, finished_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND attempts = $3 AND status = 'running'`,
      [job.id, message, job.attempts],
    );
  } finally {
    client.release();
  }
}

async function main() {
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.stdout.write(`Worker started (${config.mode}, ${config.model}, concurrency=${config.workerConcurrency})\n`);
  try {
    await runJobQueue({ claim: claimJob, process: processJob, concurrency: config.workerConcurrency, signal: shutdown.signal });
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
