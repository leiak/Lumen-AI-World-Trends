export interface SchedulerDeps {
  job: () => Promise<void>;
  intervalMs: number;
  onError?: (e: unknown) => void;
}

export function startScheduler({ job, intervalMs, onError }: SchedulerDeps): () => void {
  let running = false;
  let stopped = false;

  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await job();
    } catch (e) {
      onError?.(e);
    } finally {
      running = false;
    }
  };

  void run();

  const timer = setInterval(() => {
    void run();
  }, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

const DEFAULT_MINUTES = 30;

export function resolveIntervalMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.LUMEN_INTERVAL_MINUTES);
  const minutes = Number.isFinite(n) && n >= 1 ? n : DEFAULT_MINUTES;
  return Math.round(minutes * 60000);
}
