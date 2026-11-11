// Reader layout and word counts are independent of the site's appearance setting.
export function createReaderToolbar(target: HTMLElement, options: { appearanceOnly?: boolean } = {}) {
  const root = target.closest('.reader-section') ?? target;
  const details = root.querySelector<HTMLElement>('[data-reading-details]') ?? target;
  const stats = document.createElement('span');
  stats.className = 'reading-stats';
  if (!options.appearanceOnly) details.append(stats);
  document.body.classList.add('reading-room');
  document.body.classList.toggle('reading-practice', Boolean(options.appearanceOnly));
  return {
    updateStats(text: string) {
      const count = text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)?.length ?? 0;
      stats.textContent = count ? `${count.toLocaleString('zh-CN')} 词 · 约 ${Math.max(1, Math.ceil(count / 180))} 分钟` : '慢慢读，读懂每一句';
    },
    dispose() {
      stats.remove();
      document.body.classList.remove('reading-room', 'reading-practice');
    },
  };
}
