import type { Database } from 'sql.js';
import type {
  TrendPoint,
  TopicTrend,
  CountryHeat,
  TrendsResult
} from '../../../shared/trend.js';

export interface TrendOptions {
  horizonMs?: number;
  bucketCount?: number;
  topN?: number;
  now?: string;
}

interface Row {
  name: string;
  type: string;
  lang: string;
  crawled_at: string;
}

const DAY = 86400000;

export function computeTrends(db: Database, opts: TrendOptions = {}): TrendsResult {
  const nowIso = opts.now ?? new Date().toISOString();
  const now = Date.parse(nowIso);
  const horizonMs = opts.horizonMs ?? 7 * DAY;
  const bucketCount = opts.bucketCount ?? 8;
  const topN = opts.topN ?? 20;

  const start = now - horizonMs;
  const width = Math.floor(horizonMs / bucketCount);
  const mid = Math.floor(bucketCount / 2);
  const startIso = new Date(start).toISOString();

  const stmt = db.prepare(
    `SELECT e.name AS name, e.type AS type, e.lang AS lang, ae.crawled_at AS crawled_at
     FROM article_entity ae JOIN entity e ON e.id = ae.entity_id
     WHERE ae.crawled_at >= ?`
  );
  stmt.bind([startIso]);
  const rows: Row[] = [];
  while (stmt.step()) {
    const r = stmt.getAsObject() as unknown as Row;
    rows.push(r);
  }
  stmt.free();

  const byEntity = new Map<string, number[]>();
  for (const r of rows) {
    const idx = Math.min(bucketCount - 1, Math.floor((Date.parse(r.crawled_at) - start) / width));
    const arr = byEntity.get(r.name) ?? new Array<number>(bucketCount).fill(0);
    arr[idx]++;
    byEntity.set(r.name, arr);
  }

  const trends: TopicTrend[] = [];
  const countries = new Map<string, CountryHeat>();

  for (const [name, buckets] of byEntity) {
    const count = buckets.reduce((s, c) => s + c, 0);
    const firstHalf = buckets.slice(0, mid).reduce((s, c) => s + c, 0);
    const secondHalf = buckets.slice(mid).reduce((s, c) => s + c, 0);
    const momentum = secondHalf - firstHalf;
    const points: TrendPoint[] = buckets.map((c, i) => ({
      bucketStart: new Date(start + i * width).toISOString(),
      count: c
    }));
    trends.push({ key: name.toLowerCase(), name, count, buckets: points, momentum, rising: momentum > 0 });
  }

  trends.sort((a, b) => b.count - a.count);
  const top = trends.slice(0, topN);

  // 世界热点：复用 rows 中 country 类型实体的频次
  const countryCount = new Map<string, number>();
  for (const r of rows) {
    if (r.type === 'country') countryCount.set(r.name, (countryCount.get(r.name) ?? 0) + 1);
  }
  for (const [name, count] of countryCount) countries.set(name, { name, count });
  const countryList = Array.from(countries.values()).sort((a, b) => b.count - a.count);

  return { trends: top, countries: countryList, generatedAt: nowIso };
}

export function computeHeatmap(db: Database, opts: TrendOptions = {}): CountryHeat[] {
  return computeTrends(db, opts).countries;
}

export interface EntitySeries {
  name: string;
  points: TrendPoint[];
}

export function computeEntitySeries(
  db: Database,
  names: string[],
  opts: TrendOptions = {}
): EntitySeries[] {
  const nowIso = opts.now ?? new Date().toISOString();
  const now = Date.parse(nowIso);
  const horizonMs = opts.horizonMs ?? 7 * DAY;
  const bucketCount = opts.bucketCount ?? 8;
  const start = now - horizonMs;
  const width = Math.floor(horizonMs / bucketCount);
  const startIso = new Date(start).toISOString();

  const out: EntitySeries[] = [];
  for (const name of names) {
    const stmt = db.prepare(
      `SELECT ae.crawled_at AS crawled_at
       FROM article_entity ae JOIN entity e ON e.id = ae.entity_id
       WHERE e.name = ? AND ae.crawled_at >= ?`
    );
    stmt.bind([name, startIso]);
    const buckets = new Array<number>(bucketCount).fill(0);
    while (stmt.step()) {
      const r = stmt.getAsObject() as unknown as { crawled_at: string };
      const idx = Math.min(bucketCount - 1, Math.floor((Date.parse(r.crawled_at) - start) / width));
      buckets[idx]++;
    }
    stmt.free();
    out.push({
      name,
      points: buckets.map((c, i) => ({
        bucketStart: new Date(start + i * width).toISOString(),
        count: c
      }))
    });
  }
  return out;
}

