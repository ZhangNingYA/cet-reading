import type { PoolClient } from 'pg';
import { pool } from './store.js';
import { approvalPhotos, approvalPhotoSummaries, bindApprovalAvatar, bindApprovalPhotos, uploadApprovalMedia, validateMediaIds } from './approval-media.js';
import { listApprovalFriends, requireApprovalFriends } from './approval-friends.js';
import { completionTime, requireFutureDeadline, expireApprovalDeadlines, finishExpiredApproval } from './approval-deadlines.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ApprovalValidationError extends Error {}
export class ApprovalNotFoundError extends Error {}
export class ApprovalForbiddenError extends Error {}

export type ApprovalUser = {
  id: string;
  openid: string;
  displayName: string;
  avatarUrl: string | null;
  friendCode: string;
  status: 'active' | 'disabled';
};

function text(value: unknown, field: string, max: number, required = false) {
  if (value == null || value === '') {
    if (required) throw new ApprovalValidationError(`${field}不能为空。`);
    return '';
  }
  if (typeof value !== 'string') throw new ApprovalValidationError(`${field}格式不正确。`);
  const result = value.trim();
  if (required && !result) throw new ApprovalValidationError(`${field}不能为空。`);
  if (result.length > max) throw new ApprovalValidationError(`${field}不能超过${max}个字符。`);
  return result;
}

function dateOnly(value: unknown) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new ApprovalValidationError('scheduledFor格式不正确。');
  }
  return value;
}

function iso(value: Date | string | null | undefined) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function mapUser(row: { id: string; openid: string; display_name: string; avatar_url: string | null; friend_code: string; status: 'active' | 'disabled' }): ApprovalUser {
  return { id: row.id, openid: row.openid, displayName: row.display_name, avatarUrl: row.avatar_url, friendCode: row.friend_code, status: row.status };
}

