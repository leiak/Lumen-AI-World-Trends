/**
 * P7：sql.js 每次落盘都是全库 export，不能每个事件/每个 checkpoint 都 export。
 * 所有写操作先写内存 DB，再由本调度器合并落盘：
 *  - 普通写入 request()：最多每 minIntervalMs 落盘一次（默认 1000ms）；
 *  - 终态/中断/启动恢复 flushNow()：立即落盘，保证可恢复边界完整。
 * 崩溃最多丢失 minIntervalMs 内的写入；具体窗口与 checkpoint 节流联动，见设计文档 §11 P7。
 */
export interface PersistSchedulerStats {
  requests: number;
  flushes: number;
  failures: number;
}

export interface PersistScheduler {
  /** 合并落盘（异步定时器，不阻塞调用方）。 */
  request(): void;
  /** 强制立即落盘；用于终态、审批挂起、启动恢复等关键边界。 */
  flushNow(): void;
  stats(): PersistSchedulerStats;
  dispose(): void;
}

export interface PersistSchedulerOptions {
  /** 连续写入时的最小落盘间隔；默认 1000ms。 */
  minIntervalMs?: number;
  onError?: (err: unknown) => void;
}

export function createPersistScheduler(
  persist: () => void,
  opts: PersistSchedulerOptions = {}
): PersistScheduler {
  const minIntervalMs = Math.max(1, opts.minIntervalMs ?? 1000);
  let pending = false;
  let lastFlushAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const counters: PersistSchedulerStats = { requests: 0, flushes: 0, failures: 0 };

  const run = (): void => {
    timer = null;
    if (!pending) return;
    pending = false;
    lastFlushAt = Date.now();
    try {
      persist();
      counters.flushes += 1;
    } catch (err) {
      counters.failures += 1;
      opts.onError?.(err);
    }
  };

  return {
    request() {
      counters.requests += 1;
      pending = true;
      if (timer) return;
      const elapsed = Date.now() - lastFlushAt;
      const delay = Math.max(0, minIntervalMs - elapsed);
      // 不阻塞进程退出：测试/关闭时靠 flushNow() 落盘。
      timer = setTimeout(run, delay);
      (timer as unknown as { unref?: () => void }).unref?.();
    },
    flushNow() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending = true;
      run();
    },
    stats() {
      return { ...counters };
    },
    dispose() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending = false;
    }
  };
}
