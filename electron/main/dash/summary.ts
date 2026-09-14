import type { Database } from 'sql.js';
import type { DashboardMetrics, DashboardSnapshot, TopTopic } from '../../../shared/dashboard.js';
import { computeTrends } from '../trends/engine.js';

export interface DashboardOptions {
  now?: string;
  intervalMinutes: number;
  lastAutoRunAt?: string | null;
  topN?: number;
}

function countRows(db: Database, sql: string): number {
  const stmt = db.prepare(sql);
  let n = 0;
  if (stmt.step()) n = (stmt.getAsObject() as { n: number }).n;
  stmt.free();
  return n;
}

function dayStartIso(nowIso: string): string {
  const d = new Date(Date.parse(nowIso));
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function readMetrics(db: Database, nowIso: string): DashboardMetrics {
  const startIso = dayStartIso(nowIso);
  return {
    articles: countRows(db, 'SELECT COUNT(*) AS n FROM source_article'),
    entities: countRows(db, 'SELECT COUNT(*) AS n FROM entity'),
    events: countRows(db, 'SELECT COUNT(*) AS n FROM event'),
    edges: countRows(db, 'SELECT COUNT(*) AS n FROM graph_edge'),
    addedToday: countRows(
      db,
      `SELECT COUNT(*) AS n FROM source_article WHERE crawled_at >= '${startIso}'`
    )
  };
}

function readLastCrawlAt(db: Database): string | null {
  const stmt = db.prepare('SELECT MAX(last_crawled_at) AS m FROM source_state');
  let m: string | null = null;
  if (stmt.step()) m = (stmt.getAsObject() as { m: string | null }).m;
  stmt.free();
  return m;
}

export function loadDashboardSnapshot(
  db: Database,
  opts: DashboardOptions
): DashboardSnapshot {
  const nowIso = opts.now ?? new Date().toISOString();
  const trends = computeTrends(db, { now: nowIso, topN: opts.topN ?? 5 });
  const topTopics: TopTopic[] = trends.trends.map((t) => ({
    name: t.name,
    count: t.count,
    rising: t.rising
  }));
  return {
    metrics: readMetrics(db, nowIso),
    topTopics,
    generatedAt: nowIso,
    lastAutoRunAt: opts.lastAutoRunAt ?? null,
    autoIntervalMinutes: opts.intervalMinutes,
    lastCrawlAt: readLastCrawlAt(db)
  };
}