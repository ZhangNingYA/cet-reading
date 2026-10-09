import 'dotenv/config';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { contextHash, validateAnalysis, type SentenceAnalysis } from '@cet-reading/contracts';
import { readConfig } from '@cet-reading/contracts/config';
import { ANALYSIS_BATCH_LOCK_ID } from '@cet-reading/contracts/analysis-jobs';
import { generateAnalysis } from './ai-analysis.js';

type Options = {
  paperId: string;
  dryRun: boolean;
  waitTimeoutSeconds: number;
};

type BatchSentence = {
  id: string;
  paper_id: string;
  source_text: string;
  source_hash: string;
  context_hash: string;
  context_json: { title: string; previousSentence: string | null; nextSentence: string | null };
  paragraph_index: number;
  sentence_index: number;
};

type CacheRow = {
  sentence_id: string;
  source_hash: string;
  context_hash: string;
  analysis_json: unknown;
};

const DEFAULT_WAIT_TIMEOUT_SECONDS = 300;

export function parseOptions(args: string[]): Options | null {
  if (args.includes('--help') || args.includes('-h')) return null;

  let paperId: string | undefined;
  let dryRun = false;
  let waitTimeoutSeconds = DEFAULT_WAIT_TIMEOUT_SECONDS;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--paper') {
      const value = args[++index];
      if (!value) throw new Error('--paper needs a published paper ID');
      if (paperId) throw new Error('Specify exactly one paper');
      paperId = value;
    } else if (arg === '--wait-timeout-seconds') {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 30 || value > 3600) {
        throw new Error('--wait-timeout-seconds must be an integer from 30 to 3600');
      }
      waitTimeoutSeconds = value;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      if (paperId) throw new Error('Specify exactly one paper');
      paperId = arg;
    }
  }
  if (!paperId) throw new Error('A paper ID is required');
  return { paperId, dryRun, waitTimeoutSeconds };
}

function printUsage() {
  process.stdout.write([
    'Usage: npm run analyze-paper --workspace apps/worker -- --paper <paper-id> [options]',
    '',
    'Options:',
    '  --dry-run                       Report sentence/cache counts without calling AI or pausing public requests',
    '  --wait-timeout-seconds <30-3600> Maximum time to let already-running public jobs finish (default: 300)',
    '  -h, --help                      Show this help',
    '',
    'Valid AI runs require AI_DRY_RUN=false, AI_API_URL, AI_API_KEY, and AI_MODEL.',
    'Valid cached sentences are skipped; rerunning safely resumes from the remaining sentences.',
  ].join('\n') + '\n');
}

async function loadPaperSentences(pool: Pool, paperId: string) {
  const result = await pool.query<Omit<BatchSentence, 'context_hash'>>(
    `WITH ordered AS (
       SELECT s.id, s.paper_id, s.source_text, s.source_hash,
              s.paragraph_index, s.sentence_index,
              COALESCE(p.title, '') AS title,
              lag(s.source_text) OVER w AS previous_sentence,
              lead(s.source_text) OVER w AS next_sentence
       FROM sentences s JOIN papers p ON p.id = s.paper_id
       WHERE s.paper_id = $1 AND p.status = 'published'
       WINDOW w AS (PARTITION BY s.paper_id ORDER BY s.paragraph_index, s.sentence_index)
     )
       SELECT id, paper_id, source_text, source_hash, paragraph_index, sentence_index,
            json_build_object('title', title, 'previousSentence', previous_sentence,
                              'nextSentence', next_sentence) AS context_json
     FROM ordered ORDER BY paragraph_index, sentence_index`,
    [paperId],
  );
  return result.rows;
}

// Compute context hashes in Node so the batch uses exactly the cache key used
// by normal sentence clicks.
function addContextHashes(sentences: Omit<BatchSentence, 'context_hash'>[]) {
  return sentences.map(sentence => ({
    ...sentence,
    context_hash: contextHash(sentence.context_json),
  }));
}

async function loadValidCaches(pool: Pool, sentences: BatchSentence[], config: ReturnType<typeof readConfig>) {
  if (!sentences.length) return new Map<string, SentenceAnalysis>();
  const result = await pool.query<CacheRow>(
    `SELECT sentence_id, source_hash, context_hash, analysis_json
     FROM sentence_analyses
     WHERE sentence_id = ANY($1::text[]) AND prompt_version = ANY($2::text[])
       AND model = $3 AND mode = $4 AND status = 'succeeded'
     ORDER BY (prompt_version = $5) DESC, updated_at DESC`,
    [sentences.map(sentence => sentence.id), config.cachePromptVersions, config.model, config.mode, config.promptVersion],
  );
  const byId = new Map(sentences.map(sentence => [sentence.id, sentence]));
  const cache = new Map<string, SentenceAnalysis>();
  for (const row of result.rows) {
    const sentence = byId.get(row.sentence_id);
    if (!sentence || cache.has(sentence.id) ||
        sentence.source_hash !== row.source_hash || sentence.context_hash !== row.context_hash) continue;
    try {
      cache.set(sentence.id, validateAnalysis(sentence.source_text, row.analysis_json));
    } catch {
      // Match the API's cache behavior: retain invalid history, but never skip it.
    }
  }
  return cache;
}

function emitSentence(index: number, total: number, sentence: BatchSentence, status: 'cached' | 'generated' | 'failed', error?: string) {
  process.stdout.write(`${JSON.stringify({
    event: 'paper_sentence', index, total, sentenceId: sentence.id,
    status, source: sentence.source_text, ...(error ? { error } : {}),
  })}\n`);
}

