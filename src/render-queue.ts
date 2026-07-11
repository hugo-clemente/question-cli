export type RenderQueue = {
  schedule(): void;
  flush(): Promise<void>;
  cancel(): void;
};

export function createRenderQueue(edit: () => Promise<void>, debounceMs: number): RenderQueue {
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let pending = false;

  const run = async (): Promise<void> => {
    do {
      pending = false;
      await edit();
    } while (pending);
  };

  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending = true;

    if (inFlight) {
      await inFlight;
      if (!pending) return;
    }

    inFlight = run();
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  };

  return {
    schedule() {
      pending = true;
      if (timer || inFlight) return;
      timer = setTimeout(() => {
        timer = null;
        void flush().catch(() => undefined);
      }, debounceMs);
    },
    flush,
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = false;
    },
  };
}
