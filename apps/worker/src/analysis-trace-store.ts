import { randomUUID } from 'node:crypto';
import type { AnalysisRequestTrace } from '@cet-reading/contracts/analysis-diagnostics';

type Queryable = { query: (sql: string, values: unknown[]) => Promise<unknown> };
export function createAnalysisTraceRecorder(db: Queryable, job: { id: string; attempts: number }) {
  const runId = randomUUID();
  return async (trace: AnalysisRequestTrace) => {
    await db.query(
      `INSERT INTO analysis_request_traces (id, job_id, run_id, worker_attempt, sent_at, trace_json)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (id) DO UPDATE SET trace_json=EXCLUDED.trace_json, sent_at=EXCLUDED.sent_at, updated_at=NOW()`,
      [trace.id, job.id, runId, job.attempts, trace.sentAt, JSON.stringify(trace)],
    );
  };
}
