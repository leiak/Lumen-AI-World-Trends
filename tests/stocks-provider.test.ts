import { describe, it, expect } from 'vitest';
import {
  parseQuoteLine,
  parseKlineResponse,
  MockStockProvider
} from '../electron/main/stocks/provider';

function quoteLine(fields: Record<number, string>, symbol = 'sh600519'): string {
  const f = Array(49).fill('');
  f[0] = '1';
  for (const [i, v] of Object.entries(fields)) f[Number(i)] = v;
  return `v_${symbol}="${f.join('~')}"`;
}

describe('Tencent 行情解析', () => {
  it('解析报价行为 StockQuote', () => {
    const q = parseQuoteLine(
      quoteLine({
        1: '贵州茅台', 2: '600519', 3: '1750.000', 4: '1740.000',
        5: '1752.000', 6: '30120', 30: '20260915150000',
        31: '10.000', 32: '0.57', 33: '1755.000', 34: '1732.000', 37: '527100'
      })
    );
    expect(q).not.toBeNull();
    expect(q!.symbol).toBe('sh600519');
    expect(q!.name).toBe('贵州茅台');
    expect(q!.price).toBeCloseTo(1750, 3);
    expect(q!.prevClose).toBeCloseTo(1740, 3);
    expect(q!.change).toBeCloseTo(10, 3);
    expect(q!.changePct).toBeCloseTo(0.57, 2);
    expect(q!.high).toBeCloseTo(1755, 3);
    expect(q!.low).toBeCloseTo(1732, 3);
    expect(q!.amount).toBeCloseTo(527100, 1);
    expect(q!.tradedAt).toBe('20260915150000');
  });

  it('缺失涨跌字段时用 现价-昨收 兜底', () => {
    const q = parseQuoteLine(quoteLine({ 1: '上证指数', 2: '000001', 3: '3100.5', 4: '3080.0' }, 'sh000001'));
    expect(q!.change).toBeCloseTo(20.5, 1);
    expect(q!.changePct).toBeCloseTo(0.6656, 3);
  });

  it('解析 K 线 JSON（qfqday 优先，缺省用 day）', () => {
    const payload = {
      data: {
        sh600519: {
          qfqday: [
            ['2026-08-01', '1700.0', '1750.0', '1760.0', '1690.0', '51000'],
            ['2026-08-04', '1750.0', '1740.0', '1760.5', '1720.0', '42000']
          ]
        }
      }
    };
    const pts = parseKlineResponse(payload as never, 'sh600519');
    expect(pts).toHaveLength(2);
    expect(pts[0]).toEqual({
      date: '2026-08-01', open: 1700, close: 1750, high: 1760, low: 1690, volume: 51000
    });

    const dayOnly = { data: { hk00700: { day: [['2026-08-01', '300', '310', '315', '295', '999']] } } };
    expect(parseKlineResponse(dayOnly as never, 'hk00700')).toHaveLength(1);
  });
});

describe('Mock 行情源', () => {
  it('返回确定性报价与 K 线', async () => {
    const mock = new MockStockProvider();
    const a = await mock.fetchQuotes(['sh600519', 'usAAPL']);
    const b = await mock.fetchQuotes(['sh600519', 'usAAPL']);
    expect(a).toHaveLength(2);
    expect(a[0]!.symbol).toBe('sh600519');
    expect(a[0]!.price).toBeGreaterThan(0);
    expect(a[1]!.changePct).toBeCloseTo(b[1]!.changePct, 5);

    const k = await mock.fetchKline('sh600519', 30);
    expect(k).toHaveLength(30);
    expect(k[0]!.date < k[29]!.date).toBe(true);
  });
});
