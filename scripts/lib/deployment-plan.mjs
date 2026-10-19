const services = ['api', 'worker', 'news', 'web'];
const keyFor = name => `CET_${name.toUpperCase()}_IMAGE`;
export function parseRelease(text, { local = false } = {}) {
  const release = {};
  for (const line of text.trim().split('\n')) {
    const match = /^(CET_(?:API|WORKER|NEWS|WEB)_IMAGE|CET_RELEASE_COMMIT)=(\S+)$/.exec(line);
    if (!match || Object.hasOwn(release, match[1])) throw new Error('Invalid release manifest');
    release[match[1]] = match[2];
  }
  if (!/^[a-f0-9]{40}$/.test(release.CET_RELEASE_COMMIT ?? '')) throw new Error('Invalid release commit');
  for (const service of services) {
    const value = release[keyFor(service)] ?? '';
    if (!/^ghcr\.io\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(value) && !(local && /^sha256:[a-f0-9]{64}$/.test(value))) throw new Error(`Invalid ${service} image digest`);
  }
  return release;
}
export function serializeRelease(release) {
  parseRelease(Object.entries(release).map(([key, value]) => `${key}=${value}`).join('\n'), { local: true });
  return `${Object.entries(release).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}
export function makeRelease(prefix, commit, imageFiles) {
  if (!/^ghcr\.io\/[a-z0-9._-]+\/[a-z0-9._-]+$/.test(prefix)) throw new Error('Invalid image registry prefix');
  const release = { CET_RELEASE_COMMIT: commit };
  for (const name of ['api', 'worker', 'web']) {
    const image = imageFiles[name]?.trim();
    if (!image?.startsWith(`${prefix}/${name}@sha256:`)) throw new Error(`Release artifact does not match ${name}`);
    release[keyFor(name)] = image;
  }
  release.CET_NEWS_IMAGE = release.CET_WORKER_IMAGE;
  return parseRelease(serializeRelease(release));
}
export function planDeployment(previous, next, changedPaths) {
  const migrate = !previous || changedPaths.some(path => /^(?:db\/(?:migrations|init)\/|data\/papers\/|scripts\/(?:generate-paper-seed\.mjs|lib\/paper-sources\.mjs)$)/.test(path));
  const changed = services.filter(name => previous?.[keyFor(name)] !== next[keyFor(name)]);
  const stop = new Set();
  if (migrate) ['api', 'worker', 'news'].forEach(name => stop.add(name));
  if (changed.includes('worker') || changed.includes('news')) ['worker', 'news'].forEach(name => stop.add(name));
  return { migrate, resetJobs: stop.has('worker'), stop: [...stop], start: [...new Set([...changed, ...stop])] };
}
