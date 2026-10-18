type Preferences = {
  size: number;
  leading: number;
  theme: 'paper' | 'light' | 'night';
  font: 'serif' | 'sans';
  width: 'comfortable' | 'wide';
  focus: boolean;
};

const storageKey = 'cet-reading:reader-preferences';
const defaults: Preferences = { size: 20, leading: 1.9, theme: 'paper', font: 'serif', width: 'comfortable', focus: false };

function readPreferences(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || '{}');
    return {
      size: [18, 20, 22, 24].includes(value?.size) ? value.size : defaults.size,
      leading: [1.7, 1.9, 2.1].includes(value?.leading) ? value.leading : defaults.leading,
      theme: ['paper', 'light', 'night'].includes(value?.theme) ? value.theme : defaults.theme,
      font: value?.font === 'sans' ? 'sans' : 'serif',
      width: value?.width === 'wide' ? 'wide' : 'comfortable',
      focus: value?.focus === true,
    };
  } catch { return { ...defaults }; }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createReaderToolbar(onFocusChange: (focus: boolean) => void) {
  const preferences = readPreferences();
  const controller = new AbortController();
  const toolbar = element('div', 'reading-toolbar');
  const info = element('div', 'reading-toolbar-info');
  const stats = element('span', 'reading-stats');
  info.append(element('span', 'reading-eyebrow', 'READING ROOM'), stats);
  const actions = element('div', 'reading-toolbar-actions');
  const focus = element('button', 'reading-focus', '专注阅读');
  focus.type = 'button';
  focus.title = '关闭单词和句子的点击解析，安静阅读正文';
  const settings = element('button', 'reading-settings-trigger');
  settings.type = 'button';
  settings.append(element('span', 'reading-settings-icon', 'Aa'), element('span', '', '阅读设置'));
  settings.setAttribute('aria-expanded', 'false');
  settings.setAttribute('aria-controls', 'reading-settings');
  const panel = element('section', 'reading-settings');
  panel.id = 'reading-settings';
  panel.hidden = true;
  panel.setAttribute('aria-label', '阅读设置');
  const heading = element('div', 'reading-settings-heading');
  const close = element('button', 'reading-settings-close', '完成');
  close.type = 'button';
  heading.append(element('strong', '', '让阅读更舒服'), close);
  panel.append(heading);
  const controls: (() => void)[] = [];

  function choices<K extends keyof Preferences>(key: K, label: string, values: [Preferences[K], string][]) {
    const group = element('div', `reading-setting reading-setting-${key}`);
    const labelNode = element('span', 'reading-setting-label', label);
    labelNode.id = `reading-setting-${key}`;
    const options = element('div', 'reading-setting-options');
    options.setAttribute('role', 'group');
    options.setAttribute('aria-labelledby', labelNode.id);
    for (const [value, text] of values) {
      const button = element('button', 'reading-setting-option', text);
      button.type = 'button';
      button.dataset.value = String(value);
      button.addEventListener('click', () => { preferences[key] = value; apply(); });
      controls.push(() => button.setAttribute('aria-pressed', String(preferences[key] === value)));
      options.append(button);
    }
    group.append(labelNode, options);
    panel.append(group);
  }

  choices('size', '字号', [[18, '18'], [20, '20'], [22, '22'], [24, '24']]);
  choices('font', '字体', [['serif', '衬线'], ['sans', '无衬线']]);
  choices('leading', '行距', [[1.7, '紧凑'], [1.9, '适中'], [2.1, '宽松']]);
  choices('theme', '背景', [['light', '明亮'], ['paper', '暖纸'], ['night', '夜间']]);
  choices('width', '版心', [['comfortable', '舒适'], ['wide', '宽屏']]);
  const reset = element('button', 'reading-settings-reset', '恢复默认设置');
  reset.type = 'button';
  reset.addEventListener('click', () => { Object.assign(preferences, defaults); apply(); });
  panel.append(reset);

  function toggleSettings(open: boolean, restoreFocus = false) {
    panel.hidden = !open;
    settings.setAttribute('aria-expanded', String(open));
    if (open) close.focus({ preventScroll: true });
    else if (restoreFocus) settings.focus({ preventScroll: true });
  }
  settings.addEventListener('click', () => toggleSettings(panel.hidden));
  close.addEventListener('click', () => toggleSettings(false, true));
  document.addEventListener('click', event => {
    if (event.target instanceof Node && !toolbar.contains(event.target)) toggleSettings(false);
  }, { signal: controller.signal });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) {
      event.stopImmediatePropagation();
      toggleSettings(false, true);
    }
  }, { signal: controller.signal });
  focus.addEventListener('click', () => { preferences.focus = !preferences.focus; apply(); });

  function apply() {
    document.body.classList.add('reading-room');
    document.body.dataset.readerTheme = preferences.theme;
    document.body.dataset.readerFont = preferences.font;
    document.body.dataset.readerWidth = preferences.width;
    document.body.classList.toggle('is-focus-reading', preferences.focus);
    document.body.style.setProperty('--reader-font-size', `${preferences.size / 16}rem`);
    document.body.style.setProperty('--reader-line-height', String(preferences.leading));
    focus.setAttribute('aria-pressed', String(preferences.focus));
    focus.title = preferences.focus ? '恢复单词和句子的点击解析' : '关闭单词和句子的点击解析，安静阅读正文';
    controls.forEach(update => update());
    onFocusChange(preferences.focus);
    try { localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch { /* Reading remains available without storage. */ }
  }
  actions.append(focus, settings);
  toolbar.append(info, actions, panel);
  apply();
  return {
    element: toolbar,
    isFocusReading: () => preferences.focus,
    updateStats(text: string) {
      const count = text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)?.length ?? 0;
      stats.textContent = count ? `${count.toLocaleString('zh-CN')} 词 · 约 ${Math.max(1, Math.ceil(count / 180))} 分钟` : '慢慢读，读懂每一句';
    },
    dispose() {
      controller.abort();
      document.body.classList.remove('reading-room', 'is-focus-reading', 'has-reading-analysis');
      delete document.body.dataset.readerTheme;
      delete document.body.dataset.readerFont;
      delete document.body.dataset.readerWidth;
      document.body.style.removeProperty('--reader-font-size');
      document.body.style.removeProperty('--reader-line-height');
    },
  };
}
