import type { Database } from 'sql.js';
import type { SourceArticle } from '../../../shared/models.js';
import type { Collector } from '../collectors/types.js';
import type { CrawlError } from '../crawl/manager.js';
import { runCollectors, dedupById } from '../crawl/manager.js';

export function getExistingHashes(db: Database, source: string): Set<string> {
  const stmt = db.prepare(`SELECT raw_hash FROM source_article WHERE source=?`);
  stmt.bind([source]);
  const set = new Set<string>();
  while (stmt.step()) {
    const row = stmt.getAsObject() as { raw_hash?: string };
    if (row.raw_hash) set.add(row.raw_hash);
  }
  stmt.free();
  return set;
}

export function insertArticles(db: Database, articles: SourceArticle[]): number {
  let inserted = 0;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO source_article
       (raw_hash, source, title, content, url, lang, published_at, crawled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const a of articles) {
    stmt.run([
      a.rawHash,
      a.source,
      a.title,
      a.content ?? null,
      a.url,
      a.lang,
      a.publishedAt,
      a.crawledAt
    ]);
    if (db.getRowsModified() > 0) inserted++;
  }
  stmt.free();
  return inserted;
}

export function upsertSourceState(db: Database, sourceId: string, lastCrawledAt: string): void {
  const stmt = db.prepare(
    `INSERT INTO source_state (source, last_cursor, last_crawled_at)
     VALUES (?, NULL, ?)
     ON CONFLICT(source) DO UPDATE SET last_crawled_at = excluded.last_crawled_at`
  );
  stmt.run([sourceId, lastCrawledAt]);
  stmt.free();
}

export interface CrawlSummary {
  fetched: number;
  addedNew: number;
  dupes: number;
  errors: CrawlError[];
}

export async function runCrawl(
  db: Database,
  collectors: Collector[]
): Promise<CrawlSummary> {
  const { articles, errors } = await runCollectors(collectors);
  const fetched = articles.length;

  const existing = new Set<string>();
  for (const c of collectors) {
    for (const h of getExistingHashes(db, c.config.id)) existing.add(h);
  }

  const uniqueNew = dedupById(articles).filter((a) => !existing.has(a.id));
  const addedNew = insertArticles(db, uniqueNew);
  const dupes = fetched - uniqueNew.length; // 本次内重复 + 已在库的
  const now = new Date().toISOString();
  for (const c of collectors) upsertSourceState(db, c.config.id, now);

  return { fetched, addedNew, dupes, errors };
}


