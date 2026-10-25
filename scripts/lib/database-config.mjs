export function databaseMode(env) {
  const mode = env.CET_DATABASE_MODE || 'local';
  if (!['local', 'external'].includes(mode)) throw new Error('CET_DATABASE_MODE must be local or external');
  return mode;
}

export function databaseClientEnvironment(env) {
  if (databaseMode(env) !== 'external') throw new Error('External database configuration required');
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { throw new Error('Invalid external DATABASE_URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || url.pathname.length < 2) {
    throw new Error('External DATABASE_URL requires a PostgreSQL host, username, password and database');
  }
  if (url.searchParams.get('sslmode') !== 'verify-full') throw new Error('External DATABASE_URL requires sslmode=verify-full');
  const values = {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: 'system',
    PGAPPNAME: 'cet-reading-deployment',
  };
  if (Object.values(values).some(value => /[\r\n\0]/.test(value))) throw new Error('Database connection values cannot contain line breaks or null bytes');
  return values;
}
