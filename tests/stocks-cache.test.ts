import { describe, it, expect } from 'vitest';
import initSqlJs from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import {
  saveQuotes,
  loadQuotes,
  saveKline,
  loadKline,
  latestCacheTime,
  seedDefaultWatch,
  loadWatch,
  addWatch,
  removeWatch
} from '../electron/main/db/stocks';
import { DEFAULT_WATCHLIST } from '../electron/main/stocks/watchlist';
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

  it('kline round-trip（含 period）与限长', async () => {
    const db = await seed();
    const pts: StockKPoint[] = [
      { date: '2026-08-01', open: 1, close: 2, high: 3, low: 1, volume: 10 },
      { date: '2026-08-04', open: 2, close: 3, high: 4, low: 2, volume: 20 }
    ];
    saveKline(db, 'sh600519', 'day', pts);
    saveKline(db, 'sh600519', 'week', [{ date: '2026-08-07', open: 9, close: 10, high: 11, low: 9, volume: 30 }]);
    expect(loadKline(db, 'sh600519', 'day')).toHaveLength(2);
    expect(loadKline(db, 'sh600519', 'day', 1)[0]).toMatchObject({ date: '2026-08-04' });
    expect(loadKline(db, 'sh600519', 'week')[0]).toMatchObject({ date: '2026-08-07', close: 10 });
    expect(loadKline(db, 'sh600519', 'month')).toEqual([]);
    expect(loadKline(db, 'unknown', 'day')).toEqual([]);
    db.close();
  });

  it('latestCacheTime 取最大时间，空库为空串', async () => {
    const db = await seed();
    expect(latestCacheTime(db)).toBe('');
    saveQuotes(db, [q('sh600519', 1)]);
    expect(latestCacheTime(db)).toBe('20260915150000');
    db.close();
  });

  it('自选股：种子只补缺、增删持久化、按序返回', async () => {
    const db = await seed();
    const seeded = seedDefaultWatch(db, DEFAULT_WATCHLIST);
    expect(seeded).toBe(DEFAULT_WATCHLIST.length);
    expect(seedDefaultWatch(db, DEFAULT_WATCHLIST)).toBe(0);
    const items = loadWatch(db);
    expect(items.length).toBe(DEFAULT_WATCHLIST.length);
    expect(items[0]).toMatchObject({ symbol: 'sh000001' });

    addWatch(db, { symbol: 'sz000001', name: '平安银行', market: 'cn' });
    addWatch(db, { symbol: 'sz000001', name: '平安银行', market: 'cn' });
    expect(loadWatch(db)).toHaveLength(DEFAULT_WATCHLIST.length + 1);
    expect(loadWatch(db).at(-1)).toMatchObject({ symbol: 'sz000001', name: '平安银行' });

    removeWatch(db, 'sz000001');
    expect(loadWatch(db)).toHaveLength(DEFAULT_WATCHLIST.length);
    expect(loadWatch(db).some((w) => w.symbol === 'sz000001')).toBe(false);
    db.close();
  });
});
