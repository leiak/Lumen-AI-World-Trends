import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import {
  addAlert,
  listAlerts,
  markFired,
  removeAlert,
  scanAlerts,
  toggleAlert
} from '../electron/main/db/stocksAlerts.js';
import type { StockAlert, StockQuote } from '../shared/stocks.js';

function q(symbol: string, price: number, changePct: number): StockQuote {
  return { symbol, name: symbol, price, prevClose: price, change: 0, changePct, tradedAt: '' };
}

function a(over: Partial<StockAlert> = {}): StockAlert {
  return {
    id: 0,
    symbol: 'sh600519',
    kind: 'price_above',
    threshold: 100,
    enabled: true,
    lastFiredAt: null,
    createdAt: '2026-09-18T00:00:00.000Z',
    ...over
  };
}

describe('stock alerts scan', () => {
  it('price_above 命中：现价 >= 阈值', () => {
    const alerts = [a({ kind: 'price_above', threshold: 100 })];
    const fired = scanAlerts({ quotes: [q('sh600519', 110, 0)], alerts });
    expect(fired).toHaveLength(1);
    expect(fired[0]!.alert.symbol).toBe('sh600519');
  });

  it('price_below 命中：现价 <= 阈值（且 > 0）', () => {
    const alerts = [a({ kind: 'price_below', threshold: 100 })];
    expect(scanAlerts({ quotes: [q('sh600519', 90, 0)], alerts })).toHaveLength(1);
    // 0 价不算
    expect(scanAlerts({ quotes: [q('sh600519', 0, 0)], alerts })).toHaveLength(0);
  });

  it('pct_above / pct_below 命中', () => {
    const a1 = a({ kind: 'pct_above', threshold: 5 });
    const a2 = a({ kind: 'pct_below', threshold: -3 });
    expect(scanAlerts({ quotes: [q('sh600519', 110, 5.5)], alerts: [a1] })).toHaveLength(1);
    expect(scanAlerts({ quotes: [q('sh600519', 90, -3.5)], alerts: [a2] })).toHaveLength(1);
    expect(scanAlerts({ quotes: [q('sh600519', 100, 0)], alerts: [a1, a2] })).toHaveLength(0);
  });

  it('未启用的告警被跳过', () => {
    const alerts = [a({ enabled: false, threshold: 1 })];
    expect(scanAlerts({ quotes: [q('sh600519', 9999, 0)], alerts })).toHaveLength(0);
  });

  it('同日已触发的告警被跳过', () => {
    const today = '2026-09-18';
    const alerts = [
      a({ lastFiredAt: `${today}T01:23:45.000Z`, threshold: 1 })
    ];
    expect(scanAlerts({ quotes: [q('sh600519', 9999, 0)], alerts, today })).toHaveLength(0);
    // 隔天则重新触发
    expect(
      scanAlerts({ quotes: [q('sh600519', 9999, 0)], alerts, today: '2026-09-19' })
    ).toHaveLength(1);
  });

  it('无对应行情则跳过', () => {
    const alerts = [a({ symbol: 'sh000001' })];
    expect(scanAlerts({ quotes: [q('sh600519', 9999, 0)], alerts })).toHaveLength(0);
  });

  it('未识别的 kind 不命中', () => {
    const alerts = [{ ...a(), kind: 'unknown_kind' as StockAlert['kind'] }];
    expect(scanAlerts({ quotes: [q('sh600519', 9999, 0)], alerts })).toHaveLength(0);
  });
});

describe('stock alerts DB', () => {
  let db: Database;
  beforeAll(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    migrate(db);
  });

  it('addAlert + listAlerts', () => {
    const created = addAlert(db, { symbol: 'sh600519', kind: 'price_above', threshold: 2000 });
    expect(created.id).toBeGreaterThan(0);
    expect(listAlerts(db, 'sh600519').map((x) => x.id)).toContain(created.id);
  });

  it('addAlert 校验 symbol / kind / threshold', () => {
    expect(() => addAlert(db, { symbol: '', kind: 'price_above', threshold: 1 })).toThrow();
    expect(() =>
      addAlert(db, { symbol: 'x', kind: 'bogus' as StockAlert['kind'], threshold: 1 })
    ).toThrow();
    expect(() => addAlert(db, { symbol: 'x', kind: 'price_above', threshold: NaN })).toThrow();
  });

  it('removeAlert + toggleAlert', () => {
    const created = addAlert(db, { symbol: 'sh600519', kind: 'pct_below', threshold: -5 });
    removeAlert(db, created.id);
    expect(listAlerts(db).find((x) => x.id === created.id)).toBeUndefined();

    const a2 = addAlert(db, { symbol: 'sh600519', kind: 'pct_above', threshold: 3 });
    const toggled = toggleAlert(db, a2.id, false);
    expect(toggled.enabled).toBe(false);
    toggleAlert(db, a2.id, true);
    expect(listAlerts(db).find((x) => x.id === a2.id)?.enabled).toBe(true);
  });

  it('markFired 写回 last_fired_at', () => {
    const created = addAlert(db, { symbol: 'usAAPL', kind: 'price_above', threshold: 100 });
    const now = new Date('2026-09-18T10:00:00.000Z');
    markFired(db, [created.id], now);
    const refreshed = listAlerts(db, 'usAAPL').find((x) => x.id === created.id)!;
    expect(refreshed.lastFiredAt).toBe('2026-09-18T10:00:00.000Z');
  });
});