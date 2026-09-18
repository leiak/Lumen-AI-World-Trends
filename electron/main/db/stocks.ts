import type { Database } from 'sql.js';
import type { KlinePeriod, StockKPoint, StockQuote, StockWatchItem } from '../../../shared/stocks.js';
import type { StockWatchItem as WatchItemSource } from '../stocks/watchlist.js';

export function saveQuotes(db: Database, quotes: StockQuote[]): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO stock_quote
      (symbol, name, price, prev_close, change, change_pct,
       open, high, low, volume, amount, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const q of quotes) {
    stmt.run([
      q.symbol,
      q.name,
      q.price,
      q.prevClose,
      q.change,
      q.changePct,
      q.open ?? null,
      q.high ?? null,
      q.low ?? null,
      q.volume ?? null,
      q.amount ?? null,
      q.tradedAt || new Date().toISOString()
    ]);
  }
  stmt.free();
}

function toQuote(r: Record<string, unknown>): StockQuote {
  const nul = (v: unknown): number | undefined => (v == null ? undefined : Number(v));
  return {
    symbol: String(r.symbol),
    name: String(r.name),
    price: Number(r.price) || 0,
    prevClose: Number(r.prev_close) || 0,
    change: Number(r.change) || 0,
    changePct: Number(r.change_pct) || 0,
    open: nul(r.open),
    high: nul(r.high),
    low: nul(r.low),
    volume: nul(r.volume),
    amount: nul(r.amount),
    tradedAt: String(r.updated_at)
  };
}

export function loadQuotes(db: Database): StockQuote[] {
  const out: StockQuote[] = [];
  const stmt = db.prepare('SELECT * FROM stock_quote ORDER BY rowid');
  while (stmt.step()) {
    out.push(toQuote(stmt.getAsObject() as unknown as Record<string, unknown>));
  }
  stmt.free();
  return out;
}

export function latestCacheTime(db: Database): string {
  const stmt = db.prepare('SELECT MAX(updated_at) AS t FROM stock_quote');
  stmt.step();
  const t = String((stmt.getAsObject() as unknown as { t: string }).t ?? '');
  stmt.free();
  return t;
}

export function saveKline(
  db: Database,
  symbol: string,
  period: KlinePeriod,
  points: StockKPoint[]
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO stock_kline (symbol, period, date, open, close, high, low, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const p of points) {
    stmt.run([symbol, period, p.date, p.open, p.close, p.high, p.low, p.volume]);
  }
  stmt.free();
}

export function loadKline(
  db: Database,
  symbol: string,
  period: KlinePeriod,
  limit?: number
): StockKPoint[] {
  const sql =
    limit && limit > 0
      ? 'SELECT * FROM stock_kline WHERE symbol = ? AND period = ? ORDER BY date DESC LIMIT ?'
      : 'SELECT * FROM stock_kline WHERE symbol = ? AND period = ? ORDER BY date';
  const stmt = db.prepare(sql);
  stmt.bind(limit && limit > 0 ? [symbol, period, limit] : [symbol, period]);
  const rows: StockKPoint[] = [];
  while (stmt.step()) {
    const r = stmt.getAsObject() as unknown as Record<string, unknown>;
    rows.push({
      date: String(r.date),
      open: Number(r.open) || 0,
      close: Number(r.close) || 0,
      high: Number(r.high) || 0,
      low: Number(r.low) || 0,
      volume: Number(r.volume) || 0
    });
  }
  stmt.free();
  return rows.reverse();
}

export function seedDefaultWatch(db: Database, items: WatchItemSource[]): number {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO stock_watch (symbol, name, market, sort) VALUES (?, ?, ?, ?)'
  );
  let n = 0;
  items.forEach((w, i) => {
    stmt.run([w.symbol, w.name, w.market, i]);
    if (db.getRowsModified() > 0) n++;
  });
  stmt.free();
  return n;
}

export function loadWatch(db: Database): StockWatchItem[] {
  const out: StockWatchItem[] = [];
  const stmt = db.prepare('SELECT symbol, name, market FROM stock_watch ORDER BY sort, rowid');
  while (stmt.step()) {
    const r = stmt.getAsObject() as unknown as { symbol: string; name: string; market: string };
    out.push({ symbol: r.symbol, name: r.name, market: r.market });
  }
  stmt.free();
  return out;
}

export function addWatch(db: Database, item: StockWatchItem): void {
  const sortStmt = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM stock_watch');
  sortStmt.step();
  const sort = Number((sortStmt.getAsObject() as unknown as { s: number }).s) || 0;
  sortStmt.free();
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO stock_watch (symbol, name, market, sort) VALUES (?, ?, ?, ?)'
  );
  stmt.run([item.symbol, item.name, item.market, sort]);
  stmt.free();
}

export function removeWatch(db: Database, symbol: string): void {
  db.run('DELETE FROM stock_watch WHERE symbol = ?', [symbol]);
}
