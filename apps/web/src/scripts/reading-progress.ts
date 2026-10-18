export type ReadingBoard = 'cet4' | 'cet6' | 'postgraduate' | 'news';

export type ReadingProgress = {
  itemId: string;
  mode: 'intensive' | 'practice';
  sectionId?: string;
  sentenceId?: string;
  sectionTitle?: string;
  sentenceNumber?: number;
  sentencePreview?: string;
  updatedAt?: number | string;
};

export function createReadingProgressStore(apiBase: string, board: ReadingBoard, legacyKey?: string) {
  let current: ReadingProgress | null = null;
  let pending: ReadingProgress | null = null;
  let loadPromise: Promise<ReadingProgress | null> | null = null;
  let flushPromise: Promise<void> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function readLegacy(): ReadingProgress | null {
    if (!legacyKey) return null;
    try {
      const value = JSON.parse(localStorage.getItem(legacyKey) || 'null');
      const itemId = typeof value?.itemId === 'string' ? value.itemId : value?.paperId;
      if (typeof itemId !== 'string' || !itemId || !['intensive', 'practice'].includes(value.mode)) return null;
      return {
        itemId,
        mode: value.mode,
        ...(typeof value.sectionId === 'string' ? { sectionId: value.sectionId } : {}),
        ...(typeof value.sentenceId === 'string' ? { sentenceId: value.sentenceId } : {}),
        ...(typeof value.sectionTitle === 'string' ? { sectionTitle: value.sectionTitle } : {}),
        ...(Number.isInteger(value.sentenceNumber) ? { sentenceNumber: value.sentenceNumber } : {}),
        ...(typeof value.sentencePreview === 'string' ? { sentencePreview: value.sentencePreview } : {}),
        ...(typeof value.updatedAt === 'number' ? { updatedAt: value.updatedAt } : {}),
      };
    } catch {
      return null;
    }
  }

  function mirror(progress: ReadingProgress | null) {
    if (!legacyKey) return;
    try {
      if (!progress) localStorage.removeItem(legacyKey);
      else localStorage.setItem(legacyKey, JSON.stringify({
        paperId: progress.itemId,
        mode: progress.mode,
        sectionId: progress.sectionId,
        sentenceId: progress.sentenceId,
        sectionTitle: progress.sectionTitle,
        sentenceNumber: progress.sentenceNumber,
        sentencePreview: progress.sentencePreview,
        updatedAt: progress.updatedAt,
      }));
    } catch {
      // Storage is a fallback only; the server record remains authoritative.
    }
  }

  async function request(method: string, progress?: ReadingProgress) {
    const response = await fetch(`${apiBase}/api/reading-progress/${board}`, {
      method,
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
      headers: progress ? { 'Content-Type': 'application/json' } : undefined,
      body: progress ? JSON.stringify(progress) : undefined,
    });
    if (!response.ok) throw new Error('Reading progress request failed');
    return response.status === 204 ? null : response.json();
  }

  async function load() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const legacy = readLegacy();
      try {
        const result = await request('GET');
        if (result?.progress) {
          current = result.progress;
          mirror(current);
          return current;
        }
        current = legacy;
        if (legacy) {
          try {
            const imported = await request('PUT', legacy);
            current = imported?.progress ?? legacy;
            mirror(current);
          } catch {
            mirror(legacy);
          }
        }
        return current;
      } catch {
        current = legacy;
        return current;
      }
    })();
    return loadPromise;
  }

  async function flush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    if (flushPromise) {
      await flushPromise;
      if (pending) return flush();
      return;
    }
    if (!pending) return;
    flushPromise = (async () => {
      while (pending) {
        const next = pending;
        pending = null;
        try {
          const result = await request('PUT', next);
          if (!pending && current === next) current = result?.progress ?? next;
        } catch {
          // Keep the mirrored local value and retry on the next position change.
        }
      }
    })();
    await flushPromise;
    flushPromise = null;
  }

  function save(progress: ReadingProgress) {
    current = progress;
    mirror(progress);
    pending = progress;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, 250);
  }

  async function clear() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    pending = null;
    current = null;
    mirror(null);
    if (flushPromise) await flushPromise;
    try {
      await request('DELETE');
    } catch {
      // The local fallback is cleared even if the server is unavailable.
    }
  }

  window.addEventListener('pagehide', () => { void flush(); });

  return {
    load,
    read: () => current,
    save,
    clear,
    flush,
  };
}
