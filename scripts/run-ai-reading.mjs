import { accessSync, constants } from 'node:fs';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const localTsx = 'node_modules/.bin/tsx';

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit' });
  if (result.error) {
    process.stderr.write(`无法启动 ${command}: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

try {
  accessSync(localTsx, constants.X_OK);
  process.exitCode = run('npm', ['run', 'analyze-paper', '--workspace', 'apps/worker', '--', ...args]);
} catch {
  process.stderr.write('本地 Node 依赖未安装，改用 Docker Worker 运行 AI 精读工具。\n');
  process.stderr.write('Docker 模式会自动构建最新 Worker 镜像，并需要 PostgreSQL 服务已启动。\n');
  process.exitCode = run('docker', [
    'compose', 'run', '--build', '--rm', '--no-deps', 'worker',
    'node', 'apps/worker/dist/analyze-paper.js', ...args,
  ]);
}