export async function findApprovalUserByOpenid(openid: string) {
  const result = await pool.query<{ id: string; openid: string; display_name: string; avatar_url: string | null; friend_code: string; status: 'active' | 'disabled' }>(
    `SELECT id, openid, display_name, avatar_url, friend_code, status FROM approval_users WHERE openid = $1`, [openid],
  );
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function findApprovalUserById(id: string) {
  if (!UUID_RE.test(id)) return null;
  const result = await pool.query<{ id: string; openid: string; display_name: string; avatar_url: string | null; friend_code: string; status: 'active' | 'disabled' }>(
    `SELECT id, openid, display_name, avatar_url, friend_code, status FROM approval_users WHERE id = $1`, [id],
  );
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function upsertApprovalUser(input: { openid: string; unionid?: string | null; displayName?: string; avatarUrl?: string | null }) {
  const openid = text(input.openid, 'openid', 200, true);
  const displayName = text(input.displayName, 'displayName', 80) || '微信用户';
  const avatarUrl = text(input.avatarUrl, 'avatarUrl', 1000) || null;
  const unionid = text(input.unionid, 'unionid', 200) || null;
  const result = await pool.query<{ id: string; openid: string; display_name: string; avatar_url: string | null; friend_code: string; status: 'active' | 'disabled' }>(
    `INSERT INTO approval_users (openid, unionid, display_name, avatar_url, last_login_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (openid) DO UPDATE SET
       unionid = COALESCE(EXCLUDED.unionid, approval_users.unionid),
       display_name = CASE WHEN EXCLUDED.display_name = '微信用户' THEN approval_users.display_name ELSE EXCLUDED.display_name END,
       avatar_url = COALESCE(EXCLUDED.avatar_url, approval_users.avatar_url),
       last_login_at = NOW(), updated_at = NOW()
     RETURNING id, openid, display_name, avatar_url, friend_code, status`,
    [openid, unionid, displayName, avatarUrl],
  );
  return mapUser(result.rows[0]);
}

export async function listApprovalPeople(userId: string, query = '') {
  return listApprovalFriends(userId, query);
}

export async function listApprovalTemplates(ownerId: string, includeInactive = false) {
  const result = await pool.query(
    `SELECT id, name, kind, description, schedule_json, active, created_at, updated_at
     FROM approval_templates WHERE owner_id=$1 AND ($2::boolean OR active=true)
     ORDER BY updated_at DESC, id DESC`, [ownerId, includeInactive],
  );
  return result.rows.map(row => ({
    id: row.id, name: row.name, kind: row.kind, description: row.description,
    schedule: row.schedule_json, active: row.active, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  }));
}

export async function createApprovalTemplate(ownerId: string, raw: unknown) {
  if (!raw || typeof raw !== 'object') throw new ApprovalValidationError('模板内容不正确。');
  const body = raw as Record<string, unknown>;
  const name = text(body.name, 'name', 120, true);
  const description = text(body.description, 'description', 2000);
  if (body.kind !== 'daily') throw new ApprovalValidationError('当前只支持daily模板。');
  const schedule = body.schedule && typeof body.schedule === 'object' && !Array.isArray(body.schedule) ? body.schedule : {};
  const result = await pool.query<{ id: string }>(
    `INSERT INTO approval_templates (owner_id, name, kind, description, schedule_json)
     VALUES ($1, $2, 'daily', $3, $4::jsonb) RETURNING id`,
    [ownerId, name, description, JSON.stringify(schedule)],
  );
  return { id: result.rows[0].id, name, kind: 'daily', description, schedule };
}

export async function updateApprovalTemplate(ownerId: string, id: string, raw: unknown) {
  if (!UUID_RE.test(id)) throw new ApprovalNotFoundError('模板不存在。');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApprovalValidationError('模板内容不正确。');
  const body = raw as Record<string, unknown>;
  const name = body.name === undefined ? null : text(body.name, 'name', 120, true);
  const description = body.description === undefined ? null : text(body.description, 'description', 2000);
  if (body.active !== undefined && typeof body.active !== 'boolean') throw new ApprovalValidationError('active必须为布尔值。');
  if (name === null && description === null && body.active === undefined) throw new ApprovalValidationError('没有可更新的模板内容。');
  const result = await pool.query(
    `UPDATE approval_templates SET name=COALESCE($3, name), description=COALESCE($4, description),
       active=COALESCE($5, active), updated_at=NOW()
     WHERE id=$1 AND owner_id=$2
     RETURNING id, name, kind, description, schedule_json, active, created_at, updated_at`,
    [id, ownerId, name, description, body.active ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new ApprovalNotFoundError('模板不存在或无权修改。');
  return {
    id: row.id, name: row.name, kind: row.kind, description: row.description,
    schedule: row.schedule_json, active: row.active, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function decodeAvatar(value: unknown) {
  if (typeof value !== 'string' || value.length > 349528 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new ApprovalValidationError('头像格式不正确或超过256KB。');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.length > 262144) throw new ApprovalValidationError('头像不能超过256KB。');
  let contentType = '';
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) contentType = 'image/png';
  else if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) contentType = 'image/jpeg';
  else if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') contentType = 'image/webp';
  if (!contentType) throw new ApprovalValidationError('头像仅支持PNG、JPG或WebP图片。');
  return { bytes, contentType };
}

export async function updateApprovalProfile(userId: string, raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApprovalValidationError('资料内容不正确。');
  const body = raw as Record<string, unknown>;
  const displayName = text(body.displayName, '昵称', 80, true);
  if (body.avatarBase64 !== undefined && body.avatarMediaId !== undefined) throw new ApprovalValidationError('请仅提交一个头像。');
  // Keep older clients compatible while all new image bytes go to Blob.
  const legacyAvatar = body.avatarBase64 === undefined ? null : decodeAvatar(body.avatarBase64);
  const mediaId = legacyAvatar ? (await uploadApprovalMedia(userId, 'avatar', legacyAvatar.bytes)).id : body.avatarMediaId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize concurrent avatar changes before locking the selected media.
    await client.query('SELECT id FROM approval_users WHERE id=$1 FOR UPDATE', [userId]);
    const avatarId = mediaId === undefined ? null : await bindApprovalAvatar(client, userId, mediaId);
    const result = await client.query(
      `UPDATE approval_users SET display_name=$2, updated_at=NOW(),
         avatar_url=CASE WHEN $3::uuid IS NOT NULL THEN $4 ELSE avatar_url END,
         avatar_media_id=COALESCE($3::uuid, avatar_media_id)
       WHERE id=$1 AND status='active' RETURNING id, display_name, avatar_url, friend_code`,
      [userId, displayName, avatarId, `/api/approval/avatars/${userId}?v=${avatarId}`],
    );
    const row = result.rows[0];
    if (!row) throw new ApprovalNotFoundError('用户不存在或已停用。');
    if (avatarId) await client.query('DELETE FROM approval_user_avatars WHERE user_id=$1', [userId]);
    await client.query('COMMIT');
    return { id: row.id, displayName: row.display_name, avatarUrl: row.avatar_url, friendCode: row.friend_code };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function getApprovalAvatar(userId: string) {
  if (!UUID_RE.test(userId)) return null;
  const result = await pool.query<{ content_type: string; image_bytes: Buffer }>(
    `SELECT a.content_type, a.image_bytes FROM approval_user_avatars a
     JOIN approval_users u ON u.id=a.user_id WHERE a.user_id=$1 AND u.status='active'`, [userId],
  );
  return result.rows[0] ?? null;
}

export type ApprovalHistoryQuery = { view?: string; status?: string; q?: string; cursor?: string; limit?: string };

export async function listApprovalHistory(userId: string, query: ApprovalHistoryQuery = {}) {
  const view = query.view || 'all';
  const status = query.status || 'all';
  const search = text(query.q, 'q', 120);
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!['all', 'sent', 'handled', 'pending', 'executing'].includes(view)) throw new ApprovalValidationError('记录分类不正确。');
  if (!['all', 'draft', 'pending_approval', 'rejected', 'needs_supplement', 'approved', 'in_progress', 'pending_review', 'completed', 'cancelled', 'expired', 'overdue'].includes(status)) {
    throw new ApprovalValidationError('审批状态不正确。');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ApprovalValidationError('每页数量必须为1到50。');
  let beforeTime: string | null = null;
  let beforeId: string | null = null;
  if (query.cursor) {
    try {
      if (!/^[A-Za-z0-9_-]{1,512}$/.test(query.cursor)) throw new Error('invalid cursor');
      const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (!cursor || typeof cursor.time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(cursor.time) || !Number.isFinite(Date.parse(cursor.time)) || typeof cursor.id !== 'string' || !UUID_RE.test(cursor.id)) {
        throw new Error('invalid cursor');
      }
      beforeTime = cursor.time;
      beforeId = cursor.id;
    } catch { throw new ApprovalValidationError('分页参数不正确。'); }
  }
  const result = await pool.query(
    `SELECT r.id, r.kind, r.status, r.title, r.body, r.result_body, r.updated_at,
       to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,
       applicant.display_name AS applicant_name,
       CASE WHEN r.applicant_id=$1 THEN 'applicant' WHEN r.executor_id=$1 THEN 'executor' ELSE 'assignee' END AS role
     FROM approval_requests r JOIN approval_users applicant ON applicant.id=r.applicant_id
     WHERE (r.applicant_id=$1 OR r.executor_id=$1 OR EXISTS (SELECT 1 FROM approval_request_steps s WHERE s.request_id=r.id AND s.assignee_id=$1))
       AND ($2='all' OR ($2='sent' AND r.applicant_id=$1)
         OR ($2='executing' AND r.executor_id=$1)
         OR ($2='handled' AND EXISTS (SELECT 1 FROM approval_request_steps s WHERE s.request_id=r.id AND s.assignee_id=$1 AND s.status IN ('approved','rejected','completed','returned')))
         OR ($2='pending' AND EXISTS (SELECT 1 FROM approval_request_steps s WHERE s.request_id=r.id AND s.assignee_id=$1 AND s.status='pending')))
       AND ($3='all' OR r.status=$3) AND ($4='' OR r.title ILIKE '%' || $4 || '%')
       AND ($5::timestamptz IS NULL OR (r.updated_at, r.id) < ($5::timestamptz, $6::uuid))
     ORDER BY r.updated_at DESC, r.id DESC LIMIT $7`,
    [userId, view, status, search, beforeTime, beforeId, limit + 1],
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const last = rows[rows.length - 1];
  const summaries = await approvalPhotoSummaries(rows.map(row => row.id), userId);
  return {
    requests: rows.map(row => ({
      id: row.id, kind: row.kind, status: row.status, title: row.title, body: row.body,
      resultBody: row.result_body, updatedAt: iso(row.updated_at), applicantName: row.applicant_name, role: row.role,
      ...(summaries.get(row.id) || { photoCount: 0, thumbnailUrl: '' }),
    })),
    hasMore,
    nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ time: last.cursor_time, id: last.id })).toString('base64url') : null,
  };
}

async function resolveAssignee(body: Record<string, unknown>) {
  const id = typeof body.approverId === 'string' ? body.approverId.trim() : '';
  const openid = typeof body.approverOpenid === 'string' ? body.approverOpenid.trim() : '';
  if (!id && !openid) throw new ApprovalValidationError('请指定审批人。');
  const user = id ? await findApprovalUserById(id) : await findApprovalUserByOpenid(openid);
  if (!user || user.status !== 'active') throw new ApprovalValidationError('审批人不存在或已停用。');
  return user;
}

export async function createApprovalRequest(applicantId: string, raw: unknown) {
  if (!raw || typeof raw !== 'object') throw new ApprovalValidationError('请求内容不正确。');
  const body = raw as Record<string, unknown>;
  const title = text(body.title, 'title', 120, true);
  const requestBody = text(body.body, 'body', 20000);
  const photoIds = validateMediaIds(body.photoIds);
  const kind = body.kind === 'daily' ? 'daily' : body.kind === 'ad_hoc' ? 'ad_hoc' : null;
  if (!kind) throw new ApprovalValidationError('kind必须是daily或ad_hoc。');
  const templateId = body.templateId == null || body.templateId === '' ? null : text(body.templateId, 'templateId', 80, true);
  const scheduledFor = dateOnly(body.scheduledFor);
  if (kind === 'daily' && (!templateId || !scheduledFor)) throw new ApprovalValidationError('daily审批需要templateId和scheduledFor。');
  if (templateId && !UUID_RE.test(templateId)) throw new ApprovalValidationError('templateId格式不正确。');
  if (kind === 'daily') {
    const template = await pool.query<{ kind: string }>(
      `SELECT kind FROM approval_templates WHERE id=$1 AND owner_id=$2 AND active=true`, [templateId, applicantId],
    );
    if (template.rows[0]?.kind !== 'daily') throw new ApprovalValidationError('daily模板不存在或不属于当前用户。');
  }
  const dueAt = completionTime(body.dueAt);
  const assignee = await resolveAssignee(body);
  const executorId = body.executorId === undefined ? applicantId : text(body.executorId, '执行人', 80, true);
  if (!UUID_RE.test(executorId)) throw new ApprovalValidationError('请选择有效的执行人。');
  if (assignee.id === applicantId) throw new ApprovalValidationError('审批人必须选择好友。');
  if (assignee.id === executorId) throw new ApprovalValidationError('执行人和审批人请选择不同的人。');
  const client = await pool.connect();
  let requestId = '';
  try {
    await client.query('BEGIN');
    await requireApprovalFriends(client, applicantId, [executorId, assignee.id]);
    await requireFutureDeadline(client, dueAt);
    const request = await client.query<{ id: string }>(
      `INSERT INTO approval_requests (template_id, applicant_id, kind, status, title, body, scheduled_for, due_at, executor_id)
       VALUES ($1, $2, $3, 'pending_approval', $4, $5, $6, $7, $8) RETURNING id`,
      [templateId, applicantId, kind, title, requestBody, scheduledFor, dueAt, executorId],
    );
    requestId = request.rows[0].id;
    await client.query(
      `INSERT INTO approval_request_steps (request_id, position, step_kind, assignee_id)
       VALUES ($1, 1, 'approval', $2)`, [requestId, assignee.id],
    );
    const createdEvent = await client.query<{id:string}>(
      `INSERT INTO approval_events (request_id, actor_id, event_type, to_status, payload_json)
       VALUES ($1, $2, 'request.created', 'pending_approval', $3::jsonb) RETURNING id`,
      [requestId, applicantId, JSON.stringify({ assigneeId: assignee.id, executorId, kind, body: requestBody })],
    );
    await bindApprovalPhotos(client, requestId, applicantId, 'application', photoIds, createdEvent.rows[0].id);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if ((error as { code?: string }).code === '23505') throw new ApprovalValidationError('今天的daily审批已经提交过了。');
    throw error;
  } finally {
    client.release();
  }
  return getApprovalRequest(requestId, applicantId);
}

export async function listApprovalRequests(userId: string, view = 'all') {
  const safeView = ['all', 'pending', 'sent', 'execution', 'supplement'].includes(view) ? view : 'all';
  const result = await pool.query(
    `SELECT r.id, r.kind, r.status, r.title, r.body, r.result_body, r.scheduled_for, r.due_at,
            r.created_at, r.updated_at, applicant.display_name AS applicant_name,
            CASE WHEN r.applicant_id = $1 THEN 'applicant' WHEN r.executor_id=$1 THEN 'executor' ELSE 'assignee' END AS role,
            (SELECT u.display_name FROM approval_request_steps s JOIN approval_users u ON u.id=s.assignee_id
             WHERE s.request_id=r.id AND s.step_kind='approval' ORDER BY s.position LIMIT 1) AS approver_name
     FROM approval_requests r JOIN approval_users applicant ON applicant.id=r.applicant_id
     WHERE (r.applicant_id=$1 OR r.executor_id=$1 OR EXISTS (SELECT 1 FROM approval_request_steps s WHERE s.request_id=r.id AND s.assignee_id=$1))
       AND ($2='all' OR ($2='sent' AND r.applicant_id=$1) OR ($2='supplement' AND r.applicant_id=$1 AND r.status='needs_supplement') OR ($2='execution' AND r.executor_id=$1 AND r.status IN ('approved','in_progress')) OR ($2='pending' AND EXISTS (
         SELECT 1 FROM approval_request_steps ps WHERE ps.request_id=r.id AND ps.assignee_id=$1 AND ps.status='pending'
       )))
     ORDER BY r.updated_at DESC LIMIT 50`, [userId, safeView],
  );
  const summaries = await approvalPhotoSummaries(result.rows.map(row => row.id), userId);
  return result.rows.map(row => ({
    id: row.id, kind: row.kind, status: row.status, title: row.title, body: row.body,
    resultBody: row.result_body, scheduledFor: row.scheduled_for, dueAt: iso(row.due_at),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), applicantName: row.applicant_name,
    approverName: row.approver_name, role: row.role,
    ...(summaries.get(row.id) || { photoCount: 0, thumbnailUrl: '' }),
  }));
}

export async function getApprovalRequest(id: string, userId: string) {
  if (!UUID_RE.test(id)) throw new ApprovalNotFoundError('审批不存在。');
  const result = await pool.query(
    `SELECT r.id, r.applicant_id, r.kind, r.status, r.title, r.body, r.result_body, r.scheduled_for, r.due_at,
            r.created_at, r.updated_at, r.approved_at, r.result_submitted_at, r.reviewed_at,
            applicant.display_name AS applicant_name,
            COALESCE((SELECT json_agg(json_build_object(
              'id', s.id, 'position', s.position, 'kind', s.step_kind, 'status', s.status,
              'assigneeId', s.assignee_id, 'assigneeName', u.display_name, 'comment', s.comment,
              'score', s.score, 'actedAt', s.acted_at, 'assigneeAvatarUrl', u.avatar_url
            ) ORDER BY s.position) FROM approval_request_steps s JOIN approval_users u ON u.id=s.assignee_id
             WHERE s.request_id=r.id), '[]'::json) AS steps,
            applicant.avatar_url AS applicant_avatar_url, r.executor_id,
            executor.display_name AS executor_name, executor.avatar_url AS executor_avatar_url,
            (SELECT score FROM approval_task_scores WHERE request_id=r.id) AS final_score,
            (SELECT source FROM approval_task_scores WHERE request_id=r.id) AS score_source
     FROM approval_requests r JOIN approval_users applicant ON applicant.id=r.applicant_id
     JOIN approval_users executor ON executor.id=r.executor_id
     WHERE r.id=$1 AND (r.applicant_id=$2 OR r.executor_id=$2 OR EXISTS (SELECT 1 FROM approval_request_steps s WHERE s.request_id=r.id AND s.assignee_id=$2))`,
    [id, userId],
  );
  const row = result.rows[0];
  if (!row) throw new ApprovalNotFoundError('审批不存在或无权查看。');
  if (['pending_approval','needs_supplement','approved','in_progress'].includes(row.status) && row.due_at && new Date(row.due_at).getTime() <= Date.now() && await expireApprovalDeadlines(id)) return getApprovalRequest(id, userId);
  const steps = row.steps as Array<{ kind: string; assigneeId: string; status: string }>;
  const photos = await approvalPhotos(id, userId);
  // Only load the activity log after the participant check above succeeds.
  const activity = await pool.query(
    `SELECT e.id, e.event_type, e.from_status, e.to_status, e.payload_json, e.created_at,
       u.id AS actor_id, u.display_name AS actor_name, u.avatar_url AS actor_avatar_url
     FROM approval_events e LEFT JOIN approval_users u ON u.id=e.actor_id
     WHERE e.request_id=$1
     ORDER BY e.created_at, CASE e.event_type
       WHEN 'request.created' THEN 0 WHEN 'request.approved' THEN 1
       WHEN 'request.rejected' THEN 1 WHEN 'request.rejectd' THEN 1
       WHEN 'request.result_submitted' THEN 2 WHEN 'request.reviewed' THEN 3 ELSE 4 END, e.id`, [id],
  );
  return {
    id: row.id, kind: row.kind, status: row.status, title: row.title, body: row.body,
    resultBody: row.result_body, scheduledFor: row.scheduled_for, dueAt: iso(row.due_at),
    approvedAt: iso(row.approved_at), resultSubmittedAt: iso(row.result_submitted_at), reviewedAt: iso(row.reviewed_at),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), applicantName: row.applicant_name,
    applicantId: row.applicant_id, applicantAvatarUrl: row.applicant_avatar_url,
    executorId: row.executor_id, executorName: row.executor_name, executorAvatarUrl: row.executor_avatar_url,
    finalScore: row.final_score, scoreSource: row.score_source,
    steps: row.steps,
    events: activity.rows.map(event => ({
      id: event.id, type: event.event_type, createdAt: iso(event.created_at),
      actor: event.actor_id ? { id: event.actor_id, displayName: event.actor_name, avatarUrl: event.actor_avatar_url } : null,
      system: !event.actor_id,
      fromStatus: event.from_status, toStatus: event.to_status,
      comment: typeof event.payload_json.comment === 'string' ? event.payload_json.comment : '',
      score: typeof event.payload_json.score === 'number' ? event.payload_json.score : null,
      body: typeof event.payload_json.body === 'string' ? event.payload_json.body : undefined,
      dueAt: event.payload_json.dueAt || undefined, previousDueAt: event.payload_json.previousDueAt || undefined,
    })),
    photos,
    actions: {
      canApprove: row.status === 'pending_approval' && steps.some(step => step.kind === 'approval' && step.assigneeId === userId && step.status === 'pending'),
      canSubmitResult: ['approved', 'in_progress'].includes(row.status) && row.executor_id === userId,
      canSupplement: row.status === 'needs_supplement' && row.applicant_id === userId,
      canEditDeadline: ['pending_approval','needs_supplement','approved','in_progress'].includes(row.status) && steps.some(step => step.kind === 'approval' && step.assigneeId === userId),
      canReview: row.status === 'pending_review' && steps.some(step => step.kind === 'review' && step.assigneeId === userId && step.status === 'pending'),
    },
  };
}

async function appendEvent(client: PoolClient, requestId: string, actorId: string, eventType: string, fromStatus: string | null, toStatus: string | null, payload: unknown = {}) {
  const result = await client.query<{id:string}>(
    `INSERT INTO approval_events (request_id, actor_id, event_type, from_status, to_status, payload_json)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
    [requestId, actorId, eventType, fromStatus, toStatus, JSON.stringify(payload)],
  );
  return result.rows[0].id;
}

export async function decideApprovalRequest(requestId: string, actorId: string, action: unknown, rawComment: unknown) {
  if (!UUID_RE.test(requestId)) throw new ApprovalNotFoundError('审批不存在。');
  if (action !== 'approve' && action !== 'reject') throw new ApprovalValidationError('action必须是approve或reject。');
  const comment = text(rawComment, 'comment', 4000);
  if (action === 'reject' && !comment) throw new ApprovalValidationError('请说明需要补充的材料。');
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const result = await client.query<{ step_id: string; request_id: string; request_status: string }>(
      `SELECT s.id AS step_id, r.id AS request_id, r.status AS request_status
       FROM approval_request_steps s JOIN approval_requests r ON r.id=s.request_id
       WHERE s.request_id=$1 AND s.assignee_id=$2 AND s.step_kind='approval' AND s.status='pending'
       FOR UPDATE OF r`, [requestId, actorId],
    );
    const row = result.rows[0];
    if (!row) throw new ApprovalForbiddenError('当前用户不是该审批的待处理审批人。');
    if (row.request_status !== 'pending_approval') throw new ApprovalValidationError('该审批当前不能处理。');
    if (await finishExpiredApproval(client, requestId)) {
      await client.query('COMMIT'); committed = true;
      throw new ApprovalValidationError('申请已到期，不能继续审批。');
    }
    const nextStatus = action === 'approve' ? 'approved' : 'needs_supplement';
    await client.query(
      `UPDATE approval_request_steps SET status=$2, comment=$3, acted_at=NOW() WHERE id=$1`,
      [row.step_id, action === 'approve' ? 'approved' : 'rejected', comment],
    );
    await client.query(
      `UPDATE approval_requests SET status=$2, approved_at=CASE WHEN $2='approved' THEN NOW() ELSE NULL END, updated_at=NOW() WHERE id=$1`,
      [requestId, nextStatus],
    );
    await appendEvent(client, requestId, actorId, action === 'approve' ? 'request.approved' : 'request.rejected', 'pending_approval', nextStatus, { comment });
    await client.query('COMMIT');
    committed = true;
  } catch (error) {
    if (!committed) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
  return getApprovalRequest(requestId, actorId);
}

export async function submitApprovalResult(requestId: string, actorId: string, rawBody: unknown, rawPhotoIds?: unknown) {
  if (!UUID_RE.test(requestId)) throw new ApprovalNotFoundError('审批不存在。');
  const resultBody = text(rawBody, 'resultBody', 20000);
  const photoIds = validateMediaIds(rawPhotoIds);
  if (!resultBody && !photoIds.length) throw new ApprovalValidationError('请填写执行结果或添加照片。');
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const result = await client.query<{ status: string; approver_id: string }>(
      `SELECT r.status, (SELECT assignee_id FROM approval_request_steps WHERE request_id=r.id AND step_kind='approval' ORDER BY position LIMIT 1) AS approver_id
       FROM approval_requests r WHERE r.id=$1 AND r.executor_id=$2 FOR UPDATE`, [requestId, actorId],
    );
    const row = result.rows[0];
    if (!row) throw new ApprovalForbiddenError('只有指定的执行人可以提交执行结果。');
    if (!['approved', 'in_progress'].includes(row.status)) throw new ApprovalValidationError('该审批当前不能提交结果。');
    if (await finishExpiredApproval(client, requestId)) {
      await client.query('COMMIT'); committed = true;
      throw new ApprovalValidationError('已超过完成时间，执行人自动记0分。');
    }
    const eventId = await appendEvent(client, requestId, actorId, 'request.result_submitted', row.status, 'pending_review', { body: resultBody });
    await bindApprovalPhotos(client, requestId, actorId, 'result', photoIds, eventId);
    await client.query(`UPDATE approval_requests SET result_body=$2, status='pending_review', result_submitted_at=NOW(), updated_at=NOW() WHERE id=$1`, [requestId, resultBody]);
    await client.query(
      `INSERT INTO approval_request_steps (request_id, position, step_kind, assignee_id)
       SELECT $1, COALESCE(MAX(position), 0) + 1, 'review', $2 FROM approval_request_steps WHERE request_id=$1`,
      [requestId, row.approver_id],
    );
    await client.query('COMMIT');
    committed = true;
  } catch (error) {
    if (!committed) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
  return getApprovalRequest(requestId, actorId);
}

export async function reviewApprovalRequest(requestId: string, actorId: string, rawScore: unknown, rawComment: unknown) {
  if (!UUID_RE.test(requestId)) throw new ApprovalNotFoundError('审批不存在。');
  const score = Number(rawScore);
  if ((typeof rawScore !== 'number' && typeof rawScore !== 'string') || String(rawScore).trim() === '') throw new ApprovalValidationError('请填写0到100分。');
  if (!Number.isInteger(score) || score < 0 || score > 100) throw new ApprovalValidationError('score必须是0到100之间的整数。');
  const comment = text(rawComment, 'comment', 4000, true);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{ step_id: string; executor_id: string; status: string }>(
      `SELECT s.id AS step_id, r.executor_id, r.status
       FROM approval_request_steps s JOIN approval_requests r ON r.id=s.request_id
       WHERE s.request_id=$1 AND s.assignee_id=$2 AND s.step_kind='review' AND s.status='pending'
       FOR UPDATE OF r`, [requestId, actorId],
    );
    const row = result.rows[0];
    if (!row) throw new ApprovalForbiddenError('当前用户不是该审批的待点评人。');
    if (row.status !== 'pending_review') throw new ApprovalValidationError('该审批当前不能点评。');
    await client.query(`UPDATE approval_request_steps SET status='completed', score=$2, comment=$3, acted_at=NOW() WHERE id=$1`, [row.step_id, score, comment]);
    await client.query(`UPDATE approval_requests SET status='completed', reviewed_at=NOW(), updated_at=NOW() WHERE id=$1`, [requestId]);
    await client.query("INSERT INTO approval_task_scores(request_id,executor_id,score,source,reviewer_id) VALUES($1,$2,$3,'manual',$4)", [requestId,row.executor_id,score,actorId]);
    await appendEvent(client, requestId, actorId, 'request.reviewed', 'pending_review', 'completed', { score, comment });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
  return getApprovalRequest(requestId, actorId);
}

export async function supplementApprovalRequest(requestId: string, actorId: string, raw: unknown) {
  if (!UUID_RE.test(requestId)) throw new ApprovalNotFoundError('审批不存在。');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApprovalValidationError('补充材料格式不正确。');
  const body = raw as Record<string, unknown>;
  const content = text(body.body, '补充说明', 20000);
  const photoIds = validateMediaIds(body.photoIds);
  if (!content && !photoIds.length) throw new ApprovalValidationError('请补充说明或照片。');
  const client = await pool.connect(); let committed = false;
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT r.status,(SELECT assignee_id FROM approval_request_steps WHERE request_id=r.id AND step_kind='approval' ORDER BY position DESC LIMIT 1) AS approver_id
       FROM approval_requests r WHERE id=$1 AND applicant_id=$2 FOR UPDATE`, [requestId,actorId],
    );
    const row = result.rows[0];
    if (!row) throw new ApprovalForbiddenError('只有申请人可以补充申请材料。');
    if (row.status !== 'needs_supplement') throw new ApprovalValidationError('当前状态不能补充申请。');
    if (await finishExpiredApproval(client,requestId)) {
      await client.query('COMMIT'); committed=true;
      throw new ApprovalValidationError('申请已到期，请联系审批人确认。');
    }
    const eventId = await appendEvent(client,requestId,actorId,'request.supplemented',row.status,'pending_approval',{body:content});
    await bindApprovalPhotos(client,requestId,actorId,'application',photoIds,eventId);
    await client.query("UPDATE approval_requests SET status='pending_approval',updated_at=clock_timestamp() WHERE id=$1",[requestId]);
    await client.query(
      `INSERT INTO approval_request_steps(request_id,position,step_kind,assignee_id)
       SELECT $1,COALESCE(MAX(position),0)+1,'approval',$2 FROM approval_request_steps WHERE request_id=$1`,[requestId,row.approver_id],
    );
    await client.query('COMMIT'); committed=true;
  } catch(error) {if(!committed) await client.query('ROLLBACK').catch(()=>undefined);throw error;}
  finally {client.release();}
  return getApprovalRequest(requestId,actorId);
}

