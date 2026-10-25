import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { databaseMode, databaseClientEnvironment } from './lib/database-config.mjs';

const [command, envPath, output] = process.argv.slice(2);
try {
  const env = parseEnv(readFileSync(envPath, 'utf8'));
  if (command === 'mode') {
    const mode = databaseMode(env);
    if (mode === 'external') databaseClientEnvironment(env);
    process.stdout.write(mode);
  } else if (command === 'client-env') {
    const values = databaseClientEnvironment(env);
    writeFileSync(output, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600 });
    chmodSync(output, 0o600);
  } else throw new Error('Unknown database configuration command');
} catch (error) {
  // Do not print input URLs or a parser error containing credentials.
  console.error(error instanceof URIError ? 'Invalid URL encoding in database configuration' : error.message);
  process.exitCode = 1;
}
