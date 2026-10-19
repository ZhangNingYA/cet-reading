import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('the production Web smoke test waits through a reset connection during container startup', async t => {
  let requests=0;
  const server=createServer((request,response)=>{
    requests++;
    if(requests===1){request.socket.destroy();return;}
    response.end(request.url==='/'?'<main class="home-section container"></main>':'<section id="library"></section>');
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const directory=await mkdtemp(join(tmpdir(),'cet-smoke-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await writeFile(join(directory,'docker'),`#!/bin/sh\ncase "$1" in\nrun) echo test-container ;;\nport) echo 127.0.0.1:${server.address().port} ;;\nesac\n`,{mode:0o755});
  await promisify(execFile)('bash',[resolve('scripts/smoke-image.sh')],{
    env:{...process.env,PATH:`${directory}:${process.env.PATH}`,IMAGE:'test-image',IMAGE_KIND:'web'},timeout:15000,
  });
  assert.equal(requests,6,'Retry the reset homepage request, then verify all four library pages');
});
