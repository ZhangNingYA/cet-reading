const storageKey = 'cet-reading:reader-preferences';
const themes = [
  { id: 'paper', name: '纸张', description: '温润暖白' },
  { id: 'light', name: '明亮', description: '清爽浅灰' },
  { id: 'sage', name: '青绿', description: '柔和浅绿' },
  { id: 'night', name: '夜间', description: '低亮深灰' },
] as const;
type Theme = typeof themes[number]['id'];

function readTheme(): Theme {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}')?.theme;
    return themes.find(theme => theme.id === saved)?.id ?? 'paper';
  } catch { return 'paper'; }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createReaderToolbar(target: HTMLElement, options: { appearanceOnly?: boolean } = {}) {
  let theme = readTheme();
  const controller = new AbortController();
  const root = target.closest('.reader-section') ?? target;
  const actions = root.querySelector<HTMLElement>('[data-reader-actions]') ?? target;
  const details = root.querySelector<HTMLElement>('[data-reading-details]') ?? target;
  const stats = element('span', 'reading-stats');
  const existingSwitch = actions.querySelector<HTMLElement>('.mode-switch');
  const modeSwitch = existingSwitch ?? element('div', 'mode-switch');
  const picker = element('details', 'reading-mode-picker');
  const trigger = element('summary', 'reading-mode-trigger');
  const swatch = element('span', 'reading-mode-dot');
  swatch.setAttribute('aria-hidden', 'true');
  const label = element('span', 'reading-mode-label');
  const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chevron.setAttribute('viewBox', '0 0 16 16');
  chevron.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'm4 6 4 4 4-4');
  chevron.append(path);
  trigger.append(swatch, label, chevron);
  const panel = element('div', 'reading-mode-panel');
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', '阅读配色');
  panel.append(element('p', 'reading-mode-heading', '阅读模式'));
  const choices = element('div', 'reading-mode-choices');
  const buttons = new Map<Theme, HTMLButtonElement>();
  for (const preset of themes) {
    const button = element('button', 'reading-mode-option');
    button.type = 'button';
    button.dataset.readingTheme = preset.id;
    const preview = element('span', 'reading-mode-preview', 'Aa');
    preview.setAttribute('aria-hidden', 'true');
    const copy = element('span', 'reading-mode-copy');
    copy.append(element('strong', '', preset.name), element('span', '', preset.description));
    button.append(preview, copy);
    button.addEventListener('click', () => {
      theme = preset.id;
      apply();
      picker.open = false;
      trigger.focus({ preventScroll: true });
    });
    choices.append(button);
    buttons.set(preset.id, button);
  }
  panel.append(choices);
  picker.append(trigger, panel);
  modeSwitch.append(picker);
  if (!existingSwitch) actions.append(modeSwitch);
  if (!options.appearanceOnly) details.append(stats);
  document.addEventListener('click', event => {
    if (event.target instanceof Node && !picker.contains(event.target)) picker.open = false;
  }, { signal: controller.signal });
  picker.addEventListener('keydown', event => {
    if (event.key === 'Escape' && picker.open) {
      event.stopPropagation();
      picker.open = false;
      trigger.focus({ preventScroll: true });
    }
  });
  picker.addEventListener('focusout', event => {
    if (event.relatedTarget instanceof Node && !picker.contains(event.relatedTarget)) picker.open = false;
  });

  function apply() {
    document.body.classList.add('reading-room');
    document.body.classList.toggle('reading-practice', Boolean(options.appearanceOnly));
    document.body.dataset.readerTheme = theme;
    picker.dataset.readingTheme = theme;
    label.textContent = themes.find(preset => preset.id === theme)!.name;
    trigger.setAttribute('aria-label', `阅读模式：${label.textContent}`);
    for (const [id, button] of buttons) button.setAttribute('aria-pressed', String(id === theme));
    try { localStorage.setItem(storageKey, JSON.stringify({ theme })); }
    catch { /* Reading remains available without browser storage. */ }
  }
  apply();
  return {
    updateStats(text: string) {
      const count = text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)?.length ?? 0;
      stats.textContent = count ? `${count.toLocaleString('zh-CN')} 词 · 约 ${Math.max(1, Math.ceil(count / 180))} 分钟` : '慢慢读，读懂每一句';
    },
    dispose() {
      controller.abort();
      picker.remove();
      if (!existingSwitch) modeSwitch.remove();
      stats.remove();
      document.body.classList.remove('reading-room', 'reading-practice');
      delete document.body.dataset.readerTheme;
    },
  };
}
