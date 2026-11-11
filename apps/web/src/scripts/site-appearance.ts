const storageKey = 'cet-reading:appearance:v1';
const themes = ['paper', 'light', 'sage', 'night'] as const;
type Theme = typeof themes[number];
const picker = document.querySelector<HTMLDetailsElement>('[data-site-appearance]');
const trigger = picker?.querySelector('summary');
const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-site-theme]')];
const colors: Record<Theme, string> = { paper: '#faf9f5', light: '#f5f6f7', sage: '#f0f3ec', night: '#202326' };
function apply(theme: Theme, save = false) {
  document.documentElement.dataset.siteTheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colors[theme]);
  for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.siteTheme === theme));
  if (save) try { localStorage.setItem(storageKey, theme); } catch { /* Still usable for this visit. */ }
}
const initial = document.documentElement.dataset.siteTheme;
apply(themes.find(theme => theme === initial) || 'paper');
for (const button of buttons) button.onclick = () => {
  apply(button.dataset.siteTheme as Theme, true);
  if (picker) picker.open = false;
  trigger?.focus({ preventScroll: true });
};
document.addEventListener('click', event => {
  if (picker && event.target instanceof Node && !picker.contains(event.target)) picker.open = false;
});
picker?.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.stopPropagation(); picker.open = false; trigger?.focus({ preventScroll: true }); }
});
picker?.addEventListener('focusout', event => {
  if (event.relatedTarget instanceof Node && !picker.contains(event.relatedTarget)) picker.open = false;
});
window.addEventListener('storage', event => {
  if (event.key === storageKey) apply(themes.find(theme => theme === event.newValue) || 'paper');
});
