// Explicit, repeatable fixtures for a developer's own approval account.
// No migrations or API startup hooks run this script automatically.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { pool } from '../apps/api/dist/store.js';
import { uploadApprovalMedia, bindApprovalPhotos, deleteApprovalMedia } from '../apps/api/dist/approval-media.js';
import { updateApprovalProfile } from '../apps/api/dist/approval-store.js';

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const targetId = option('--target-user');
const apply = args.includes('--apply');
const backupPath = option('--backup');
const imageDir = resolve(option('--media-dir') || new URL('../data/approval-demo/', import.meta.url).pathname);
const seed = 'approval-lifelike-v1';
const day = 86400000;
const now = Date.now();
const date = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
const midnight = Date.parse(date + 'T00:00:00+08:00');
const at = (offset, hour, minute = 0) => new Date(midnight + offset * day + (hour * 60 + minute) * 60000).toISOString();
const ago = hours => new Date(now - hours * 3600000).toISOString();
function id(key) {
  const hex = createHash('sha256').update(`${seed}:${targetId}:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const profiles = [
  { key: 'lin', name: '林晓', legacyName: '演示申请人', remark: '林晓 · 阅读搭子', color: '#849e83', hair: '#433c37', style: 0 },
  { key: 'zhou', name: '周岚', legacyName: '演示审批人', remark: '周岚 · 同事', color: '#8aa8b7', hair: '#393d47', style: 1 },
  { key: 'chen', name: '陈希', legacyName: '演示执行人', remark: '陈希 · 徒步搭子', color: '#c99878', hair: '#403b37', style: 2 },
  { key: 'xu', name: '许宁', remark: '许宁', color: '#9293af', hair: '#473a38', style: 0 },
  { key: 'su', name: '苏晴', remark: '苏晴 · 同学', color: '#bb8e96', hair: '#54453c', style: 1 },
  { key: 'zhao', name: '赵川', remark: '赵川', color: '#789ca3', hair: '#303839', style: 2 },
  { key: 'zhang', name: '张悦', color: '#b49f7e', hair: '#524039', style: 1 },
  { key: 'he', name: '何川', color: '#86a99b', hair: '#373a42', style: 2 },
  { key: 'gu', name: '顾然', color: '#9e99b2', hair: '#3b3838', style: 0 }
];
// These portraits are original vector fixtures, not photographs of real people.
async function avatar(profile) {
  const long = profile.style === 1;
  const glasses = profile.style === 2 ? '<g fill="none" stroke="#44454a" stroke-width="6"><rect x="139" y="181" width="63" height="44" rx="15"/><rect x="221" y="181" width="63" height="44" rx="15"/><path d="M202 198h19"/></g>' : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="420" viewBox="0 0 420 420"><rect width="420" height="420" rx="90" fill="${profile.color}"/><circle cx="334" cy="82" r="66" fill="#fff" opacity=".12"/><path d="M65 420v-42c0-81 65-126 145-126s145 45 145 126v42" fill="#f1eee4"/><path d="M181 249h58v56c-14 16-43 16-58 0" fill="#dfb59b"/>${long ? `<path d="M112 154c0-81 196-81 196 0v148c-17 30-45 38-98 38s-84-8-98-38" fill="${profile.hair}"/>` : ''}<ellipse cx="210" cy="187" rx="84" ry="104" fill="#f0c9ab"/><path d="M126 180c-9-42 1-93 39-109 60-25 137 10 134 79l-8 31-15-54c-37 13-63 0-87-15-14 28-33 43-63 47" fill="${profile.hair}"/><path d="M163 183l17-3m60 0 17 3" fill="none" stroke="#5f4942" stroke-width="7" stroke-linecap="round"/><circle cx="174" cy="201" r="4" fill="#493e38"/><circle cx="246" cy="201" r="4" fill="#493e38"/>${glasses}<path d="M208 205l-6 24h12" fill="none" stroke="#cf9d86" stroke-width="5" stroke-linecap="round"/><path d="M189 247c14 13 29 13 43-1" fill="none" stroke="#ac746a" stroke-width="5" stroke-linecap="round"/><path d="M160 329l50 37 50-37" fill="none" stroke="${profile.color}" stroke-width="8" stroke-linecap="round"/></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

const scenarios = [];
const add = (key, applicant, executor, approver, title, body, state, options = {}) => scenarios.push({ key, applicant, executor, approver, title, body, state, ...options });
add('lake-route', 'lin', 'lin', 'me', '周末云龙湖骑行路线确认', '周六早上从滨湖公园出发，绕湖约12公里。计划两小时内结束，沿途留两次休息时间。', 'pending_approval', { start: ago(2), due: at(6, 12) });
add('museum-delegated', 'xu', 'chen', 'me', '帮陈希报备汉文化景区参观安排', '陈希负责确认参观路线和集合点，我先帮他提交。上午参观博物馆，中午在附近吃饭，下午三点前返程。', 'pending_approval', { start: ago(4), due: at(3, 16), photos: ['culture', 'warriors'] });
add('needs-material', 'me', 'me', 'zhou', '汉文化景区参观路线确认', '周末想去汉文化景区，先看宗祠，再参观汉兵马俑。随申请附上两处地点照片，确认后再约车。', 'needs_supplement', { start: at(-1, 19, 10), due: at(4, 17), photos: ['culture', 'warriors'], reject: '还缺集合地点和返程时间，请补充后重新提交。' });
add('resubmitted', 'me', 'xu', 'zhou', '帮许宁确认周末参观计划', '许宁周末来徐州，想安排半天参观汉文化景区。我负责申请，他负责联系集合和返程。', 'pending_approval', { start: ago(27), due: at(5, 18), photos: ['culture'], supplement: '已确认上午9:30在景区东门集合，下午14:00返程。补上参观路线的两处地点照片。', supplementPhotos: ['warriors', 'culture'], reject: '请明确集合和返程安排。', deadlineChanged: true });
add('walk', 'lin', 'me', 'zhou', '明晚饭后绕湖走三公里', '最近坐得有点久，约好明晚饭后和林晓一起走路。按舒适的速度完成三公里，不赶配速。', 'approved', { start: ago(6), due: at(1, 22), approve: '可以，结束后记录距离和大概用时就好。' });
add('reading-active', 'me', 'me', 'chen', '明晚完成一篇英语阅读', '读完一篇文章，整理5个不熟悉的词，再用自己的话写两句总结。', 'approved', { start: ago(8), due: at(1, 22, 30), daily: true, scheduled: new Date(midnight + day + 12 * 3600000).toISOString().slice(0, 10), approve: '按这个量完成即可，重点是能复述文章。' });
add('friend-exec', 'me', 'chen', 'su', '请陈希整理周末集合安排', '我先替陈希发起。他来确认每个人的到达时间，整理集合地点、交通方式和联系人。', 'approved', { start: ago(9), due: at(2, 19), approve: '安排清楚就行，群里确认后把最终方案交上来。' });
add('museum-result', 'zhou', 'xu', 'me', '汉文化景区照片和路线整理', '许宁负责整理参观顺序，挑几张能看清地点的照片，下次出门时可以直接参考。', 'pending_review', { start: at(-2, 9, 10), due: at(-1, 19), resultAt: at(-1, 16, 32), result: '已按宗祠、汉兵马俑的顺序整理好，半天走下来比较从容。附两张地点照片，方便下次确认路线。', resultPhotos: ['culture', 'warriors'] });
add('reading-review', 'zhao', 'me', 'lin', '本周英语阅读复盘', '赵川替我发起，回顾这周读过的文章，整理反复出错的长句和单词。', 'pending_review', { start: at(-2, 18), due: at(-1, 22), resultAt: at(-1, 20, 46), result: '整理了6个长句和12个高频生词。发现主要问题是把转折后的信息读漏了，下周会专门练习。' });
add('changed-time', 'su', 'me', 'xu', '整理周末参观照片', '挑选10张清楚的照片，按地点分组，重复或模糊的删掉。', 'approved', { start: ago(30), due: at(2, 20), deadlineChanged: true, approve: '可以，先保证每个地点有两三张清楚的。' });
add('delegated-complete', 'me', 'chen', 'zhou', '帮陈希申请整理徒步装备清单', '陈希负责把周末徒步要带的东西列清楚，我代他发起。重点检查雨衣、充电宝和饮用水。', 'completed', { start: at(-3, 10), due: at(-2, 20), resultAt: at(-2, 17, 20), reviewAt: at(-2, 18, 42), result: '清单已分成必带和可选两部分，确认每人至少带一瓶水，雨衣和充电宝也都落实了。', score: 94, review: '准备得很周全，集合前再互相确认一下。' });
add('overdue-me', 'lin', 'me', 'zhou', '把上周的错题整理进笔记', '把阅读中的5道错题重新做一遍，写清当时为什么选错，不只抄正确答案。', 'overdue', { start: at(-4, 11, 30), due: at(-3, 22), approve: '同意，五道题认真整理完就好。' });
add('overdue-friend', 'me', 'zhao', 'su', '请赵川确认周末集合人数', '代赵川发起：确认能参加的人数、是否需要拼车，并整理每个人的到达时间。', 'overdue', { start: at(-3, 9), due: at(-2, 18) });
add('expired', 'chen', 'chen', 'me', '工作日下午去书店看书', '想在周三下午留一小时去书店翻几本书，先确认时间能否安排开。', 'expired', { start: at(-3, 13), due: at(-2, 17) });
add('expired-material', 'me', 'me', 'su', '购买一个桌面收纳架', '桌上的书和充电线有点乱，计划买一个小收纳架，预算80元以内。', 'expired', { start: at(-5, 19), due: at(-4, 21), reject: '请补充尺寸，先确认不会挡住显示器。' });
add('cancelled', 'xu', 'xu', 'me', '周五下班后去打羽毛球', '计划下班后打一小时，确认场地有空位再订。', 'cancelled', { start: at(-4, 16), due: at(-3, 21), cancel: '场地满了，先取消这次，重新约时间。' });
const scores = [82, 88, 91, 86, 93, 89, 96];
for (let index = 0; index < 7; index++) {
  const offset = index - 7;
  add('reading-history-' + index, 'me', 'me', index % 2 ? 'lin' : 'zhou', ['阅读一篇文章并复述要点', '整理昨天遇到的长难句', '完成阅读练习并分析错题', '复习本周高频词', '精读一篇文章的转折段', '把错题原因写进笔记', '完成本周阅读小结'][index], '给自己留30分钟安静阅读。做完后记录最有收获的一点，今天不追求题量。', 'completed', {
    start: at(offset, 9, 12 + index), due: at(offset, 22), resultAt: at(offset, 20, 17 + index), reviewAt: at(offset, 21, 5 + index), daily: true, scheduled: new Date(midnight + offset * day + 12 * 3600000).toISOString().slice(0, 10), score: scores[index],
    result: ['读完一篇科技类文章，记住了作者如何用例子支持观点，整理了5个新词。', '拆解了3个带从句的长句，重新读时比昨天顺畅一些。', '做对4道题，错题是把细节当成作者态度，已经写了原因。', '复习了18个词，其中4个还不熟，分别写了一句自己的例句。', '把两处转折前后的信息画了出来，终于看明白作者真正赞成什么。', '整理了5道错题，给每道题写了一句话解释，之后复习会更方便。', '回顾了这周的文章，摘出3个值得继续练的句型，下周继续保持。'][index],
    review: ['完成得不错，复述可以再简短些。', '句子拆得很清楚，明天复习一下就更稳了。', '错题原因找对了，下次注意题干里的限定词。', '复习有落实，生词的例句还可以更贴近生活。', '这次抓住了文章的重点，继续保持。', '整理得很认真，之后记得回看。', '这一周很稳定，最后的复述尤其清楚。'][index]
  });
}

const uploaded = [];
let client;
let transaction = false;
try {
  if (!/^[0-9a-f-]{36}$/i.test(targetId || '')) throw new Error('Pass --target-user UUID; the target account is never selected implicitly');
  const target = (await pool.query("SELECT id,display_name,status,openid LIKE 'demo-approval-%' AS demo FROM approval_users WHERE id=$1", [targetId])).rows[0];
  if (!target || target.demo || target.status !== 'active') throw new Error('The target must be an existing active non-demo account');
  for (const scenario of scenarios) {
    assert.notEqual(scenario.applicant, scenario.approver);
    assert.notEqual(scenario.executor, scenario.approver);
    assert.ok(Date.parse(scenario.start) < Date.parse(scenario.due));
    if (['pending_approval', 'needs_supplement', 'approved'].includes(scenario.state)) assert.ok(Date.parse(scenario.due) > now);
    if (scenario.resultAt) assert.ok(Date.parse(scenario.resultAt) < Date.parse(scenario.due));
  }
  const existing = (await pool.query('SELECT count(*)::int AS count FROM approval_requests WHERE id=ANY($1::uuid[])', [scenarios.map(s => id('request:' + s.key))])).rows[0].count;
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', profiles: profiles.length, scenarios: scenarios.length, existingScenarios: existing, newScenarios: scenarios.length - existing }));
  if (!apply) process.exitCode = 0;
  else {
    if (!backupPath) throw new Error('Pass --backup PATH to retain the pre-seed approval data');
    client = await pool.connect();
    const lock = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [seed + ':' + targetId]);
    if (!lock.rows[0].locked) throw new Error('Another seed operation for this account is running');
    const snapshot = {};
    for (const table of ['approval_users', 'approval_friendships', 'approval_friend_requests', 'approval_templates', 'approval_requests', 'approval_request_steps', 'approval_events', 'approval_attachments', 'approval_task_scores', 'approval_daily_scores', 'approval_media_files']) snapshot[table] = (await pool.query('SELECT * FROM ' + table)).rows;
    await writeFile(backupPath, JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 });
    const photos = { culture: await readFile(resolve(imageDir, 'han-culture.jpg')), warriors: await readFile(resolve(imageDir, 'han-warriors.jpg')) };
    const people = { me: { id: targetId } };
    const priorMapping = (await client.query("SELECT payload_json->'seedPeople' AS people FROM approval_events WHERE payload_json->>'seed'=$1 AND payload_json->>'seedTarget'=$2 AND payload_json?'seedPeople' LIMIT 1", [seed, targetId])).rows[0]?.people || {};
    for (const [index, profile] of profiles.entries()) {
      let row = priorMapping[profile.key] ? (await pool.query("SELECT id,display_name,avatar_url FROM approval_users WHERE id=$1 AND openid LIKE 'demo-approval-%'", [priorMapping[profile.key]])).rows[0] : null;
      row ||= profile.legacyName ? (await pool.query("SELECT id,display_name,avatar_url FROM approval_users WHERE openid LIKE 'demo-approval-%' AND display_name=$1 ORDER BY created_at LIMIT 1", [profile.legacyName])).rows[0] : null;
      row ||= (await pool.query('SELECT id,display_name,avatar_url FROM approval_users WHERE id=$1', [id('person:' + profile.key)])).rows[0];
      // Reuse the legacy profile by its original ID on repeat runs, without resetting edits.
      if (!row && profile.legacyName) row = (await pool.query("SELECT id,display_name,avatar_url FROM approval_users WHERE openid LIKE 'demo-approval-%' AND display_name=$1 ORDER BY created_at LIMIT 1", [profile.name])).rows[0];
      if (!row) row = (await pool.query('INSERT INTO approval_users(id,openid,display_name,created_at,updated_at) VALUES($1,$2,$3,$4,$4) RETURNING id,display_name,avatar_url', [id('person:' + profile.key), `demo-approval-life-${targetId}-${profile.key}`, profile.name, at(-30 - index, 10, index * 3)])).rows[0];
      if (row.display_name === profile.legacyName) await pool.query('UPDATE approval_users SET display_name=$2,updated_at=NOW() WHERE id=$1', [row.id, profile.name]);
      people[profile.key] = row;
      if (!row.avatar_url) {
        const media = await uploadApprovalMedia(row.id, 'avatar', await avatar(profile));
        uploaded.push({ owner: row.id, id: media.id });
        await updateApprovalProfile(row.id, { displayName: row.display_name === profile.legacyName ? profile.name : row.display_name, avatarMediaId: media.id });
      }
    }
    console.log('Profiles and compressed Blob avatars ready');
    await client.query('BEGIN');
    transaction = true;
    const pairs = new Map();
    function pair(a, b) { if (a !== b) pairs.set([a, b].sort().join(':'), [a, b]); }
    for (const profile of profiles.slice(0, 6)) pair('me', profile.key);
    for (const s of scenarios) { pair(s.applicant, s.executor); pair(s.applicant, s.approver); }
    for (const [key, [a, b]] of pairs) {
      if ((await client.query('SELECT id FROM approval_friend_requests WHERE id=$1', [id('friend:' + key)])).rowCount) {
        await client.query(`UPDATE approval_friendships f SET requested_by=q.requester_id FROM approval_friend_requests q
          WHERE q.id=$1 AND q.status='accepted' AND f.status='accepted' AND f.created_at=q.created_at AND f.updated_at=q.responded_at
          AND ((f.owner_id=q.requester_id AND f.friend_id=q.recipient_id) OR (f.owner_id=q.recipient_id AND f.friend_id=q.requester_id))`, [id('friend:' + key)]);
        continue;
      }
      const values = [people[a].id, people[b].id];
      const conflicts = await client.query("SELECT status FROM approval_friendships WHERE ((owner_id=$1 AND friend_id=$2) OR (owner_id=$2 AND friend_id=$1)) AND status<>'accepted'", values);
      if (conflicts.rowCount) throw new Error('An existing non-accepted friendship must be left unchanged');
      for (const [owner, friend] of [[a, b], [b, a]]) await client.query("INSERT INTO approval_friendships(owner_id,friend_id,status,requested_by,remark,created_at,updated_at) VALUES($1,$2,'accepted',$6,$3,$4,$5) ON CONFLICT(owner_id,friend_id) DO NOTHING", [people[owner].id, people[friend].id, owner === 'me' ? profiles.find(p => p.key === friend)?.remark || '' : '', at(-20, 10), at(-20, 10, 25), people[a].id]);
      await client.query("INSERT INTO approval_friend_requests(id,requester_id,recipient_id,status,message,created_at,responded_at) VALUES($1,$2,$3,'accepted','以后一起打卡，互相提醒一下。',$4,$5) ON CONFLICT DO NOTHING", [id('friend:' + key), ...values, at(-20, 10), at(-20, 10, 25)]);
    }
    for (const [key, requester, recipient, message, created] of [
      ['incoming-zhang', 'zhang', 'me', '我是张悦，上次一起去徒步的，加个好友下次一起打卡。', ago(5)],
      ['incoming-he', 'he', 'me', '朋友推荐过来的，想一起坚持英语阅读。', ago(2.5)],
      ['outgoing-gu', 'me', 'gu', '下次去云龙湖时一起，先加个好友。', ago(7)]
    ]) await client.query("INSERT INTO approval_friend_requests(id,requester_id,recipient_id,message,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [id('friend:' + key), people[requester].id, people[recipient].id, message, created]);
    const templateId = id('template:reading');
    await client.query("INSERT INTO approval_templates(id,owner_id,name,kind,description,schedule_json,created_at,updated_at) VALUES($1,$2,'每日阅读与复盘','daily','读一篇文章，记一点收获，每天留一点时间给自己。','{}',$3,$3) ON CONFLICT DO NOTHING", [templateId, targetId, at(-15, 9)]);
    let inserted = 0;
    for (const s of scenarios) {
      const requestId = id('request:' + s.key);
      if ((await client.query('SELECT id FROM approval_requests WHERE id=$1', [requestId])).rowCount) continue;
      const applicant = people[s.applicant].id, executor = people[s.executor].id, approver = people[s.approver].id;
      const start = Date.parse(s.start);
      const eventTime = minute => new Date(start + minute * 60000).toISOString();
      const events = []; let position = 1; let lastStatus = 'pending_approval'; let approvedAt = null;
      const steps = [];
      const payload = value => ({ seed, seedTarget: targetId, scenario: s.key, ...value });
      const event = (type, actor, to, time, data = {}, images = []) => {
        const value = { id: id(`event:${s.key}:${events.length}`), type, actor, from: events.length ? lastStatus : null, to, time, data: payload(data), images };
        events.push(value); lastStatus = to; return value;
      };
      event('request.created', applicant, 'pending_approval', s.start, { body: s.body, executorId: executor, assigneeId: approver, seedPeople: Object.fromEntries(Object.entries(people).map(([key, value]) => [key, value.id])), dueAt: s.deadlineChanged ? new Date(Date.parse(s.due) - 4 * 3600000).toISOString() : s.due, kind: s.daily ? 'daily' : 'ad_hoc' }, s.photos || []);
      if (s.reject) {
        event('request.rejected', approver, 'needs_supplement', eventTime(41), { comment: s.reject });
        steps.push({ position: position++, status: 'rejected', actedAt: eventTime(41), createdAt: s.start, comment: s.reject });
      }
      if (s.supplement) event('request.supplemented', applicant, 'pending_approval', eventTime(190), { body: s.supplement }, s.supplementPhotos || []);
      const executable = ['approved', 'pending_review', 'completed', 'overdue'].includes(s.state);
      if (s.deadlineChanged && !executable) event('request.deadline_changed', approver, lastStatus, eventTime(s.supplement ? 225 : 37), { previousDueAt: new Date(Date.parse(s.due) - 4 * 3600000).toISOString(), dueAt: s.due });
      if (executable) {
        approvedAt = eventTime(s.supplement ? 240 : 52);
        event('request.approved', approver, 'approved', approvedAt, { comment: s.approve || '同意，按计划完成后记录一下结果。' });
        steps.push({ position: position++, status: 'approved', actedAt: approvedAt, createdAt: s.supplement ? eventTime(190) : s.start, comment: s.approve || '同意，按计划完成后记录一下结果。' });
      } else if (s.state !== 'needs_supplement' && !(s.reject && !s.supplement)) {
        steps.push({ position: position++, status: ['expired', 'cancelled'].includes(s.state) ? 'cancelled' : 'pending', actedAt: null, createdAt: s.supplement ? eventTime(190) : s.start, comment: '' });
      }
      if (s.deadlineChanged && executable) event('request.deadline_changed', approver, lastStatus, eventTime(90), { previousDueAt: new Date(Date.parse(s.due) - 4 * 3600000).toISOString(), dueAt: s.due });
      if (s.resultAt) event('request.result_submitted', executor, 'pending_review', s.resultAt, { body: s.result }, s.resultPhotos || []);
      if (s.state === 'completed') event('request.reviewed', approver, 'completed', s.reviewAt, { score: s.score, comment: s.review });
      if (s.state === 'overdue') event('request.overdue', null, 'overdue', new Date(Date.parse(s.due) + 1000).toISOString(), { dueAt: s.due, score: 0 });
      if (s.state === 'expired') event('request.expired', null, 'expired', new Date(Date.parse(s.due) + 1000).toISOString(), { dueAt: s.due });
      if (s.state === 'cancelled') event('request.cancelled', applicant, 'cancelled', eventTime(80), { comment: s.cancel });
      assert.equal(lastStatus, s.state);
      assert.ok(events.every((e, i) => !i || Date.parse(e.time) >= Date.parse(events[i - 1].time)));
      const lastTime = events.at(-1).time;
      await client.query(`INSERT INTO approval_requests(id,template_id,applicant_id,executor_id,kind,status,title,body,result_body,scheduled_for,due_at,approved_at,result_submitted_at,reviewed_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [requestId, s.daily ? templateId : null, applicant, executor, s.daily ? 'daily' : 'ad_hoc', s.state, s.title, s.body, s.result || '', s.daily ? s.scheduled : null, s.due, approvedAt, s.resultAt || null, s.reviewAt || null, s.start, lastTime]);
      for (const step of steps) await client.query("INSERT INTO approval_request_steps(id,request_id,position,step_kind,assignee_id,status,comment,acted_at,created_at) VALUES($1,$2,$3,'approval',$4,$5,$6,$7,$8)", [id(`step:${s.key}:${step.position}`), requestId, step.position, approver, step.status, step.comment, step.actedAt, step.createdAt]);
      if (s.resultAt) await client.query("INSERT INTO approval_request_steps(id,request_id,position,step_kind,assignee_id,status,comment,score,acted_at,created_at) VALUES($1,$2,$3,'review',$4,$5,$6,$7,$8,$9)", [id(`step:${s.key}:review`), requestId, position, approver, s.state === 'completed' ? 'completed' : 'pending', s.review || '', s.score ?? null, s.reviewAt || null, s.resultAt]);
      for (const e of events) {
        await client.query('INSERT INTO approval_events(id,request_id,actor_id,event_type,from_status,to_status,payload_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)', [e.id, requestId, e.actor, e.type, e.from, e.to, JSON.stringify(e.data), e.time]);
        if (e.images.length) {
          const purpose = e.type === 'request.result_submitted' ? 'result' : 'application';
          const mediaIds = [];
          for (const image of e.images) {
            const media = await uploadApprovalMedia(e.actor, purpose, photos[image]);
            uploaded.push({ owner: e.actor, id: media.id }); mediaIds.push(media.id);
          }
          await bindApprovalPhotos(client, requestId, e.actor, purpose, mediaIds, e.id);
          await client.query('UPDATE approval_attachments SET created_at=$2 WHERE request_id=$1 AND event_id=$3', [requestId, e.time, e.id]);
        }
      }
      if (s.state === 'completed' || s.state === 'overdue') await client.query('INSERT INTO approval_task_scores(request_id,executor_id,score,source,reviewer_id,scored_at) VALUES($1,$2,$3,$4,$5,$6)', [requestId, executor, s.state === 'overdue' ? 0 : s.score, s.state === 'overdue' ? 'overdue' : 'manual', s.state === 'overdue' ? null : approver, lastTime]);
      // Preserve a real existing daily aggregate instead of overwriting it with a fixture.
      if (s.daily && s.state === 'completed') await client.query("INSERT INTO approval_daily_scores(user_id,score_date,score,source_request_id,note,created_at,updated_at) VALUES($1,$2,$3,$4,'阅读与复盘',$5,$5) ON CONFLICT DO NOTHING", [executor, s.scheduled, s.score, requestId, lastTime]);
      inserted++;
    }
    await client.query('COMMIT'); transaction = false;
    const counts = (await pool.query("SELECT r.status,count(*)::int AS count FROM approval_requests r WHERE EXISTS(SELECT 1 FROM approval_events e WHERE e.request_id=r.id AND e.payload_json->>'seed'=$1 AND e.payload_json->>'seedTarget'=$2) GROUP BY r.status ORDER BY r.status", [seed, targetId])).rows;
    console.log(JSON.stringify({ inserted, skipped: scenarios.length - inserted, states: counts, avatars: profiles.length, backupSaved: true }));
  }
} catch (error) {
  if (client && transaction) await client.query('ROLLBACK').catch(() => {});
  for (const media of uploaded) await deleteApprovalMedia(media.owner, media.id).catch(() => {});
  console.error(error.message); process.exitCode = 1;
} finally {
  if (client) { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [seed + ':' + targetId]).catch(() => {}); client.release(); }
  await pool.end();
}
