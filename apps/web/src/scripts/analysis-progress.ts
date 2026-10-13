type Counts = { total: number; cached: number; pending: number; running: number; failed: number };

export function formatAnalysisProgress(label: string, counts: Counts) {
  const cached = Math.min(counts.total, counts.cached);
  const states = [];
  if (counts.pending) states.push(`${counts.pending} 条排队`);
  if (counts.running) states.push(`${counts.running} 条生成中`);
  if (counts.failed) states.push(`${counts.failed} 条失败`);
  return `${label} ${cached}/${counts.total}（${((cached / counts.total) * 100).toFixed(1)}%）${states.length ? ` · ${states.join(' · ')}` : ''}`;
}

export function paperProgressEntries(paper: object) {
  const values = paper as Record<string, unknown>;
  return ([['analysis', '文章精读'], ['analysis_text', '题面精读'], ['analysis_solving', '做题精读']] as const)
    .flatMap(([prefix, label]) => {
      const counts = Object.fromEntries(['total', 'cached', 'pending', 'running', 'failed']
        .map(key => [key, Number(values[`${prefix}_${key}`] ?? 0)])) as Counts;
      return counts.total ? [formatAnalysisProgress(label, counts)] : [];
    });
}