async function waitForRunningPublicJobs(pool: Pool, config: ReturnType<typeof readConfig>, timeoutSeconds: number) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastNotice = 0;
  while (true) {
    const result = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count FROM analysis_jobs
       WHERE mode = $1 AND model = $2 AND prompt_version = $3 AND status = 'running'
         AND COALESCE(lease_expires_at, NOW()) > NOW()`,
      [config.mode, config.model, config.promptVersion],
    );
    const count = result.rows[0]?.count ?? 0;
    if (!count) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${count} public AI job(s); no batch sentence was started`);
    }
    if (Date.now() - lastNotice >= 10_000) {
      process.stderr.write(`Waiting for ${count} already-running public AI job(s) to finish...\n`);
      lastNotice = Date.now();
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

async function saveAnalysis(
  pool: Pool,
  sentence: BatchSentence,
  analysis: SentenceAnalysis,
  config: ReturnType<typeof readConfig>,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO sentence_analyses
         (sentence_id, source_hash, context_hash, context_json, prompt_version,
          model, mode, analysis_json, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'succeeded')
       ON CONFLICT (sentence_id, source_hash, context_hash, prompt_version, model, mode)
       DO UPDATE SET analysis_json = EXCLUDED.analysis_json,
                     status = 'succeeded', updated_at = NOW()`,
      [sentence.id, sentence.source_hash, sentence.context_hash, JSON.stringify(sentence.context_json),
        config.promptVersion, config.model, config.mode, JSON.stringify(analysis)],
    );
    // A public click may have queued this exact sentence before the batch
    // acquired the gate. Reuse its job/poller result instead of charging twice.
    await client.query(
      `UPDATE analysis_jobs SET status = 'succeeded', error_message = NULL,
       lease_expires_at = NULL, finished_at = NOW(), updated_at = NOW()
       WHERE sentence_id = $1 AND source_hash = $2 AND context_hash = $3
         AND prompt_version = $4 AND model = $5 AND mode = $6 AND status = 'pending'`,
      [sentence.id, sentence.source_hash, sentence.context_hash,
        config.promptVersion, config.model, config.mode],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function getPublishedPaper(pool: Pool, paperId: string) {
  const result = await pool.query<{ id: string; title: string; exam_level: string; year: number; month: number; set_no: number }>(
    `SELECT id, title, exam_level, year, month, set_no
     FROM papers WHERE id = $1 AND status = 'published'`,
    [paperId],
  );
  return result.rows[0] ?? null;
}

async function run(options: Options) {
  const config = readConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  let lockClient: PoolClient | undefined;
  let locked = false;
  try {
    const paper = await getPublishedPaper(pool, options.paperId);
    if (!paper) throw new Error(`Published paper not found: ${options.paperId}`);
    const sentences = addContextHashes(await loadPaperSentences(pool, options.paperId));
    if (!sentences.length) throw new Error(`Published paper has no readable sentences: ${options.paperId}`);
    const cache = await loadValidCaches(pool, sentences, config);

    if (options.dryRun) {
      process.stdout.write(`${JSON.stringify({
        event: 'paper_plan', paper, total: sentences.length,
        cached: cache.size, remaining: sentences.length - cache.size,
        mode: config.mode, model: config.model,
      })}\n`);
      return;
    }

    if (config.mode !== 'ai') throw new Error('Real AI mode is required; set AI_DRY_RUN=false before running without --dry-run');
    if (!config.apiUrl || !config.apiKey) throw new Error('AI_API_URL and AI_API_KEY are required');

    lockClient = await pool.connect();
    const lock = await lockClient.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1::integer) AS locked',
      [ANALYSIS_BATCH_LOCK_ID],
    );
    if (!lock.rows[0]?.locked) throw new Error('Another analysis operation is active; no batch work was started');
    locked = true;
    process.stderr.write(`Public AI generation is paused while processing ${paper.id}; cached sentences will be skipped.\n`);

    await waitForRunningPublicJobs(pool, config, options.waitTimeoutSeconds);
    // Refresh after draining public jobs, so a just-finished click is reused.
    const refreshedCache = await loadValidCaches(pool, sentences, config);
    let generated = 0;
    let cached = 0;
    for (let index = 0; index < sentences.length; index += 1) {
      const sentence = sentences[index]!;
      if (refreshedCache.has(sentence.id)) {
        cached += 1;
        emitSentence(index + 1, sentences.length, sentence, 'cached');
        continue;
      }
      try {
        const analysis = await generateAnalysis({
          source_text: sentence.source_text,
          context_json: sentence.context_json,
        }, config);
        await saveAnalysis(pool, sentence, analysis, config);
        generated += 1;
        emitSentence(index + 1, sentences.length, sentence, 'generated');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitSentence(index + 1, sentences.length, sentence, 'failed', message);
        throw new Error(`Stopped after sentence ${index + 1}/${sentences.length} (${sentence.id}): ${message}`);
      }
    }
    process.stderr.write(`Completed ${paper.id}: ${generated} generated, ${cached} skipped from cache, ${sentences.length} total.\n`);
  } finally {
    if (locked && lockClient) {
      await lockClient.query('SELECT pg_advisory_unlock($1::integer)', [ANALYSIS_BATCH_LOCK_ID]).catch(() => undefined);
    }
    lockClient?.release();
    await pool.end();
  }
}

async function main() {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (!options) {
      printUsage();
      return;
    }
    await run(options);
  } catch (error) {
    process.stderr.write(`analyze-paper: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main();
}
