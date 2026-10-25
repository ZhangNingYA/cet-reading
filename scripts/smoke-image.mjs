import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
await import('@cet-reading/contracts');
await import('@cet-reading/contracts/article-chat');
await import('pg');
for (const dependency of ['typescript', 'tsx', 'astro']) {
  await assert.rejects(import(dependency), error => error.code === 'ERR_MODULE_NOT_FOUND', `Production image includes development dependency: ${dependency}`);
}
if (process.env.CET_IMAGE_KIND === 'worker') {
  await import('./apps/worker/dist/ai-analysis.js');
  await import('./apps/worker/dist/news-selector.js');
  console.log('Worker and News production dependencies load successfully.');
} else {
  const sharp = (await import('sharp')).default;
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
  assert.equal((await sharp(image).metadata()).width, 8);
  const child = spawn(process.execPath, ['apps/api/dist/server.js'], {
    env: { ...process.env, AI_DRY_RUN: 'true', PORT: '3000' }, stdio: 'inherit',
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (child.exitCode !== null) throw new Error('API exited before becoming healthy');
      try { ready = (await fetch('http://127.0.0.1:3000/healthz')).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert(ready, 'Production API must become healthy');
    const invalid = await fetch('http://127.0.0.1:3000/api/article-chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(invalid.status, 400);
    console.log('Production API starts and validates requests without development dependencies.');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
  }
}
