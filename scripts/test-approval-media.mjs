// Uses an isolated database and an in-memory Blob adapter; no cloud files are touched.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import Fastify from 'fastify';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/^\/approval_media_test_[a-z0-9_]+$/.test(new URL(databaseUrl).pathname)) throw new Error('Use a dedicated approval_media_test_* database');
process.env.DATABASE_URL = databaseUrl;
process.env.APPROVAL_DEV_AUTH = 'true';
process.env.APPROVAL_SESSION_SECRET = 'approval-media-tests-only';
process.env.NODE_ENV = 'test';
const bootstrap = new pg.Pool({ connectionString: databaseUrl });
for (const name of ['028_approval_foundation.sql', '029_approval_result_body.sql', '030_approval_account.sql', '031_approval_media.sql', '031_approval_media.sql']) {
  await bootstrap.query(await readFile(new URL(`../db/migrations/${name}`, import.meta.url), 'utf8'));
}
await bootstrap.end();
const { pool } = await import('../apps/api/src/store.ts');
const { useApprovalBlobStorageForTests, cleanupApprovalMedia } = await import('../apps/api/src/approval-media.ts');
const blobs = new Map();
let failWrites = false;
useApprovalBlobStorageForTests({
  async put(key, bytes) { if (failWrites) throw new Error('simulated storage failure'); blobs.set(key, Buffer.from(bytes)); },
  async read(key) { assert.ok(blobs.has(key)); return blobs.get(key); },
  async delete(key) { blobs.delete(key); },
});
const { registerApprovalRoutes } = await import('../apps/api/src/approval-routes.ts');
const app = Fastify();
registerApprovalRoutes(app);
const call = (method, url, token, payload) => app.inject({ method, url, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}), ...(payload === undefined ? {} : { payload }) });
async function login(name) {
  const r = await call('POST', '/api/approval/auth/login', null, { openid: `media-test-${name}-${randomUUID()}`, displayName: name });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
const png = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#aabbcc' } }).png().withMetadata().toBuffer();
function multipart(bytes, two = false) {
  const boundary = 'approval-media-boundary';
  const part = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n`), bytes, Buffer.from('\r\n')]);
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([part, ...(two ? [part] : []), Buffer.from(`--${boundary}--\r\n`)]) };
}
async function upload(user, purpose, bytes = png, two = false) {
  const data = multipart(bytes, two);
  return app.inject({ method: 'POST', url: `/api/approval/media?purpose=${purpose}`, ...data, headers: { ...data.headers, ...(user ? { authorization: `Bearer ${user.token}` } : {}) } });
}
async function photo(user, purpose) {
  const r = await upload(user, purpose);
  assert.equal(r.statusCode, 201, r.body);
  return r.json().media.id;
}

try {
  const alice = await login('甲'), bob = await login('乙'), outsider = await login('丙');
  assert.equal((await upload(null, 'application')).statusCode, 401);
  assert.equal((await upload(alice, 'unknown')).statusCode, 400);
  assert.equal((await upload(alice, 'application', Buffer.from('not an image'))).statusCode, 400);
  assert.equal((await upload(alice, 'application', Buffer.alloc(2 * 1024 * 1024 + 1))).statusCode, 400);
  assert.equal((await upload(alice, 'application', png, true)).statusCode, 400);
  const beforeFail = blobs.size;
  failWrites = true;
  assert.equal((await upload(alice, 'application')).statusCode, 503);
  failWrites = false;
  assert.equal(blobs.size, beforeFail);
  console.log('PASS: authentication, image decoding, upload limits and cloud failure recovery');

  const avatar = await photo(alice, 'avatar');
  assert.equal((await call('PATCH', '/api/approval/me', bob.token, { displayName: '乙', avatarMediaId: avatar })).statusCode, 400);
  const saved = await call('PATCH', '/api/approval/me', alice.token, { displayName: '甲', avatarMediaId: avatar });
  assert.equal(saved.statusCode, 200, saved.body);
  const avatarImage = await call('GET', saved.json().user.avatarUrl);
  assert.equal(avatarImage.statusCode, 200, avatarImage.body);
  const metadata = await sharp(avatarImage.rawPayload).metadata();
  assert.equal(metadata.width, 512); assert.equal(metadata.height, 512); assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.exif, undefined);
  assert.equal(Number((await pool.query('SELECT count(*) FROM approval_user_avatars')).rows[0].count), 0);
  assert.equal((await call('DELETE', `/api/approval/media/${avatar}`, alice.token)).statusCode, 404);
  console.log('PASS: Blob avatar persistence, stripped metadata and cross-account isolation');

  const ids = [];
  for (let i = 0; i < 9; i++) ids.push(await photo(alice, 'application'));
  const alien = await photo(outsider, 'application');
  const body = { kind: 'ad_hoc', title: '多图审批', approverId: bob.user.id, photoIds: ids };
  for (const photoIds of [[...ids, alien], [ids[0], ids[0]], [alien], [avatar], [randomUUID()]]) {
    assert.equal((await call('POST', '/api/approval/requests', alice.token, { ...body, photoIds })).statusCode, 400);
  }
  assert.equal(Number((await pool.query('SELECT count(*) FROM approval_requests')).rows[0].count), 0);
  const created = await call('POST', '/api/approval/requests', alice.token, body);
  assert.equal(created.statusCode, 201, created.body);
  const request = created.json().request;
  assert.equal(request.applicantId, alice.user.id);
  assert.equal(request.events[0].type, 'request.created');
  assert.equal(request.events[0].actor.id, alice.user.id);
  assert.ok(request.events[0].createdAt);
  assert.ok(request.events[0].actor.avatarUrl);
  assert.equal('openid' in request.events[0].actor, false);
  assert.deepEqual(request.photos.map(p => p.id), ids);
  assert.equal(request.photos.length, 9);
  assert.equal((await call('POST', '/api/approval/requests', alice.token, body)).statusCode, 400);
  assert.equal((await call('DELETE', `/api/approval/media/${ids[0]}`, alice.token)).statusCode, 404);
  assert.equal((await call('GET', `/api/approval/requests/${request.id}`, outsider.token)).statusCode, 404);
  const readable = await call('GET', `/api/approval/requests/${request.id}`, bob.token);
  const link = readable.json().request.photos[0].url;
  assert.equal((await call('GET', link)).statusCode, 200);
  const thumb = readable.json().request.photos[0].thumbnailUrl;
  const thumbImage = await call('GET', thumb);
  assert.equal(thumbImage.statusCode, 200);
  assert.ok((await sharp(thumbImage.rawPayload).metadata()).width <= 320);
  assert.equal((await call('GET', link.replace(`user=${bob.user.id}`, `user=${outsider.user.id}`))).statusCode, 403);
  assert.equal((await call('GET', `/api/approval/media/${ids[0]}/content`)).statusCode, 403);
  assert.equal((await call('GET', link.replace(/expires=\d+/, 'expires=1'))).statusCode, 403);
  await pool.query('UPDATE approval_users SET status=\'disabled\' WHERE id=$1', [bob.user.id]);
  assert.equal((await call('GET', link)).statusCode, 404);
  await pool.query('UPDATE approval_users SET status=\'active\' WHERE id=$1', [bob.user.id]);
  const history = (await call('GET', '/api/approval/requests?view=sent', alice.token)).json();
  assert.equal(history.requests[0].photoCount, 9); assert.ok(history.requests[0].thumbnailUrl);
  const dashboard = (await call('GET', '/api/approval/dashboard', bob.token)).json();
  assert.equal(dashboard.pendingApproval[0].photoCount, 9);
  console.log('PASS: nine ordered application images, atomic rollback, list summaries and private image links');

  const results = [];
  for (let i = 0; i < 9; i++) results.push(await photo(alice, 'result'));
  assert.equal((await call('POST', `/api/approval/requests/${request.id}/result`, alice.token, { resultBody: '', photoIds: results })).statusCode, 400);
  assert.equal((await call('POST', `/api/approval/requests/${request.id}/decision`, bob.token, { action: 'approve' })).statusCode, 200);
  assert.equal((await call('POST', `/api/approval/requests/${request.id}/result`, bob.token, { resultBody: 'wrong actor', photoIds: results })).statusCode, 403);
  assert.equal((await call('POST', `/api/approval/requests/${request.id}/result`, alice.token, { resultBody: '', photoIds: [ids[0]] })).statusCode, 400);
  const completed = await call('POST', `/api/approval/requests/${request.id}/result`, alice.token, { resultBody: '', photoIds: results });
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal(completed.json().request.photos.length, 18);
  assert.deepEqual(completed.json().request.photos.filter(p => p.stage === 'result').map(p => p.id), results);
  assert.equal((await call('POST', `/api/approval/requests/${request.id}/result`, alice.token, { resultBody: 'duplicate', photoIds: [] })).statusCode, 400);
  const reviewed = await call('POST', `/api/approval/requests/${request.id}/review`, bob.token, { score: 0, comment: '按实际结果评分' });
  assert.equal(reviewed.statusCode, 200, reviewed.body);
  assert.deepEqual(reviewed.json().request.events.map(event => event.type), ['request.created', 'request.approved', 'request.result_submitted', 'request.reviewed']);
  assert.deepEqual(reviewed.json().request.events.map(event => event.actor.id), [alice.user.id, bob.user.id, alice.user.id, bob.user.id]);
  assert.equal(reviewed.json().request.events[3].score, 0);
  assert.equal(reviewed.json().request.events[3].comment, '按实际结果评分');
  assert.ok(reviewed.json().request.events.every(event => event.createdAt));
  const rejectedDraft = await call('POST', '/api/approval/requests', alice.token, { kind: 'ad_hoc', title: '驳回事件记录', approverId: bob.user.id });
  const rejected = await call('POST', `/api/approval/requests/${rejectedDraft.json().request.id}/decision`, bob.token, { action: 'reject', comment: '补充说明后再提交' });
  assert.equal(rejected.statusCode, 200, rejected.body);
  assert.equal(rejected.json().request.events.at(-1).type, 'request.rejected');
  assert.equal(rejected.json().request.events.at(-1).actor.id, bob.user.id);
  assert.equal(rejected.json().request.events.at(-1).comment, '补充说明后再提交');
  console.log('PASS: complete activity actors/timestamps, zero-score reviews and rejected-request events');
  console.log('PASS: independent nine-image result group, photo-only result and workflow permission checks');

  const abandoned = await photo(alice, 'application');
  assert.equal((await call('DELETE', `/api/approval/media/${abandoned}`, outsider.token)).statusCode, 404);
  assert.equal((await call('DELETE', `/api/approval/media/${abandoned}`, alice.token)).statusCode, 204);
  const expired = await photo(alice, 'application');
  await pool.query('UPDATE approval_media_files SET created_at=NOW()-INTERVAL \'25 hours\' WHERE id=$1', [expired]);
  assert.equal(await cleanupApprovalMedia(), 1);
  assert.equal((await pool.query('SELECT id FROM approval_media_files WHERE id=$1', [expired])).rowCount, 0);
  assert.equal((await call('GET', link)).statusCode, 200);
  console.log('PASS: staged image deletion and expired-upload cleanup preserve submitted photos');
} finally { await app.close(); await pool.end(); }
