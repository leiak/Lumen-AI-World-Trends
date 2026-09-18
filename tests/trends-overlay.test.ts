import { describe, it, expect } from 'vitest';
import { buildOverlaySeries } from '../src/stocks/overlay';
import type { TrendPoint } from '../shared/trend';
import type { StockKPoint } from '../shared/stocks';

const buckets: TrendPoint[] = [
  { bucketStart: '2026-09-14T00:00:00.000Z', count: 3 },
  { bucketStart: '2026-09-15T00:00:00.000Z', count: 5 },
  { bucketStart: '2026-09-16T00:00:00.000Z', count: 2 },
  { bucketStart: '2026-09-17T00:00:00.000Z', count: 4 }
];

const kline: StockKPoint[] = [
  { date: '2026-09-14', open: 1, close: 3200, high: 1, low: 1, volume: 1 },
  { date: '2026-09-16', open: 1, close: 3260, high: 1, low: 1, volume: 1 },
  { date: '2026-09-18', open: 1, close: 3300, high: 1, low: 1, volume: 1 }
];

describe('buildOverlaySeries 大盘×热点叠线', () => {
  it('按日期前缀对齐，缺交易日为 null，x 用桶标签', () => {
    const s = buildOverlaySeries(buckets, kline);
    expect(s.x).toEqual(['09-14T00:00', '09-15T00:00', '09-16T00:00', '09-17T00:00']);
    expect(s.topic).toEqual([3, 5, 2, 4]);
    expect(s.close).toEqual([3200, null, 3260, null]);
  });

  it('空桶 / 空 K 线兜底', () => {
    expect(buildOverlaySeries([], kline)).toEqual({ x: [], topic: [], close: [] });
    const s = buildOverlaySeries(buckets, []);
    expect(s.close.every((v) => v === null)).toBe(true);
  });
});
