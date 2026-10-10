type QueueOptions<Job> = {
  claim: () => Promise<Job | null>;
  process: (job: Job) => Promise<void>;
  concurrency: number;
  signal: AbortSignal;
  idleMs?: number;
};

// Fill available slots immediately; a slow sentence must not block every reader.
export async function runJobQueue<Job>({ claim, process, concurrency, signal, idleMs = 1_000 }: QueueOptions<Job>) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid worker concurrency');
  const active = new Set<Promise<void>>();
  let failed = false;
  let failure: unknown;
  try {
    while (!signal.aborted) {
      if (failed) throw failure;
      if (active.size >= concurrency) {
        await Promise.race(active);
        continue;
      }
      const job = await claim();
      if (job) {
        let work: Promise<void>;
        work = Promise.resolve().then(() => process(job)).catch(error => {
          failed = true;
          failure = error;
        }).finally(() => active.delete(work));
        active.add(work);
      } else {
        // Wake when a slot finishes, the idle poll expires, or shutdown starts.
        let timer: ReturnType<typeof setTimeout>;
        let wake!: () => void;
        const idle = new Promise<void>(resolve => {
          wake = resolve;
          timer = setTimeout(resolve, idleMs);
          signal.addEventListener('abort', wake, { once: true });
          if (signal.aborted) resolve();
        });
        await Promise.race([idle, ...active]);
        clearTimeout(timer!);
        signal.removeEventListener('abort', wake);
      }
    }
  } finally {
    await Promise.allSettled(active);
  }
  if (failed) throw failure;
}
