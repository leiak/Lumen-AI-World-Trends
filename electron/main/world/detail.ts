import type { Database } from 'sql.js';
import type { CountryDetail, CountrySeriesResult } from '../../../shared/world.js';
import type { TimelineArticle } from '../../../shared/timeline.js';
import type { TopTopic } from '../../../shared/dashboard.js';
import type { TrendOptions } from '../trends/engine.js';
import { computeEntitySeries } from '../trends/engine.js';

export interface WorldDetailOptions {
  articleLimit?: number;
  topicLimit?: number;
  now?: string;
}

export function countryDetail(
  db: Database,
  name: string,
  opts: WorldDetailOptions = {}
): CountryDetail | null {
  const entityId = name.toLowerCase();

  const countStmt = db.prepare(
    'SELECT COUNT(DISTINCT article_id) AS n FROM article_entity WHERE entity_id = ?'
  );
  countStmt.bind([entityId]);
  countStmt.step();
  const count = (countStmt.getAsObject() as { n: number }).n;
  countStmt.free();
  if (count === 0) return null;

  const articleLimit = opts.articleLimit ?? 20;
  const artStmt = db.prepare(
    `SELECT a.raw_hash AS id, a.title AS title, a.url AS url, a.source AS source
     FROM article_entity ae JOIN source_article a ON a.raw_hash = ae.article_id
     WHERE ae.entity_id = ? ORDER BY a.crawled_at DESC LIMIT ?`
  );
  artStmt.bind([entityId, articleLimit]);
  const articles: TimelineArticle[] = [];
  while (artStmt.step()) {
    const r = artStmt.getAsObject() as unknown as { id: string; title: string; url: string; source: string };
    articles.push({ id: r.id, title: r.title, url: r.url, source: r.source });
  }
  artStmt.free();

  const topicLimit = opts.topicLimit ?? 6;
  const topicStmt = db.prepare(
    `SELECT e.name AS name, COUNT(DISTINCT ae2.article_id) AS cnt
     FROM article_entity ae1
     JOIN article_entity ae2 ON ae2.article_id = ae1.article_id AND ae2.entity_id != ae1.entity_id
     JOIN entity e ON e.id = ae2.entity_id
     WHERE ae1.entity_id = ?
     GROUP BY e.id ORDER BY cnt DESC LIMIT ?`
  );
  topicStmt.bind([entityId, topicLimit]);
  const topicRows: { name: string; cnt: number }[] = [];
  while (topicStmt.step()) {
    const r = topicStmt.getAsObject() as unknown as { name: string; cnt: number };
    topicRows.push(r);
  }
  topicStmt.free();

  const series = computeEntitySeries(
    db,
    topicRows.map((r) => r.name),
    { bucketCount: 4, now: opts.now }
  );
  const topics: TopTopic[] = topicRows.map((r) => {
    const pts = series.find((s) => s.name === r.name)?.points ?? [];
    const mid = Math.floor(pts.length / 2);
    const first = pts.slice(0, mid).reduce((s, p) => s + p.count, 0);
    const second = pts.slice(mid).reduce((s, p) => s + p.count, 0);
    return { name: r.name, count: r.cnt, rising: second > first };
  });

  return { name, count, topics, articles };
}

export function countrySeries(
  db: Database,
  names: string[],
  opts: TrendOptions = {}
): CountrySeriesResult {
  return { series: computeEntitySeries(db, names, opts) };
}