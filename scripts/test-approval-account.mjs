// Run with: TEST_DATABASE_URL=postgres://.../approval_account_test_name node --import tsx scripts/test-approval-account.mjs
// This suite only accepts a dedicated test database; it never uses the production database.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import Fastify from 'fastify';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/^\/approval_account_test_[a-z0-9_]+$/.test(new URL(databaseUrl).pathname)) {
  throw new Error('TEST_DATABASE_URL must point to a dedicated approval_account_test_* database');
}
process.env.DATABASE_URL = databaseUrl;
process.env.APPROVAL_DEV_AUTH = 'true';
process.env.APPROVAL_SESSION_SECRET = 'approval-account-integration-tests-only';
process.env.NODE_ENV = 'test';

const bootstrap = new pg.Pool({ connectionString: databaseUrl });
for (const file of ['028_approval_foundation.sql', '029_approval_result_body.sql', '030_approval_account.sql', '031_approval_media.sql']) {
  await bootstrap.query(await readFile(new URL(`../db/migrations/${file}`, import.meta.url), 'utf8'));
}
await bootstrap.end();
const { useApprovalBlobStorageForTests } = await import('../apps/api/src/approval-media.ts');
const blobs = new Map();
useApprovalBlobStorageForTests({
  async put(key, bytes) { blobs.set(key, bytes); },
  async read(key) { return blobs.get(key); },
  async delete(key) { blobs.delete(key); },
});
const { registerApprovalRoutes } = await import('../apps/api/src/approval-routes.ts');
const { pool } = await import('../apps/api/src/store.ts');
const app = Fastify();
registerApprovalRoutes(app);

async function call(method, url, token, payload) {
  return app.inject({ method, url, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}), ...(payload === undefined ? {} : { payload }) });
}

