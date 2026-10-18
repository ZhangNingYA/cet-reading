const storageKey = 'cet-reading:reader-preferences';

function readNightMode() {
  try { return JSON.parse(localStorage.getItem(storageKey) || '{}')?.theme === 'night'; }
  catch { return false; }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createReaderToolbar() {
  let night = readNightMode();
  const toolbar = element('div', 'reading-toolbar');
  const info = element('div', 'reading-toolbar-info');
  const stats = element('span', 'reading-stats');
  info.append(element('span', 'reading-eyebrow', 'READING ROOM'), stats);
  const toggle = element('button', 'reading-night-toggle');
  toggle.type = 'button';
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const moon = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  moon.setAttribute('d', 'M20.5 13.2A8.5 8.5 0 0 1 10.8 3.5 8.5 8.5 0 1 0 20.5 13.2Z');
  icon.append(moon);
  toggle.append(icon, element('span', '', '夜间模式'));
  toggle.addEventListener('click', () => { night = !night; apply(); });

  function apply() {
    document.body.classList.add('reading-room');
    document.body.dataset.readerTheme = night ? 'night' : 'paper';
    toggle.setAttribute('aria-pressed', String(night));
    toggle.title = night ? '切换为日间模式' : '切换为夜间模式';
    // Retain the existing night preference; typography now has one curated default.
    try { localStorage.setItem(storageKey, JSON.stringify({ theme: night ? 'night' : 'paper' })); }
    catch { /* Reading remains available without browser storage. */ }
  }
  toolbar.append(info, toggle);
  apply();
  return {
    element: toolbar,
    updateStats(text: string) {
      const count = text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)?.length ?? 0;
      stats.textContent = count ? `${count.toLocaleString('zh-CN')} 词 · 约 ${Math.max(1, Math.ceil(count / 180))} 分钟` : '慢慢读，读懂每一句';
    },
    dispose() {
      document.body.classList.remove('reading-room');
      delete document.body.dataset.readerTheme;
    },
  };
}
