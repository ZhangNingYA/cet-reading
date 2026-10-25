import type { PoolClient } from 'pg';
import { pool } from './store.js';
import { ApprovalForbiddenError, ApprovalNotFoundError, ApprovalValidationError } from './approval-store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type PersonRow = { id: string; display_name: string; avatar_url: string | null; friend_code: string; remark?: string };
function person(row: PersonRow) { return { id: row.id, displayName: row.display_name, avatarUrl: row.avatar_url, friendCode: row.friend_code, remark: row.remark || '' }; }
function code(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Fa-f0-9]{12}$/.test(value.trim())) throw new ApprovalValidationError('请输入12位好友编号。');
  return value.trim().toUpperCase();
}
async function pairLock(client: PoolClient, a: string, b: string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [[a, b].sort().join(':')]);
}
async function blocked(client: PoolClient, a: string, b: string) {
  const rows = await client.query("SELECT 1 FROM approval_friendships WHERE ((owner_id=$1 AND friend_id=$2) OR (owner_id=$2 AND friend_id=$1)) AND status='blocked'", [a, b]);
  if (rows.rowCount) throw new ApprovalForbiddenError('当前不能添加该用户。');
}

export async function listApprovalFriends(ownerId: string, query = '') {
  if (typeof query !== 'string' || query.length > 80) throw new ApprovalValidationError('搜索内容过长。');
  const result = await pool.query<PersonRow>(
    `SELECT u.id,u.display_name,u.avatar_url,u.friend_code,f.remark FROM approval_friendships f
     JOIN approval_users u ON u.id=f.friend_id AND u.status='active'
     WHERE f.owner_id=$1 AND f.status='accepted' AND ($2='' OR u.display_name ILIKE '%'||$2||'%' OR f.remark ILIKE '%'||$2||'%')
     ORDER BY COALESCE(NULLIF(f.remark,''),u.display_name),u.id`, [ownerId, query.trim()],
  );
  return result.rows.map(person);
}

export async function lookupApprovalFriend(ownerId: string, rawCode: unknown) {
  const result = await pool.query<PersonRow>('SELECT id,display_name,avatar_url,friend_code FROM approval_users WHERE friend_code=$1 AND status=\'active\'', [code(rawCode)]);
  const target = result.rows[0];
  if (!target) throw new ApprovalNotFoundError('没有找到该用户，请确认好友编号。');
  if (target.id === ownerId) return { person: person(target), relationship: 'self' };
  const relation = await pool.query('SELECT status FROM approval_friendships WHERE (owner_id=$1 AND friend_id=$2) OR (owner_id=$2 AND friend_id=$1)', [ownerId, target.id]);
  if (relation.rows.some(row => row.status === 'blocked')) throw new ApprovalNotFoundError('没有找到该用户。');
  if (relation.rows.some(row => row.status === 'accepted')) return { person: person(target), relationship: 'friend' };
  const pending = await pool.query("SELECT requester_id FROM approval_friend_requests WHERE status='pending' AND ((requester_id=$1 AND recipient_id=$2) OR (requester_id=$2 AND recipient_id=$1))", [ownerId, target.id]);
  return { person: person(target), relationship: pending.rows[0] ? pending.rows[0].requester_id === ownerId ? 'outgoing' : 'incoming' : 'none' };
}

