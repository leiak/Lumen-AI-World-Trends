import type { Database } from 'sql.js';
import type { CountryHeat } from '../../../shared/trend.js';
import type { WorldTimeline, WorldTimelineEntry } from '../../../shared/world.js';

export interface WorldTimelineOptions {
  days?: number;
  now?: string;
}

function dayStrings(days: number, now: string): string[] {
  const end = new Date(now);
  const endDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(endDay);
    d.setUTCDate(endDay.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export function countryDayTimeline(
  db: Database,
  opts: WorldTimelineOptions = {}
): WorldTimeline {
  const days = Math.min(Math.max(Number(opts.days) || 7, 1), 60);
  const now = opts.now ?? new Date().toISOString();
  const dates = dayStrings(days, now);

  const stmt = db.prepare(`
    SELECT ae.entity_id AS id,
           COALESCE(e.name, ae.entity_id) AS name,
           COUNT(DISTINCT ae.article_id) AS n
    FROM article_entity ae
    LEFT JOIN entity e ON e.id = ae.entity_id
    JOIN source_article a ON a.raw_hash = ae.article_id
    WHERE substr(COALESCE(NULLIF(a.published_at, ''), a.crawled_at), 1, 10) = ?
    GROUP BY ae.entity_id
    ORDER BY n DESC
  `);

  const byDate: WorldTimelineEntry[] = [];
  for (const date of dates) {
    stmt.reset();
    stmt.bind([date]);
    const countries: CountryHeat[] = [];
    while (stmt.step()) {
      const r = stmt.getAsObject() as unknown as { name: string; n: number };
      countries.push({ name: r.name, count: r.n });
    }
    byDate.push({ date, countries });
  }
  stmt.free();
  return { dates, byDate };
}