export async function getApprovalDashboard(userId: string) {
  const [counts, pending, recent, scores, pendingExecution, pendingSupplement] = await Promise.all([
    pool.query<{ pending_approval: number; pending_review: number; completed: number; sent: number; pending_execution: number; friend_requests: number; pending_supplement: number; average_score: number | null }>(
      `SELECT
       (SELECT COUNT(*)::integer FROM approval_request_steps WHERE assignee_id=$1 AND step_kind='approval' AND status='pending') AS pending_approval,
       (SELECT COUNT(*)::integer FROM approval_request_steps WHERE assignee_id=$1 AND step_kind='review' AND status='pending') AS pending_review,
       (SELECT COUNT(*)::integer FROM approval_requests WHERE executor_id=$1 AND status='completed') AS completed,
       (SELECT COUNT(*)::integer FROM approval_requests WHERE executor_id=$1 AND status IN ('approved','in_progress')) AS pending_execution,
       (SELECT COUNT(*)::integer FROM approval_requests WHERE applicant_id=$1 AND status='needs_supplement') AS pending_supplement,
       (SELECT ROUND(AVG(score))::int FROM approval_task_scores WHERE executor_id=$1) AS average_score,
       (SELECT COUNT(*)::integer FROM approval_friend_requests WHERE recipient_id=$1 AND status='pending') AS friend_requests,
       (SELECT COUNT(*)::integer FROM approval_requests WHERE applicant_id=$1) AS sent`, [userId],
    ),
    listApprovalRequests(userId, 'pending'),
    listApprovalRequests(userId, 'sent'),
    pool.query(`SELECT score_date, score FROM approval_daily_score_summary WHERE user_id=$1 ORDER BY score_date DESC LIMIT 14`, [userId]),
    listApprovalRequests(userId, 'execution'),
    listApprovalRequests(userId, 'supplement'),
  ]);
  const pendingApproval = pending.filter(item => item.status === 'pending_approval');
  const pendingReview = pending.filter(item => item.status === 'pending_review');
  return {
    stats: {
      pendingApproval: Number(counts.rows[0]?.pending_approval ?? 0),
      pendingExecution: Number(counts.rows[0]?.pending_execution ?? 0),
      pendingSupplement: Number(counts.rows[0]?.pending_supplement ?? 0),
      averageScore: counts.rows[0]?.average_score ?? null,
      friendRequests: Number(counts.rows[0]?.friend_requests ?? 0),
      sent: Number(counts.rows[0]?.sent ?? 0),
      pendingReview: Number(counts.rows[0]?.pending_review ?? 0),
      completed: Number(counts.rows[0]?.completed ?? 0),
    },
    pendingApproval,
    pendingReview,
    pendingExecution,
    pendingSupplement,
    recent: recent.slice(0, 10),
    dailyScores: scores.rows.map(row => ({ date: row.score_date, score: row.score })),
  };
}

