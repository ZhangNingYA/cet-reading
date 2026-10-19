import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeRelease, parseRelease, serializeRelease, planDeployment } from './deployment-plan.mjs';

const commit = 'a'.repeat(40), previousCommit = 'b'.repeat(40);
const image = (name, letter) => `ghcr.io/example/project/${name}@sha256:${letter.repeat(64)}`;
const release = makeRelease('ghcr.io/example/project', commit, { api: image('api','a'), worker: image('worker','b'), web: image('web','c') });

test('release artifacts require the exact registry, service and digest and reject shell input', () => {
  assert.deepEqual(parseRelease(serializeRelease(release)), release);
  assert.equal(release.CET_NEWS_IMAGE, release.CET_WORKER_IMAGE);
  for (const invalid of [image('api','a')+';echo bad', 'other/image:latest', image('web','a')]) {
    assert.throws(() => makeRelease('ghcr.io/example/project', commit, { api: invalid, worker: image('worker','b'), web: image('web','c') }));
  }
  assert.throws(() => parseRelease(serializeRelease(release)+'GH_TOKEN=secret\n'));
  assert.throws(() => parseRelease(serializeRelease(release)+`CET_RELEASE_COMMIT=${commit}\n`));
});

test('frontend changes leave API and both background services running; identical images require no restart', () => {
  const next = { ...release, CET_WEB_IMAGE: image('web','d') };
  assert.deepEqual(planDeployment(release, next, ['apps/web/src/pages/index.astro']), { migrate:false, resetJobs:false, stop:[], start:['web'] });
  assert.deepEqual(planDeployment(release, release, ['docs/CI_CD.md']), { migrate:false, resetJobs:false, stop:[], start:[] });
});

test('worker changes stop both producers before job recovery; migrations and first deployments update backends', () => {
  const next = { ...release, CET_WORKER_IMAGE:image('worker','e'), CET_NEWS_IMAGE:image('worker','e') };
  assert.deepEqual(planDeployment(release,next,['apps/worker/src/worker.ts']), { migrate:false, resetJobs:true, stop:['worker','news'], start:['worker','news'] });
  for (const path of ['db/migrations/027_new.sql','data/papers/new.json','scripts/generate-paper-seed.mjs']) {
    const plan = planDeployment(release,release,[path]);
    assert.equal(plan.migrate,true); assert.equal(plan.resetJobs,true); assert.deepEqual(plan.stop,['api','worker','news']);
  }
  assert.equal(planDeployment(null,release,[]).migrate,true);
});

function fixture(t, { failUpdate=false, failHealth=false } = {}) {
  const root = mkdtempSync(join(tmpdir(),'cet-deploy-'));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  for(const dir of ['bin','scripts/lib','.deployment']) mkdirSync(join(root,dir),{recursive:true});
  for(const file of ['scripts/deploy-server.sh','scripts/deployment-release.mjs','scripts/lib/deployment-plan.mjs','docker-compose.yml','docker-compose.production.yml']) cpSync(resolve(file),join(root,file));
  writeFileSync(join(root,'.env'),'AI_API_KEY=private-server-secret\n');
  const previous = { ...release,CET_RELEASE_COMMIT:previousCommit };
  const next = { ...release,CET_WEB_IMAGE:image('web','d') };
  writeFileSync(join(root,'.deployment/current.env'),serializeRelease(previous));
  writeFileSync(join(root,'.deployment/rollback.env'),serializeRelease(previous));
  writeFileSync(join(root,`.deployment/${commit}.env`),serializeRelease(next));
  writeFileSync(join(root,`.deployment/${commit}.plan`),'migrate=0\nreset_jobs=0\nstop_services=""\nstart_services="web"\n');
  const docker = `#!/usr/bin/env node\nconst fs=require('fs'); const args=process.argv.slice(2);fs.appendFileSync(process.env.DEPLOY_TEST_LOG,JSON.stringify(args)+'\\n');if(args[0]==='inspect')process.stdout.write('running\\n');else if(args.includes('ps')&&args.includes('-q'))process.stdout.write('test-container\\n');else if(${failUpdate}&&args.includes('up')&&args.at(-1)==='web')process.exit(42);\n`;
  writeFileSync(join(root,'bin/docker'),docker,{mode:0o755});
  writeFileSync(join(root,'bin/curl'),`#!/bin/sh\nexit ${failHealth?1:0}\n`,{mode:0o755});
  const log=join(root,'commands.log');
  const run=phase=>spawnSync('bash',[join(root,'scripts/deploy-server.sh'),root,phase,commit],{encoding:'utf8',env:{...process.env,PATH:`${join(root,'bin')}:${process.env.PATH}`,DEPLOY_TEST_LOG:log}});
  const calls=()=>readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  return {root,run,calls,previous,next};
}

