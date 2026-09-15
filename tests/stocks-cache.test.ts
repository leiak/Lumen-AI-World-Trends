import { describe, it, expect } from 'vitest';
import initSqlJs from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import {
  saveQuotes,
  loadQuotes,
  saveKline,
  loadKline,
  latestCacheTime
} from '../electron/main/db/stocks';
import type { StockQuote, StockKPoint } from '../shared/stocks';

async function seed() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  migrate(db);
  return db;
}

const q = (symbol: string, price: number): StockQuote => ({
  symbol, name: symbol, price, prevClose: price - 1, change: 1, changePct: 0.5,
  tradedAt: '20260915150000'
});

describe('股票缓存', () => {
  it('quotes round-trip', async () => {
    const db = await seed();
    saveQuotes(db, [q('sh600519', 1750), q('usAAPL', 230.5)]);
    const rows = loadQuotes(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ symbol: 'sh600519', price: 1750, changePct: 0.5 });
    db.close();
  });

  it('kline round-trip 与限长', async () => {
    const db = await seed();
    const pts: StockKPoint[] = [
      { date: '2026-08-01', open: 1, close: 2, high: 3, low: 1, volume: 10 },
      { date: '2026-08-04', open: 2, close: 3, high: 4, low: 2, volume: 20 }
    ];
    saveKline(db, 'sh600519', pts);
    expect(loadKline(db, 'sh600519')).toHaveLength(2);
    expect(loadKline(db, 'sh600519', 1)[0]).toMatchObject({ date: '2026-08-04' });
    expect(loadKline(db, 'unknown')).toEqual([]);
    db.close();
  });

  it('latestCacheTime 取最大时间，空库为空串', async () => {
    const db = await seed();
    expect(latestCacheTime(db)).toBe('');
    saveQuotes(db, [q('sh600519', 1)]);
    expect(latestCacheTime(db)).toBe('20260915150000');
    db.close();
  });
});
