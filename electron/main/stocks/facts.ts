import type { Database } from 'sql.js';
import type {
  StockFact,
  StockFactInput,
  StockFactLayer,
  StockFactsImportResponse,
  StockFactsView,
  StockLayerStatus,
  StockFactLayerStatusValue,
  StockMarketSyncResponse,
  StockSampleResponse
} from '../../../shared/stock-agent.js';
import { STOCK_FACT_LAYERS, STOCK_DEFAULT_BENCHMARK } from '../../../shared/stock-agent.js';
import type { StockKPoint } from '../../../shared/stocks.js';
import type { StockProvider } from './provider.js';
import { dateOnly, isTradingDay } from './calendar.js';

const COLUMNS = [
  'symbol',
  'layer',
  'metric',
  'value',
  'value_text',
  'unit',
  'period',
  'published_at',
  'effective_at',
  'source',
  'raw_text'
] as const;

type Column = (typeof COLUMNS)[number];

function rows(db: Database, sql: string, params: Array<string | number> = []): Array<Record<string, unknown>> {
  const res = db.exec(sql, params);
  if (res.length === 0) return [];
  const { columns, values } = res[0];
  return values.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
}

function normalizeIso(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  const ms = Date.parse(raw.length === 10 ? `${raw}T00:00:00.000Z` : raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function toNumber(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function slug(v: string): string {
  return v.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 60);
}

export function factIdOf(symbol: string, layer: string, metric: string, period: string, effectiveAt: string): string {
  return `fact_${slug(symbol)}_${slug(layer)}_${slug(metric)}_${slug(period || 'na')}_${dateOnly(effectiveAt).replace(/-/g, '')}`;
}

function normInput(input: StockFactInput): StockFact | null {
  const symbol = input.symbol?.trim().toLowerCase();
  if (!symbol) return null;
  if (!STOCK_FACT_LAYERS.includes(input.layer)) return null;
  if (!input.metric?.trim()) return null;
  const publishedAt = normalizeIso(input.publishedAt);
  if (!publishedAt) return null;
  const effectiveAt = normalizeIso(input.effectiveAt ?? input.publishedAt);
  if (!effectiveAt) return null;
  const value = input.value === undefined || input.value === null ? null : Number(input.value);
  if (value !== null && !Number.isFinite(value)) return null;
  const valueText = input.valueText?.trim() ? input.valueText.trim() : null;
  if (value === null && valueText === null) return null;
  const period = input.period?.trim() || null;
  const factId = factIdOf(symbol, input.layer, input.metric, period ?? '', effectiveAt);
  return {
    factId,
    symbol,
    layer: input.layer,
    metric: input.metric.trim(),
    value,
    valueText,
    unit: input.unit?.trim() || null,
    period,
    publishedAt,
    effectiveAt,
    source: input.source?.trim() || 'manual',
    rawText: input.rawText?.trim() || undefined
  };
}

function upsert(db: Database, fact: StockFact): void {
  db.exec(
    `INSERT OR REPLACE INTO stock_fact
      (fact_id, symbol, layer, metric, value, value_text, unit, period, published_at, effective_at, source, raw_text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fact.factId,
      fact.symbol,
      fact.layer,
      fact.metric,
      fact.value,
      fact.valueText,
      fact.unit,
      fact.period,
      fact.publishedAt,
      fact.effectiveAt,
      fact.source,
      fact.rawText ?? null,
      new Date().toISOString()
    ]
  );
}

function toFact(r: Record<string, unknown>): StockFact {
  const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
  const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
  return {
    factId: String(r.fact_id),
    symbol: String(r.symbol),
    layer: String(r.layer) as StockFactLayer,
    metric: String(r.metric),
    value: num(r.value),
    valueText: str(r.value_text),
    unit: str(r.unit),
    period: str(r.period),
    publishedAt: String(r.published_at),
    effectiveAt: String(r.effective_at),
    source: String(r.source),
    rawText: str(r.raw_text) ?? undefined
  };
}

/**
 * 只返回 asOf 时点已经可见的事实（严格截断，禁止未来数据）。
 * 两个时点都必须满足：published_at <= asOf（尚未发布的不能看到），
 * effective_at <= asOf（生效日期在未来的同样不能看到）。
 */
export function listStockFacts(db: Database, symbol: string, asOf: string): StockFact[] {
  const cutoff = normalizeIso(asOf) ?? asOf;
  return rows(
    db,
    `SELECT * FROM stock_fact
     WHERE symbol = ? AND published_at <= ? AND effective_at <= ?
     ORDER BY effective_at ASC, fact_id ASC`,
    [symbol.trim().toLowerCase(), cutoff, cutoff]
  ).map(toFact);
}

/** 覆盖度：market 至少要有 2 个收盘价才能算收益；其余层至少 1 条。 */
export function computeLayerStatus(facts: StockFact[]): StockLayerStatus[] {
  const minCount: Record<StockFactLayer, number> = {
    market: 2,
    fundamentals: 1,
    disclosures: 1,
    news: 1
  };
  return STOCK_FACT_LAYERS.map((layer) => {
    const list = facts.filter((f) => f.layer === layer);
    const status: StockFactLayerStatusValue =
      list.length === 0 ? 'missing' : list.length < minCount[layer] ? 'partial' : 'ok';
    const gaps =
      status === 'missing'
        ? [`${layer} 维度缺失：未导入任何事实`]
        : status === 'partial'
          ? [`${layer} 维度不完整：仅 ${list.length} 条事实，至少需要 ${minCount[layer]} 条`]
          : [];
    return { layer, status, factCount: list.length, gaps };
  });
}

export function stockFactsView(db: Database, symbol: string, asOf: string): StockFactsView {
  const facts = listStockFacts(db, symbol, asOf);
  return { symbol, asOf, facts, layers: computeLayerStatus(facts) };
}

export function addStockFact(db: Database, persist: () => void, input: StockFactInput): StockFact | null {
  const fact = normInput(input);
  if (!fact) return null;
  upsert(db, fact);
  persist();
  return fact;
}

/** 极简 CSV 解析：支持双引号包裹与 "" 转义；忽略空行与 # 注释。 */
function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      lines.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) lines.push(cur);
  const meaningful = lines.filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (meaningful.length === 0) return { header: [], rows: [] };
  const split = (line: string): string[] => {
    const out: string[] = [];
    let cell = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"') {
          if (line[i + 1] === '"') {
            cell += '"';
            i++;
          } else q = false;
        } else cell += c;
        continue;
      }
      if (c === '"') q = true;
      else if (c === ',') {
        out.push(cell.trim());
        cell = '';
      } else cell += c;
    }
    out.push(cell.trim());
    return out;
  };
  const header = split(meaningful[0]).map((h) => h.trim().toLowerCase());
  return { header, rows: meaningful.slice(1).map(split) };
}

export function importFactsCsv(
  db: Database,
  persist: () => void,
  req: { csv: string; symbol?: string; replace?: boolean },
  asOf: string
): StockFactsImportResponse {
  const { header, rows: rawRows } = parseCsv(req.csv ?? '');
  const errors: Array<{ line: number; message: string }> = [];
  if (header.length === 0) {
    return { imported: 0, skipped: 0, errors: [{ line: 1, message: 'CSV 为空' }], view: stockFactsView(db, req.symbol ?? '', asOf) };
  }
  for (const col of COLUMNS) {
    if (!header.includes(col) && !(col === 'value_text' && header.includes('value_text'))) {
      // symbol/layer/metric/published_at/source 为必填；其余可缺省。
      if (['symbol', 'layer', 'metric', 'published_at', 'source'].includes(col)) {
        errors.push({ line: 1, message: `缺少必需列: ${col}` });
      }
    }
  }
  if (errors.length > 0) {
    return { imported: 0, skipped: 0, errors, view: stockFactsView(db, req.symbol ?? '', asOf) };
  }
  const idx = new Map<Column, number>();
  header.forEach((h, i) => {
    if ((COLUMNS as readonly string[]).includes(h)) idx.set(h as Column, i);
  });
  const symbolsToClear = new Map<string, Set<StockFactLayer>>();
  let imported = 0;
  let skipped = 0;
  rawRows.forEach((r, i) => {
    const line = i + 2;
    const get = (c: Column): string => {
      const at = idx.get(c);
      return at === undefined ? '' : (r[at] ?? '');
    };
    const input: StockFactInput = {
      symbol: get('symbol') || req.symbol || '',
      layer: get('layer') as StockFactLayer,
      metric: get('metric'),
      value: toNumber(get('value')),
      valueText: get('value_text') || null,
      unit: get('unit') || undefined,
      period: get('period') || undefined,
      publishedAt: get('published_at'),
      effectiveAt: get('effective_at') || undefined,
      source: get('source') || 'csv',
      rawText: get('raw_text') || undefined
    };
    const fact = normInput(input);
    if (!fact) {
      skipped += 1;
      errors.push({ line, message: '字段非法或 value/value_text 同时为空' });
      return;
    }
    if (req.replace) {
      const set = symbolsToClear.get(fact.symbol) ?? new Set<StockFactLayer>();
      set.add(fact.layer);
      symbolsToClear.set(fact.symbol, set);
    }
    upsert(db, fact);
    imported += 1;
  });
  if (req.replace) {
    for (const [symbol, layers] of symbolsToClear) {
      for (const layer of layers) {
        // 只清理不在本 CSV 中的旧事实，保证幂等重导不会误删同批数据。
        const kept = new Set(
          rawRows
            .map((r) => (idx.get('metric') === undefined ? '' : r[idx.get('metric')!] ?? ''))
            .filter(Boolean)
        );
        for (const old of rows(
          db,
          `SELECT fact_id, metric FROM stock_fact WHERE symbol = ? AND layer = ?`,
          [symbol, layer]
        )) {
          if (!kept.has(String(old.metric))) {
            db.exec('DELETE FROM stock_fact WHERE fact_id = ?', [String(old.fact_id)]);
          }
        }
      }
    }
  }
  persist();
  return {
    imported,
    skipped,
    errors,
    view: stockFactsView(db, req.symbol ?? (rawRows[0]?.[idx.get('symbol') ?? -1] ?? ''), asOf)
  };
}

/** 把库内 K 线快照转成行情事实；库内没有时再抓取一次并落库（抓取即快照）。 */
export async function syncMarketFacts(
  db: Database,
  persist: () => void,
  provider: StockProvider,
  symbol: string,
  asOf: string
): Promise<StockMarketSyncResponse> {
  const sym = symbol.trim().toLowerCase();
  const cutoff = dateOnly(asOf);
  let points = rows(
    db,
    `SELECT date, open, close, high, low, volume FROM stock_kline
     WHERE symbol = ? AND period = 'day' AND date <= ? ORDER BY date ASC`,
    [sym, cutoff]
  ).map((r) => ({
    date: String(r.date),
    open: Number(r.open) || 0,
    close: Number(r.close) || 0,
    high: Number(r.high) || 0,
    low: Number(r.low) || 0,
    volume: Number(r.volume) || 0
  })) as StockKPoint[];
  let from: StockMarketSyncResponse['from'] = 'db_snapshot';
  if (points.length === 0) {
    try {
      const fetched = await provider.fetchKline(sym, 120, 'day');
      points = fetched.filter((p) => dateOnly(p.date) <= cutoff);
      if (points.length > 0) {
        const stmt = db.prepare(
          `INSERT OR REPLACE INTO stock_kline (symbol, period, date, open, close, high, low, volume)
           VALUES (?, 'day', ?, ?, ?, ?, ?, ?)`
        );
        for (const p of points) stmt.run([sym, p.date, p.open, p.close, p.high, p.low, p.volume]);
        stmt.free();
        persist();
        from = 'provider';
      }
    } catch {
      from = 'none';
    }
  }
  if (points.length === 0) {
    return { symbol: sym, wrote: 0, from: 'none', view: stockFactsView(db, sym, asOf) };
  }
  let wrote = 0;
  for (const p of points) {
    const fact = normInput({
      symbol: sym,
      layer: 'market',
      metric: 'close',
      value: p.close,
      unit: 'CNY',
      period: dateOnly(p.date),
      publishedAt: `${dateOnly(p.date)}T15:00:00.000Z`,
      effectiveAt: `${dateOnly(p.date)}T15:00:00.000Z`,
      source: 'market_snapshot'
    });
    if (!fact) continue;
    upsert(db, fact);
    wrote += 1;
  }
  persist();
  return { symbol: sym, wrote, from, view: stockFactsView(db, sym, asOf) };
}

/** 内置样例：A 股 1 只 + 基准，覆盖行情/财报/公告/舆情四层，含 T+5 之后的收盘价。 */
export const SAMPLE_SYMBOL = 'sh600519';

function quoteCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const SAMPLE_FUNDAMENTALS = [
  { metric: 'net_profit_yoy', value: 18.4, unit: '%', period: '2026Q3', publishedAt: '2026-10-28T10:00:00.000Z', raw: '三季报归母净利润同比增长 18.4%' },
  { metric: 'revenue_yoy', value: 12.6, unit: '%', period: '2026Q3', publishedAt: '2026-10-28T10:00:00.000Z', raw: '营业收入同比增长 12.6%' },
  { metric: 'gross_margin', value: 91.2, unit: '%', period: '2026Q3', publishedAt: '2026-10-28T10:00:00.000Z', raw: '毛利率 91.2%，同比提升' },
  { metric: 'eps', value: 4.36, unit: 'CNY', period: '2026Q3', publishedAt: '2026-10-28T10:00:00.000Z', raw: '每股收益 4.36 元' }
];

const SAMPLE_DISCLOSURES = [
  { metric: 'announcement', text: '关于 2026 年第三季度报告的公告', publishedAt: '2026-10-28T09:00:00.000Z', source: 'cninfo', raw: '三季报按期披露' },
  { metric: 'announcement', text: '关于实施现金分红的公告', publishedAt: '2026-10-20T09:00:00.000Z', source: 'cninfo', raw: '拟每股派现 1.20 元' },
  { metric: 'announcement', text: '关于回购股份进展的公告', publishedAt: '2026-10-12T09:00:00.000Z', source: 'cninfo', raw: '回购进度 60%' }
];

const SAMPLE_NEWS = [
  { metric: 'news_count', value: 12, unit: '篇', period: '2026-10-29', publishedAt: '2026-10-29T12:00:00.000Z', raw: '近一周 12 篇相关报道' },
  { metric: 'sentiment_score', value: 0.62, unit: 'score', period: '2026-10-29', publishedAt: '2026-10-29T12:00:00.000Z', raw: '本地舆情偏正面（0.62）' }
];

function priceSeries(symbol: string, start: string, end: string): Array<{ date: string; close: number }> {
  const out: Array<{ date: string; close: number }> = [];
  const base = symbol === SAMPLE_SYMBOL ? 1500 : 4200;
  const seed = symbol === SAMPLE_SYMBOL ? 0 : 1;
  let ms = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  let i = 0;
  while (ms <= endMs) {
    const d = new Date(ms);
    const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    if (isTradingDay(iso)) {
      // 确定性、无随机：两条平滑正弦叠加 + 轻微漂移。
      const drift = seed === 0 ? i * 0.9 : i * 0.25;
      const wave = seed === 0 ? Math.sin(i / 9) * 42 : Math.sin(i / 11) * 70;
      out.push({ date: iso, close: Number((base + drift + wave).toFixed(2)) });
      i += 1;
    }
    ms += 86_400_000;
  }
  return out;
}

export function buildSampleCsv(symbol = SAMPLE_SYMBOL, from = '2026-08-03', to = '2026-12-15'): StockSampleResponse {
  const sym = symbol.trim().toLowerCase();
  const lines: string[] = [COLUMNS.join(',')];
  for (const p of priceSeries(sym, from, to)) {
    lines.push(
      [
        quoteCell(sym),
        'market',
        'close',
        String(p.close),
        '',
        'CNY',
        p.date,
        `${p.date}T15:00:00.000Z`,
        `${p.date}T15:00:00.000Z`,
        'market_snapshot',
        ''
      ].join(',')
    );
  }
  if (sym === SAMPLE_SYMBOL) {
    for (const f of SAMPLE_FUNDAMENTALS) {
      lines.push(
        [sym, 'fundamentals', f.metric, String(f.value), quoteCell(f.raw), f.unit, f.period, f.publishedAt, f.publishedAt, 'sample_fundamentals', quoteCell(f.raw)].join(',')
      );
    }
    for (const d of SAMPLE_DISCLOSURES) {
      lines.push(
        [sym, 'disclosures', d.metric, '', quoteCell(d.text), '', '2026Q3', d.publishedAt, d.publishedAt, d.source, quoteCell(d.raw)].join(',')
      );
    }
    for (const n of SAMPLE_NEWS) {
      lines.push(
        [sym, 'news', n.metric, String(n.value), quoteCell(n.raw), n.unit, n.period, n.publishedAt, n.publishedAt, 'sample_news', quoteCell(n.raw)].join(',')
      );
    }
  }
  // 非内置代码只写样例行情：财报/公告/舆情不写任何行，覆盖度必须如实显示 missing，
  // 不能用“空值行”伪装成有数据。
  const benchmark = priceSeries(STOCK_DEFAULT_BENCHMARK, from, to);
  for (const p of benchmark) {
    lines.push(
      [STOCK_DEFAULT_BENCHMARK, 'market', 'close', String(p.close), '', 'CNY', p.date, `${p.date}T15:00:00.000Z`, `${p.date}T15:00:00.000Z`, 'market_snapshot', ''].join(',')
    );
  }
  return { symbol: sym, csv: `${lines.join('\n')}\n` };
}
