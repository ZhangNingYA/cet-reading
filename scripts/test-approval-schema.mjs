// Run only against a disposable approval_schema_test_* PostgreSQL database.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/approval_schema_test_[a-z0-9_]+$/.test(new URL(url).pathname)) {
  throw new Error('Use an isolated approval_schema_test_* database');
}
const client = new pg.Client({ connectionString: url });
await client.connect();
const files = ['028_approval_foundation.sql', '029_approval_result_body.sql',
  '030_approval_account.sql', '031_approval_media.sql', '032_approval_friends_executor.sql',
  '033_approval_deadlines_scores.sql', '034_approval_integrity.sql'];
const migrate = async file => client.query(await readFile(new URL('../db/migrations/' + file, import.meta.url), 'utf8'));
async function rejects(code, sql, params) {
  await assert.rejects(async () => {
    await client.query('BEGIN');
    try {
      await client.query(sql, params);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }, error => error.code === code);
}
async function request(executor) {
  return (await client.query(
    "INSERT INTO approval_requests(applicant_id,executor_id,kind,title) VALUES($1,$1,'ad_hoc','schema test') RETURNING id", [executor],
  )).rows[0].id;
}

try {
  for (const file of files.slice(0, 4)) await migrate(file);
  const [owner, executor, reviewer] = (await client.query(
    "INSERT INTO approval_users(openid,display_name) VALUES('schema-owner','申请人'),('schema-executor','执行人'),('schema-reviewer','审批人') RETURNING id",
  )).rows.map(row => row.id);
  const template = (await client.query(
    "INSERT INTO approval_templates(owner_id,name,kind) VALUES($1,'旧模板','daily') RETURNING id", [owner],
  )).rows[0].id;
  const legacy = (await client.query(
    "INSERT INTO approval_requests(applicant_id,template_id,kind,status,title,scheduled_for) VALUES($1,$2,'daily','completed','历史任务','2026-10-24') RETURNING id", [owner, template],
  )).rows[0].id;
  await client.query(
    "INSERT INTO approval_request_steps(request_id,position,step_kind,assignee_id,status,score,acted_at) VALUES($1,1,'review',$2,'completed',60,'2026-10-25T16:30:00Z')", [legacy, reviewer],
  );
  await migrate(files[4]);
  assert.equal((await client.query('SELECT executor_id FROM approval_requests WHERE id=$1', [legacy])).rows[0].executor_id, owner);
  await client.query('UPDATE approval_requests SET executor_id=$2 WHERE id=$1', [legacy, executor]);
  await client.query("INSERT INTO approval_daily_scores(user_id,score_date,score,source_request_id) VALUES($1,'2026-10-24',99,$2)", [executor, legacy]);
  await client.query("INSERT INTO approval_user_avatars(user_id,content_type,image_bytes) VALUES($1,'image/png',$2)", [owner, Buffer.from('legacy avatar')]);
  await migrate(files[5]);
  await migrate(files[6]);
  // The deployer replays earlier migrations on subsequent releases.
  for (const file of files) await migrate(file);
  assert.equal((await client.query('SELECT score FROM approval_task_scores WHERE request_id=$1', [legacy])).rows[0].score, 60);
  assert.equal((await client.query('SELECT score FROM approval_daily_scores WHERE source_request_id=$1', [legacy])).rows[0].score, 99);
  assert.equal((await client.query('SELECT image_bytes FROM approval_user_avatars WHERE user_id=$1', [owner])).rows[0].image_bytes.toString(), 'legacy avatar');
  console.log('PASS: old scores/avatars survive upgrade and the entire migration chain is replayable');

  const second = await request(executor);
  const third = await request(executor);
  await client.query(
    "INSERT INTO approval_task_scores(request_id,executor_id,score,source,reviewer_id,scored_at) VALUES($1,$3,90,'manual',$4,'2026-10-26T02:00:00Z'),($2,$3,0,'overdue',NULL,'2026-10-26T03:00:00Z')",
    [second, third, executor, reviewer],
  );
  assert.deepEqual((await client.query(
    'SELECT score,task_count,score_date::text FROM approval_daily_score_summary WHERE user_id=$1', [executor],
  )).rows, [{ score: 50, task_count: 3, score_date: '2026-10-26' }]);
  const unscored = await request(executor);
  const insert = 'INSERT INTO approval_task_scores(request_id,executor_id,score,source,reviewer_id) VALUES($1,$2,$3,$4,$5)';
  await rejects('23505', insert, [third, executor, 0, 'overdue', null]);
  await rejects('23503', insert, [unscored, owner, 0, 'overdue', null]);
  await rejects('23514', insert, [unscored, executor, 90, 'overdue', null]);
  await rejects('23514', insert, [unscored, executor, 90, 'manual', null]);
  await rejects('23514', insert, [unscored, executor, 0, 'overdue', reviewer]);
  await rejects('23503', 'UPDATE approval_requests SET executor_id=$2 WHERE id=$1', [legacy, owner]);
  console.log('PASS: multiple scores aggregate without overwriting; scoring date, executor and score sources are enforced');

  const pending = await request(executor);
  const step = 'INSERT INTO approval_request_steps(request_id,position,step_kind,assignee_id) VALUES($1,$2,$3,$4)';
  await client.query(step, [pending, 1, 'approval', reviewer]);
  await rejects('23505', step, [pending, 2, 'review', reviewer]);
  await rejects('23514', 'UPDATE approval_request_steps SET score=50 WHERE request_id=$1', [pending]);
  await client.query("UPDATE approval_request_steps SET status='rejected' WHERE request_id=$1", [pending]);
  await client.query(step, [pending, 2, 'approval', reviewer]);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM approval_request_steps WHERE request_id=$1', [pending])).rows[0].n, 2);
  await rejects('23503', 'DELETE FROM approval_templates WHERE id=$1', [template]);
  await client.query('UPDATE approval_templates SET active=false WHERE id=$1', [template]);
  console.log('PASS: one pending step, retained resubmission history and explicit template deletion restriction');

  const event = (await client.query(
    "INSERT INTO approval_events(request_id,actor_id,event_type) VALUES($1,$2,'request.created') RETURNING id", [second, owner],
  )).rows[0].id;
  const attach = "INSERT INTO approval_attachments(request_id,uploader_id,stage,object_key,content_type,byte_size,event_id,sort_order) VALUES($1,$2,'application','legacy/key','image/jpeg',1,$3,$4)";
  await rejects('23503', attach, [legacy, owner, event, 0]);
  await client.query(attach, [second, owner, event, 0]);
  await rejects('23505', attach, [second, owner, event, 0]);
  await rejects('23503', 'DELETE FROM approval_events WHERE id=$1', [event]);
  await client.query('DELETE FROM approval_requests WHERE id=$1', [second]);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM approval_attachments WHERE event_id=$1', [event])).rows[0].n, 0);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM approval_task_scores WHERE request_id=$1', [second])).rows[0].n, 0);
  assert.equal((await client.query("SELECT to_regclass('approval_steps_request') AS index")).rows[0].index, null);
  console.log('PASS: attachment ownership/order, protected audit events and consistent cascades');

  // An invalid upgrade must preserve old data for explicit repair.
  await client.query('ALTER TABLE approval_task_scores DROP CONSTRAINT approval_task_scores_source_details_check');
  await client.query(insert, [unscored, executor, 25, 'overdue', null]);
  await assert.rejects(() => migrate(files[6]), error => error.code === '23514');
  await client.query('ROLLBACK');
  assert.equal((await client.query('SELECT score FROM approval_task_scores WHERE request_id=$1', [unscored])).rows[0].score, 25);
  await client.query('UPDATE approval_task_scores SET score=0 WHERE request_id=$1', [unscored]);
  await migrate(files[6]);
  console.log('PASS: inconsistent legacy data rejects migration atomically without deleting history');

  await client.query('CREATE SCHEMA fresh_install');
  await client.query('SET search_path TO fresh_install, public');
  for (const file of files) {
    await client.query(await readFile(new URL('../db/init/' + file, import.meta.url), 'utf8'));
  }
  assert.equal((await client.query(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='fresh_install' AND table_type='BASE TABLE' AND table_name LIKE 'approval_%'",
  )).rows[0].n, 13);
  assert.equal((await client.query('SELECT * FROM approval_daily_score_summary')).rowCount, 0);
  assert.equal(await readFile(new URL('../db/init/034_approval_integrity.sql', import.meta.url), 'utf8'),
    await readFile(new URL('../db/migrations/034_approval_integrity.sql', import.meta.url), 'utf8'));
  console.log('PASS: fresh-install schema and upgrade use the same integrity migration');
} finally {
  await client.end();
}