async function login(openid, displayName) {
  const response = await call('POST', '/api/approval/auth/login', null, { openid, displayName });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

try {
  const suffix = Date.now();
  const alice = await login(`account-test-alice-${suffix}`, '甲');
  const bob = await login(`account-test-bob-${suffix}`, '乙');
  const outsider = await login(`account-test-outsider-${suffix}`, '丙');
  for (const [method, url, payload] of [
    ['GET', '/api/approval/me'], ['PATCH', '/api/approval/me', { displayName: '无权修改' }],
    ['GET', '/api/approval/templates'], ['GET', '/api/approval/requests']
  ]) assert.equal((await call(method, url, null, payload)).statusCode, 401);

  const sharp = (await import('sharp')).default;
  const png = (await sharp({ create: { width: 16, height: 16, channels: 3, background: '#aabbcc' } }).png().toBuffer()).toString('base64');
  const profile = await call('PATCH', '/api/approval/me', alice.token, { displayName: '新昵称', avatarBase64: png, id: bob.user.id });
  assert.equal(profile.statusCode, 200, profile.body);
  const savedUser = profile.json().user;
  assert.equal(savedUser.id, alice.user.id);
  assert.equal(savedUser.displayName, '新昵称');
  assert.equal('openid' in savedUser, false);
  const image = await call('GET', savedUser.avatarUrl);
  assert.equal(image.statusCode, 200);
  assert.match(image.headers['content-type'], /image\/jpeg/);
  assert.equal((await sharp(image.rawPayload).metadata()).width, 16);
  assert.equal((await call('GET', '/api/approval/me', bob.token)).json().user.displayName, '乙');
  assert.equal((await call('PATCH', '/api/approval/me', alice.token, { displayName: 'bad', avatarBase64: Buffer.from('not an image').toString('base64') })).statusCode, 400);
  assert.equal((await call('PATCH', '/api/approval/me', alice.token, { displayName: ' ' })).statusCode, 400);
  assert.equal((await call('GET', '/api/approval/me', alice.token)).json().user.displayName, '新昵称');
  const relogin = await login(`account-test-alice-${suffix}`);
  assert.equal(relogin.user.displayName, '新昵称');
  console.log('PASS: authenticated profile update, avatar persistence, validation and account isolation');

  const created = await call('POST', '/api/approval/templates', alice.token, { kind: 'daily', name: '每日复盘', description: '测试说明' });
  assert.equal(created.statusCode, 201, created.body);
  const templateId = created.json().template.id;
  const edited = await call('PATCH', `/api/approval/templates/${templateId}`, alice.token, { name: '更新名称', description: '更新说明' });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(edited.json().template.name, '更新名称');
  assert.equal((await call('PATCH', `/api/approval/templates/${templateId}`, bob.token, { active: false })).statusCode, 404);
  const requestPayload = { kind: 'daily', templateId, title: '模板历史保留', body: '测试', scheduledFor: '2026-10-25', approverId: bob.user.id };
  const oldRequest = await call('POST', '/api/approval/requests', alice.token, requestPayload);
  assert.equal(oldRequest.statusCode, 201, oldRequest.body);
  const requestId = oldRequest.json().request.id;
  assert.equal(oldRequest.json().request.actions.canApprove, false);
  assert.equal((await call('GET', `/api/approval/requests/${requestId}`, bob.token)).json().request.actions.canApprove, true);
  assert.equal((await call('PATCH', `/api/approval/templates/${templateId}`, alice.token, { active: false })).statusCode, 200);
  assert.equal((await call('GET', '/api/approval/templates', alice.token)).json().templates.length, 0);
  assert.equal((await call('GET', '/api/approval/templates?includeInactive=true', alice.token)).json().templates[0].active, false);
  assert.equal((await call('GET', `/api/approval/requests/${requestId}`, alice.token)).statusCode, 200);
  assert.equal((await call('POST', '/api/approval/requests', alice.token, { ...requestPayload, scheduledFor: '2026-10-26' })).statusCode, 400);
  assert.equal((await call('PATCH', `/api/approval/templates/${templateId}`, alice.token, { active: true })).statusCode, 200);
  assert.equal((await call('PATCH', `/api/approval/templates/${templateId}`, alice.token, { active: 'false' })).statusCode, 400);
  console.log('PASS: template create/edit/disable/reactivate, ownership checks and retained request history');

  assert.equal((await call('POST', `/api/approval/requests/${requestId}/decision`, alice.token, { action: 'approve' })).statusCode, 403);
  assert.equal((await call('POST', `/api/approval/requests/${requestId}/decision`, bob.token, { action: 'approve' })).statusCode, 200);
  assert.equal((await call('GET', `/api/approval/requests/${requestId}`, alice.token)).json().request.actions.canSubmitResult, true);
  assert.equal((await call('GET', `/api/approval/requests/${requestId}`, bob.token)).json().request.actions.canSubmitResult, false);
  assert.equal((await call('POST', `/api/approval/requests/${requestId}/result`, alice.token, { resultBody: '执行完成' })).statusCode, 200);
  assert.equal((await call('POST', `/api/approval/requests/${requestId}/review`, bob.token, { score: 90, comment: '完成良好' })).statusCode, 200);
  const sent = await call('GET', '/api/approval/requests?view=sent&status=completed', alice.token);
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(sent.json().requests.length, 1);
  const handled = await call('GET', '/api/approval/requests?view=handled&status=completed', bob.token);
  assert.equal(handled.json().requests[0].id, requestId);
  assert.equal((await call('GET', `/api/approval/requests/${requestId}`, outsider.token)).statusCode, 404);
  assert.equal((await call('GET', '/api/approval/requests', outsider.token)).json().requests.length, 0);
  console.log('PASS: history scopes/status filters, workflow permissions and private request isolation');

  await pool.query(
    `INSERT INTO approval_requests (applicant_id, kind, status, title, updated_at)
     SELECT $1, 'ad_hoc', 'pending_approval', '分页测试-' || n, '2026-10-23T12:00:00.123456Z'::timestamptz FROM generate_series(1, 31) n`, [alice.user.id],
  );
  const seen = new Set();
  let cursor = '';
  do {
    const response = await call('GET', `/api/approval/requests?view=sent&q=${encodeURIComponent('分页测试')}&limit=7&cursor=${cursor}`, alice.token);
    assert.equal(response.statusCode, 200, response.body);
    const page = response.json();
    for (const item of page.requests) { assert.equal(seen.has(item.id), false); seen.add(item.id); }
    cursor = page.nextCursor || '';
  } while (cursor);
  assert.equal(seen.size, 31);
  for (const query of ['view=invalid', 'status=invalid', 'limit=0', 'cursor=bad', `cursor=${Buffer.from(JSON.stringify({time: 'invalid', id: alice.user.id})).toString('base64url')}`]) {
    assert.equal((await call('GET', `/api/approval/requests?${query}`, alice.token)).statusCode, 400);
  }
  console.log('PASS: complete pagination with tied microsecond timestamps, search and invalid filter rejection');
} finally {
  await app.close();
  await pool.end();
}
