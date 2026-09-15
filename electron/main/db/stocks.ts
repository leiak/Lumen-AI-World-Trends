import type { Database } from 'sql.js';
import type { StockKPoint, StockQuote } from '../../../shared/stocks.js';

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

export function saveKline(db: Database, symbol: string, points: StockKPoint[]): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO stock_kline (symbol, date, open, close, high, low, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const p of points) {
    stmt.run([symbol, p.date, p.open, p.close, p.high, p.low, p.volume]);
  }
  stmt.free();
}

export function loadKline(db: Database, symbol: string, limit?: number): StockKPoint[] {
  const sql =
    limit && limit > 0
      ? 'SELECT * FROM stock_kline WHERE symbol = ? ORDER BY date DESC LIMIT ?'
      : 'SELECT * FROM stock_kline WHERE symbol = ? ORDER BY date';
  const stmt = db.prepare(sql);
  stmt.bind(limit && limit > 0 ? [symbol, limit] : [symbol]);
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