test('real deployment script updates only Web without building, stopping backends or running SQL', t => {
  const f=fixture(t); const applied=f.run('apply'); assert.equal(applied.status,0,applied.stderr);
  const verified=f.run('verify'); assert.equal(verified.status,0,verified.stderr);
  const calls=f.calls();
  assert(calls.some(args=>args.includes('up')&&args.at(-1)==='web'));
  assert(calls.every(args=>!args.includes('build')&&!args.includes('stop')&&!args.includes('psql')));
  assert.deepEqual(parseRelease(readFileSync(join(f.root,'.deployment/current.env'),'utf8')),f.next);
  assert.equal(existsSync(join(f.root,`.deployment/${commit}.applying`)),false);
  assert(!applied.stdout.includes('private-server-secret'));
});

test('an image update failure restores the previous release and preserves the failure status', t => {
  const f=fixture(t,{failUpdate:true}); const applied=f.run('apply'); assert.equal(applied.status,42,applied.stderr);
  assert(f.calls().some(args=>args.includes('up')&&args.slice(-4).join(' ')==='api worker news web'));
  assert.deepEqual(parseRelease(readFileSync(join(f.root,'.deployment/current.env'),'utf8')),f.previous);
});

test('failed health checks restore the previous image manifest instead of marking a release successful', t => {
  const f=fixture(t,{failHealth:true}); assert.equal(f.run('apply').status,0);
  const verified=f.run('verify'); assert.notEqual(verified.status,0);
  assert(f.calls().some(args=>args.includes('up')&&args.slice(-4).join(' ')==='api worker news web'));
  assert.deepEqual(parseRelease(readFileSync(join(f.root,'.deployment/current.env'),'utf8')),f.previous);
});


test('real worker deployment stops both producers before resetting jobs and leaves the API running', t => {
  const f=fixture(t);
  writeFileSync(join(f.root,`.deployment/${commit}.env`),serializeRelease({...f.previous,CET_RELEASE_COMMIT:commit,CET_WORKER_IMAGE:image('worker','e'),CET_NEWS_IMAGE:image('worker','e')}));
  writeFileSync(join(f.root,`.deployment/${commit}.plan`),'migrate=0\nreset_jobs=1\nstop_services="worker news"\nstart_services="worker news"\n');
  const result=f.run('apply'); assert.equal(result.status,0,result.stderr);
  const calls=f.calls(), stop=calls.findIndex(args=>args.includes('stop')), reset=calls.findIndex(args=>args.includes('psql'));
  assert(stop>=0 && reset>stop); assert.deepEqual(calls[stop].slice(-2),['worker','news']);
  assert(calls.some(args=>args.includes('up')&&args.slice(-2).join(' ')==='worker news'));
  assert(calls.every(args=>!args.includes('build') && !(args.includes('stop')&&args.includes('api'))));
});


test('a cache-only deployment keeps the previous distinct release available for manual rollback', t => {
  const f=fixture(t);
  const older={...f.previous,CET_WEB_IMAGE:image('web','f')};
  writeFileSync(join(f.root,'.deployment/previous.env'),serializeRelease(older));
  writeFileSync(join(f.root,`.deployment/${commit}.env`),serializeRelease({...f.previous,CET_RELEASE_COMMIT:commit}));
  writeFileSync(join(f.root,`.deployment/${commit}.plan`),'migrate=0\nreset_jobs=0\nstop_services=""\nstart_services=""\n');
  const applied=f.run('apply'); assert.equal(applied.status,0,applied.stderr);
  const verified=f.run('verify'); assert.equal(verified.status,0,verified.stderr);
  assert.deepEqual(parseRelease(readFileSync(join(f.root,'.deployment/previous.env'),'utf8')),older);
  assert(f.calls().filter(args=>args.includes('up')).every(args=>args.at(-1)==='postgres'));
});
