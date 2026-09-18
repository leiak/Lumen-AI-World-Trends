import type { TrendPoint } from '../../shared/trend';
import type { StockKPoint } from '../../shared/stocks';

export interface OverlaySeries {
  x: string[];
  topic: number[];
  close: (number | null)[];
}

const DAY = 10;

export function buildOverlaySeries(
  buckets: TrendPoint[],
  kline: StockKPoint[],
  label: (iso: string) => string = (iso: string) => iso.slice(5, 16)
): OverlaySeries {
  const closeByDate = new Map<string, number>();
  for (const p of kline) closeByDate.set(p.date, p.close);
  return {
    x: buckets.map((b) => label(b.bucketStart)),
    topic: buckets.map((b) => b.count),
    close: buckets.map((b) => {
      const v = closeByDate.get(b.bucketStart.slice(0, DAY));
      return v === undefined ? null : v;
    })
  };
}
