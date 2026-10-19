import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { makeRelease, parseRelease, serializeRelease, planDeployment } from './lib/deployment-plan.mjs';

const [command, ...args] = process.argv.slice(2);
if (command === 'prepare') {
  const [directory, prefix, commit, output] = args;
  const images = Object.fromEntries(['api', 'worker', 'web'].map(name => [name, readFileSync(join(directory, `${name}.image`), 'utf8')]));
  writeFileSync(output, serializeRelease(makeRelease(prefix, commit, images)), { mode: 0o600 });
} else if (command === 'plan') {
  const [currentPath, nextPath] = args;
  const previous = existsSync(currentPath) ? parseRelease(readFileSync(currentPath, 'utf8'), { local: true }) : null;
  const next = parseRelease(readFileSync(nextPath, 'utf8'));
  let paths = [];
  if (previous) {
    // Missing history is treated as a full deployment, never as a safe frontend-only change.
    try { paths = execFileSync('git', ['diff', '--name-only', previous.CET_RELEASE_COMMIT, next.CET_RELEASE_COMMIT, '--'], { encoding: 'utf8' }).trim().split('\n'); }
    catch { paths = ['db/migrations/unknown']; }
  }
  const plan = planDeployment(previous, next, paths);
  process.stdout.write(`migrate=${Number(plan.migrate)}\nreset_jobs=${Number(plan.resetJobs)}\nstop_services="${plan.stop.join(' ')}"\nstart_services="${plan.start.join(' ')}"\n`);
} else if (command === 'validate') {
  parseRelease(readFileSync(args[0], 'utf8'), { local: args[1] === '--local' });
} else throw new Error('Unknown deployment release command');
