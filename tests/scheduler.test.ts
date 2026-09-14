import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startScheduler, resolveIntervalMs } from '../electron/main/scheduler.js';

describe('resolveIntervalMs', () => {
  it('默认 30 分钟', () => {
    expect(resolveIntervalMs({})).toBe(30 * 60000);
    expect(resolveIntervalMs({ LUMEN_INTERVAL_MINUTES: 'bad' })).toBe(30 * 60000);
  });
  it('按分钟解析且不小于 1', () => {
    expect(resolveIntervalMs({ LUMEN_INTERVAL_MINUTES: '5' })).toBe(5 * 60000);
    expect(resolveIntervalMs({ LUMEN_INTERVAL_MINUTES: '0' })).toBe(30 * 60000);
  });
});

describe('startScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('立即执行一次并随间隔重复，stop 后停止', async () => {
    let calls = 0;
    const job = async (): Promise<void> => {
      calls++;
    };
    const stop = startScheduler({ job, intervalMs: 1000, onError: () => undefined });
    expect(calls).toBe(1);
    // 异步推进：在每个定时器回调后冲刷微任务，避免 running 标志卡住下一次触发
    await vi.advanceTimersByTimeAsync(2500);
    expect(calls).toBe(3); // 立即 + 2 次间隔
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(3);
    vi.useRealTimers();
  });
});