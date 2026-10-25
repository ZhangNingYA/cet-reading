import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { config } from './config.js';
import { pool } from './store.js';
import { ApprovalForbiddenError, ApprovalNotFoundError, ApprovalValidationError } from './approval-store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function completionTime(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw new ApprovalValidationError('请设置完成时间。');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) throw new ApprovalValidationError('请提供包含时区的完成时间。');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ApprovalValidationError('完成时间格式不正确。');
  return date.toISOString();
}

export async function requireFutureDeadline(client: PoolClient, value: string) {
  const result = await client.query('SELECT $1::timestamptz > clock_timestamp() AS future', [value]);
  if (!result.rows[0].future) throw new ApprovalValidationError('完成时间必须晚于当前时间。');
}

// The caller holds the request lock. Every action rechecks the database clock,
// so a late result cannot beat the background sweep or a concurrent date edit.
export async function finishExpiredApproval(client: PoolClient, requestId: string) {
  const result = await client.query(
    `SELECT id,status,executor_id,due_at FROM approval_requests WHERE id=$1
     AND status IN ('pending_approval','needs_supplement','approved','in_progress') AND due_at<=clock_timestamp() FOR UPDATE`, [requestId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const unapproved = ['pending_approval','needs_supplement'].includes(row.status);
  const status = unapproved ? 'expired' : 'overdue';
  await client.query('UPDATE approval_requests SET status=$2,updated_at=clock_timestamp() WHERE id=$1', [requestId, status]);
  await client.query("UPDATE approval_request_steps SET status='cancelled' WHERE request_id=$1 AND status='pending'", [requestId]);
  if (!unapproved) await client.query(
    `INSERT INTO approval_task_scores(request_id,executor_id,score,source) VALUES($1,$2,0,'overdue') ON CONFLICT(request_id) DO NOTHING`, [requestId, row.executor_id],
  );
  await client.query(
    `INSERT INTO approval_events(request_id,actor_id,event_type,from_status,to_status,payload_json)
     VALUES($1,NULL,$2,$3,$4,$5::jsonb)`,
    [requestId, unapproved ? 'request.expired' : 'request.overdue', row.status, status, JSON.stringify({ dueAt: row.due_at, ...(unapproved ? {} : { score: 0 }) })],
  );
  return status;
}

export async function expireApprovalDeadlines(requestId?: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const candidates = await client.query(
      `SELECT id FROM approval_requests WHERE status IN ('pending_approval','needs_supplement','approved','in_progress')
       AND due_at<=clock_timestamp() AND ($1::uuid IS NULL OR id=$1)
       ORDER BY due_at,id LIMIT 100 FOR UPDATE SKIP LOCKED`, [requestId || null],
    );
    for (const row of candidates.rows) await finishExpiredApproval(client, row.id);
    await client.query('COMMIT'); return candidates.rowCount || 0;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function changeApprovalDeadline(requestId: string, actorId: string, raw: unknown) {
  if (!UUID.test(requestId)) throw new ApprovalNotFoundError('审批不存在。');
  const dueAt = completionTime(raw);
  const client = await pool.connect(); let committed = false;
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT r.status,r.due_at FROM approval_requests r WHERE r.id=$1 AND EXISTS (
        SELECT 1 FROM approval_request_steps s WHERE s.request_id=r.id AND s.step_kind='approval' AND s.assignee_id=$2)
       FOR UPDATE`, [requestId, actorId],
    );
    const row = result.rows[0];
    if (!row) throw new ApprovalForbiddenError('只有审批人可以修改完成时间。');
    if (!['pending_approval','needs_supplement','approved','in_progress'].includes(row.status)) throw new ApprovalValidationError('当前状态不能修改完成时间。');
    if (await finishExpiredApproval(client, requestId)) {
      await client.query('COMMIT'); committed = true;
      throw new ApprovalValidationError('原完成时间已到期，不能再修改。');
    }
    await requireFutureDeadline(client, dueAt);
    await client.query('UPDATE approval_requests SET due_at=$2,updated_at=clock_timestamp() WHERE id=$1', [requestId, dueAt]);
    await client.query(
      `INSERT INTO approval_events(request_id,actor_id,event_type,from_status,to_status,payload_json)
       VALUES($1,$2,'request.deadline_changed',$3,$3,$4::jsonb)`,
      [requestId, actorId, row.status, JSON.stringify({ previousDueAt: row.due_at, dueAt })],
    );
    await client.query('COMMIT'); committed = true;
    return { dueAt };
  } catch (error) { if (!committed) await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

export function registerApprovalDeadlineWorker(app: FastifyInstance) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try { await expireApprovalDeadlines(); } catch { app.log.warn('Approval deadline sweep will retry'); }
    finally { running = false; }
  };
  app.addHook('onReady', async () => {
    if (process.env.NODE_ENV === 'test' || !config.approvalSessionSecret) return;
    timer = setInterval(() => { void sweep(); }, 30000); timer.unref(); void sweep();
  });
  app.addHook('onClose', async () => { if (timer) clearInterval(timer); });
}
