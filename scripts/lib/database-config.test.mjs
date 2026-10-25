import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { databaseMode, databaseClientEnvironment } from './database-config.mjs';

const env = { CET_DATABASE_MODE: 'external', DATABASE_URL: 'postgresql://reader:p%2Fa%40ss%24word@db.postgres.database.azure.com:5432/cet_reading?sslmode=verify-full' };
test('local remains the default and an unknown database mode is rejected', () => {
  assert.equal(databaseMode({}), 'local');
  assert.equal(databaseMode(env), 'external');
  assert.throws(() => databaseMode({ CET_DATABASE_MODE: 'other' }));
});
test('external clients decode credentials and verify the server using system roots', () => {
  const values = databaseClientEnvironment(env);
  assert.equal(values.PGPASSWORD, 'p/a@ss$word');
  assert.equal(values.PGHOST, 'db.postgres.database.azure.com');
  assert.equal(values.PGDATABASE, 'cet_reading');
  assert.equal(values.PGSSLMODE, 'verify-full');
  assert.equal(values.PGSSLROOTCERT, 'system');
});
test('missing credentials, disabled TLS and newline injection are rejected', () => {
  for (const value of [undefined, 'not-a-url', env.DATABASE_URL.replace('verify-full', 'disable'), env.DATABASE_URL.replace('reader:', ':'), env.DATABASE_URL.replace('p%2Fa%40ss%24word', 'p%0Ass')]) {
    assert.throws(() => databaseClientEnvironment({ ...env, DATABASE_URL: value }));
  }
});
test('CLI writes a private client environment without displaying credentials', t => {
  const root = mkdtempSync(join(tmpdir(), 'cet-db-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, '.env'), output = join(root, 'client.env');
  writeFileSync(source, `CET_DATABASE_MODE=external\nDATABASE_URL='${env.DATABASE_URL}'\n`);
  const run = command => spawnSync(process.execPath, [resolve('scripts/database-config.mjs'), command, source, output], { encoding: 'utf8' });
  assert.equal(run('mode').stdout, 'external');
  const result = run('client-env');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.match(readFileSync(output, 'utf8'), /PGPASSWORD=p\/a@ss\$word/);
  if (process.platform !== 'win32') assert.equal(statSync(output).mode & 0o777, 0o600);
  chmodSync(output, 0o600);
});
