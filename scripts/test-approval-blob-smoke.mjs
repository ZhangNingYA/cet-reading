// Explicit opt-in, isolated test database and unique image prefix. Cleans up its own cloud objects.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BlobServiceClient } from '@azure/storage-blob';
import Fastify from 'fastify';
import sharp from 'sharp';

const url = process.env.TEST_DATABASE_URL;
if (process.env.TEST_REAL_BLOB !== 'true' || !url || !/^\/approval_media_test_[a-z0-9_]+$/.test(new URL(url).pathname)) throw new Error('Explicit Blob test opt-in and isolated database required');
process.env.DATABASE_URL = url;
process.env.NODE_ENV = 'test';
process.env.APPROVAL_SESSION_SECRET = 'isolated-blob-smoke-only';
const { pool } = await import('../apps/api/src/store.ts');
const { config } = await import('../apps/api/src/config.ts');
const { upsertApprovalUser } = await import('../apps/api/src/approval-store.ts');
const { createApprovalSession } = await import('../apps/api/src/approval-auth.ts');
const { registerApprovalRoutes } = await import('../apps/api/src/approval-routes.ts');
const app = Fastify(); registerApprovalRoutes(app);
const users = [];
const blob = BlobServiceClient.fromConnectionString(config.azureStorageConnectionString).getContainerClient(config.azureStorageContainer);
const call = (method, url, token, payload) => app.inject({ method, url, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}), ...(payload ? { payload } : {}) });
try {
  for (const name of ['owner', 'reviewer']) users.push(await upsertApprovalUser({ openid: `blob-smoke-${name}-${randomUUID()}`, displayName: '图片链路验证' }));
  await pool.query("INSERT INTO approval_friendships(owner_id,friend_id,status,requested_by) VALUES($1,$2,'accepted',$1),($2,$1,'accepted',$1)", [users[0].id,users[1].id]);
  const token = createApprovalSession(users[0]);
  const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#91b3b3' } }).png().toBuffer();
  const ids = {};
  for (const purpose of ['application', 'avatar']) {
    const boundary = 'approval-blob-smoke';
    const r = await app.inject({ method: 'POST', url: `/api/approval/media?purpose=${purpose}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)]) });
    assert.equal(r.statusCode, 201, r.body); ids[purpose] = r.json().media.id;
  }
  const profile = await call('PATCH', '/api/approval/me', token, { displayName: '图片链路验证', avatarMediaId: ids.avatar });
  assert.equal(profile.statusCode, 200, profile.body);
  const avatar = await call('GET', profile.json().user.avatarUrl); assert.equal(avatar.statusCode, 200);
  assert.equal((await sharp(avatar.rawPayload).metadata()).width, 512);
  const created = await call('POST', '/api/approval/requests', token, { kind: 'ad_hoc', dueAt: new Date(Date.now()+86400000).toISOString(), title: '图片链路验证', approverId: users[1].id, photoIds: [ids.application] });
  assert.equal(created.statusCode, 201, created.body);
  for (const key of ['url', 'thumbnailUrl']) {
    const r = await call('GET', created.json().request.photos[0][key]); assert.equal(r.statusCode, 200);
    assert.equal((await sharp(r.rawPayload).metadata()).format, 'jpeg');
  }
  const keys = await pool.query('SELECT object_key FROM approval_media_files WHERE owner_id=$1', [users[0].id]);
  const anonymous = await fetch(blob.getBlobClient(keys.rows[0].object_key).url);
  assert.notEqual(anonymous.status, 200);
  console.log('PASS: real Azure Blob upload, avatar, private full image and thumbnail round trips');
} finally {
  const ownerIds = users.map(u => u.id);
  if (ownerIds.length) {
    const files = await pool.query('SELECT object_key, thumbnail_key FROM approval_media_files WHERE owner_id=ANY($1::uuid[])', [ownerIds]);
    for (const file of files.rows) for (const key of [file.object_key, file.thumbnail_key]) {
      assert.ok(ownerIds.some(id => key.startsWith(`approval/${id}/`)), 'Refusing unrelated cloud object deletion');
      await blob.getBlobClient(key).deleteIfExists();
    }
    await pool.query('DELETE FROM approval_requests WHERE applicant_id=ANY($1::uuid[])', [ownerIds]);
    await pool.query('DELETE FROM approval_users WHERE id=ANY($1::uuid[])', [ownerIds]);
    console.log('PASS: isolated cloud smoke images removed');
  }
  await app.close(); await pool.end();
}