export async function sendApprovalFriendRequest(ownerId: string, raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApprovalValidationError('申请内容不正确。');
  const body = raw as Record<string, unknown>;
  const targetCode = code(body.code);
  if (body.message !== undefined && (typeof body.message !== 'string' || body.message.length > 200)) throw new ApprovalValidationError('申请说明不能超过200字。');
  const target = await pool.query<{ id: string }>("SELECT id FROM approval_users WHERE friend_code=$1 AND status='active'", [targetCode]);
  const targetId = target.rows[0]?.id;
  if (!targetId) throw new ApprovalNotFoundError('没有找到该用户。');
  if (targetId === ownerId) throw new ApprovalValidationError('不能添加自己为好友。');
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await pairLock(client, ownerId, targetId); await blocked(client, ownerId, targetId);
    const accepted = await client.query("SELECT 1 FROM approval_friendships WHERE owner_id=$1 AND friend_id=$2 AND status='accepted'", [ownerId, targetId]);
    if (accepted.rowCount) throw new ApprovalValidationError('对方已经是你的好友。');
    const active = await client.query("SELECT id,requester_id FROM approval_friend_requests WHERE status='pending' AND ((requester_id=$1 AND recipient_id=$2) OR (requester_id=$2 AND recipient_id=$1))", [ownerId, targetId]);
    if (active.rowCount) {
      if (active.rows[0].requester_id !== ownerId) throw new ApprovalValidationError('对方已向你发出申请，请到好友申请中处理。');
      await client.query('COMMIT'); return { id: active.rows[0].id, status: 'pending' };
    }
    const result = await client.query("INSERT INTO approval_friend_requests(requester_id,recipient_id,message) VALUES($1,$2,$3) RETURNING id,status", [ownerId, targetId, typeof body.message === 'string' ? body.message.trim() : '']);
    await client.query('COMMIT'); return result.rows[0];
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function listApprovalFriendRequests(ownerId: string) {
  const result = await pool.query(
    `SELECT r.id,r.requester_id,r.recipient_id,r.status,r.message,r.created_at,r.responded_at,
       u.id AS person_id,u.display_name,u.avatar_url,u.friend_code
     FROM approval_friend_requests r JOIN approval_users u
       ON u.id=CASE WHEN r.requester_id=$1 THEN r.recipient_id ELSE r.requester_id END
     WHERE (r.requester_id=$1 OR r.recipient_id=$1)
     ORDER BY CASE WHEN r.status='pending' THEN 0 ELSE 1 END,r.created_at DESC,r.id DESC LIMIT 100`, [ownerId],
  );
  const count = await pool.query("SELECT count(*)::int AS count FROM approval_friend_requests WHERE recipient_id=$1 AND status='pending'", [ownerId]);
  return { pendingCount: count.rows[0].count, requests: result.rows.map(row => ({
    id: row.id, direction: row.recipient_id === ownerId ? 'incoming' : 'outgoing', status: row.status, message: row.message,
    createdAt: row.created_at, respondedAt: row.responded_at,
    person: person({ id: row.person_id, display_name: row.display_name, avatar_url: row.avatar_url, friend_code: row.friend_code }),
  })) };
}

export async function respondApprovalFriendRequest(ownerId: string, id: string, action: unknown) {
  if (!UUID.test(id)) throw new ApprovalNotFoundError('好友申请不存在。');
  if (!['accept','reject','cancel'].includes(String(action))) throw new ApprovalValidationError('申请操作不正确。');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const initial = await client.query('SELECT requester_id,recipient_id FROM approval_friend_requests WHERE id=$1 AND (requester_id=$2 OR recipient_id=$2)', [id, ownerId]);
    if (!initial.rows[0]) throw new ApprovalNotFoundError('好友申请不存在。');
    const { requester_id: requesterId, recipient_id: recipientId } = initial.rows[0];
    await pairLock(client, requesterId, recipientId);
    const result = await client.query('SELECT status FROM approval_friend_requests WHERE id=$1 FOR UPDATE', [id]);
    if ((action === 'cancel' ? requesterId : recipientId) !== ownerId) throw new ApprovalForbiddenError('你无权处理这条申请。');
    const state = action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : 'cancelled';
    if (result.rows[0].status !== 'pending') {
      if (result.rows[0].status !== state) throw new ApprovalValidationError('该好友申请已经处理。');
      await client.query('COMMIT'); return { id, status: state };
    }
    if (action === 'accept') {
      await blocked(client, requesterId, recipientId);
      const active = await client.query("SELECT id FROM approval_users WHERE id=ANY($1::uuid[]) AND status='active'", [[requesterId, recipientId]]);
      if (active.rowCount !== 2) throw new ApprovalValidationError('对方账号已停用。');
      for (const [a, b] of [[requesterId, recipientId], [recipientId, requesterId]]) await client.query(
        `INSERT INTO approval_friendships(owner_id,friend_id,status,requested_by) VALUES($1,$2,'accepted',$3)
         ON CONFLICT(owner_id,friend_id) DO UPDATE SET status='accepted',requested_by=EXCLUDED.requested_by,updated_at=NOW()`, [a, b, requesterId],
      );
    }
    await client.query('UPDATE approval_friend_requests SET status=$2,responded_at=NOW() WHERE id=$1', [id, state]);
    await client.query('COMMIT'); return { id, status: state };
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function updateApprovalFriend(ownerId: string, friendId: string, raw: unknown) {
  if (!UUID.test(friendId)) throw new ApprovalNotFoundError('好友不存在。');
  const remark = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).remark : null;
  if (typeof remark !== 'string' || remark.trim().length > 80) throw new ApprovalValidationError('备注最多80字。');
  const result = await pool.query("UPDATE approval_friendships SET remark=$3,updated_at=NOW() WHERE owner_id=$1 AND friend_id=$2 AND status='accepted' RETURNING friend_id", [ownerId, friendId, remark.trim()]);
  if (!result.rowCount) throw new ApprovalNotFoundError('好友不存在。');
  return { id: friendId, remark: remark.trim() };
}

export async function removeApprovalFriend(ownerId: string, friendId: string) {
  if (!UUID.test(friendId) || friendId === ownerId) throw new ApprovalNotFoundError('好友不存在。');
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await pairLock(client, ownerId, friendId);
    await client.query("DELETE FROM approval_friendships WHERE ((owner_id=$1 AND friend_id=$2) OR (owner_id=$2 AND friend_id=$1)) AND status='accepted'", [ownerId, friendId]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function requireApprovalFriends(client: PoolClient, ownerId: string, ids: string[]) {
  const targets = [...new Set(ids.filter(id => id !== ownerId))].sort();
  if (!targets.length) return;
  const result = await client.query(
    `SELECT f.friend_id FROM approval_friendships f JOIN approval_users u ON u.id=f.friend_id AND u.status='active'
     WHERE f.owner_id=$1 AND f.friend_id=ANY($2::uuid[]) AND f.status='accepted' ORDER BY f.friend_id FOR SHARE OF f,u`, [ownerId, targets],
  );
  if (result.rowCount !== targets.length) throw new ApprovalValidationError('执行人和审批人必须是已通过申请的好友，请刷新好友列表。');
}
