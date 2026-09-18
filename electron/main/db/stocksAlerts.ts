import type { Database } from 'sql.js';
import type { AlertKind, StockAlert, StockQuote } from '../../../shared/stocks.js';

const VALID_KINDS: AlertKind[] = ['price_above', 'price_below', 'pct_above', 'pct_below'];

function toAlert(r: Record<string, unknown>): StockAlert {
  return {
    id: Number(r.id),
    symbol: String(r.symbol),
    kind: String(r.kind) as AlertKind,
    threshold: Number(r.threshold),
    enabled: Number(r.enabled) === 1,
    lastFiredAt: r.last_fired_at == null ? null : String(r.last_fired_at),
    createdAt: String(r.created_at)
  };
}

export function listAlerts(db: Database, symbol?: string): StockAlert[] {
  const sql = symbol
    ? 'SELECT * FROM stock_alert WHERE symbol = ? ORDER BY id DESC'
    : 'SELECT * FROM stock_alert ORDER BY id DESC';
  const stmt = db.prepare(sql);
  if (symbol) stmt.bind([symbol]);
  const out: StockAlert[] = [];
  while (stmt.step()) out.push(toAlert(stmt.getAsObject() as unknown as Record<string, unknown>));
  stmt.free();
  return out;
}

export function addAlert(
  db: Database,
  input: { symbol: string; kind: AlertKind; threshold: number }
): StockAlert {
  const symbol = String(input.symbol || '').trim();
  if (!symbol) throw new Error('symbol required');
  if (!VALID_KINDS.includes(input.kind)) throw new Error(`invalid alert kind: ${input.kind}`);
  if (!Number.isFinite(input.threshold)) throw new Error('threshold must be a number');
  const stmt = db.prepare(
    'INSERT INTO stock_alert (symbol, kind, threshold, enabled, created_at) VALUES (?, ?, ?, 1, ?)'
  );
  stmt.run([symbol, input.kind, input.threshold, new Date().toISOString()]);
  stmt.free();
  const items = listAlerts(db, symbol);
  return items[0]!;
}

export function removeAlert(db: Database, id: number): void {
  if (id <= 0) throw new Error('invalid alert id');
  db.run('DELETE FROM stock_alert WHERE id = ?', [id]);
}

export function toggleAlert(db: Database, id: number, enabled: boolean): StockAlert {
  db.run('UPDATE stock_alert SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id]);
  const items = listAlerts(db);
  const found = items.find((a) => a.id === id);
  if (!found) throw new Error(`alert not found: ${id}`);
  return found;
}

/** 把命中的告警 last_fired_at 写回；返回本次新命中的告警 ids（用于通知去重）。 */
export function markFired(db: Database, ids: number[], now: Date = new Date()): void {
  if (ids.length === 0) return;
  const iso = now.toISOString();
  const stmt = db.prepare('UPDATE stock_alert SET last_fired_at = ? WHERE id = ?');
  for (const id of ids) stmt.run([iso, id]);
  stmt.free();
}

export interface ScanInput {
  quotes: StockQuote[];
  alerts: StockAlert[];
  /** 同日已触发的告警视为已发；仅 last_fired_at.slice(0, 10) === todaySlice 的告警会被跳过 */
  today?: string;
}

/** 纯函数：扫描 quote × alert 命中情况。返回「本次新命中」的告警（含其 quote 快照），同日已触发的会自动跳过。 */
export function scanAlerts(input: ScanInput): { alert: StockAlert; quote: StockQuote }[] {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const quoteBySym = new Map(input.quotes.map((q) => [q.symbol, q]));
  const fired: { alert: StockAlert; quote: StockQuote }[] = [];
  for (const a of input.alerts) {
    if (!a.enabled) continue;
    if (a.lastFiredAt && a.lastFiredAt.slice(0, 10) === today) continue;
    const q = quoteBySym.get(a.symbol);
    if (!q) continue;
    if (matches(a, q)) fired.push({ alert: a, quote: q });
  }
  return fired;
}

function matches(a: StockAlert, q: StockQuote): boolean {
  switch (a.kind) {
    case 'price_above':
      return q.price >= a.threshold;
    case 'price_below':
      return q.price <= a.threshold && q.price > 0;
    case 'pct_above':
      return q.changePct >= a.threshold;
    case 'pct_below':
      return q.changePct <= a.threshold;
    default:
      return false;
  }
}