import type { Database } from 'sql.js';
import type { NamedEntity } from '../../../shared/entities.js';
import type { SourceArticle } from '../../../shared/models.js';
import type { GraphEdge } from './relation.js';
import type { EventBundle } from './cluster.js';

export function saveEntities(db: Database, entities: NamedEntity[]): number {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO entity (id, name, name_en, type, lang) VALUES (?, ?, ?, ?, ?)'
  );
  let n = 0;
  for (const e of entities) {
    const id = (e.name ?? '').toLowerCase();
    stmt.run([id, e.name, e.nameEn ?? null, e.type, e.lang]);
    if (db.getRowsModified() > 0) n++;
  }
  stmt.free();
  return n;
}

export function saveEvents(db: Database, bundles: EventBundle[]): number {
  const ev = db.prepare(
    'INSERT OR IGNORE INTO event (id, title, summary, occurred_at, lang) VALUES (?, ?, NULL, ?, ?)'
  );
  const ae = db.prepare(
    'INSERT OR IGNORE INTO article_event (article_id, event_id) VALUES (?, ?)'
  );
  let n = 0;
  for (const b of bundles) {
    ev.run([b.id, b.title, b.occurredAt, 'en']);
    if (db.getRowsModified() > 0) n++;
    for (const aid of b.articleIds) ae.run([aid, b.id]);
  }
  ev.free();
  ae.free();
  return n;
}

export function saveArticleEvents(db: Database, bundle: EventBundle): void {
  const ae = db.prepare(
    'INSERT OR IGNORE INTO article_event (article_id, event_id) VALUES (?, ?)'
  );
  const ev = db.prepare(
    'INSERT OR IGNORE INTO event (id, title, summary, occurred_at, lang) VALUES (?, ?, NULL, ?, ?)'
  );
  ev.run([bundle.id, bundle.title, bundle.occurredAt, 'en']);
  for (const aid of bundle.articleIds) ae.run([aid, bundle.id]);
  ev.free();
  ae.free();
}

export function mergeEdges(db: Database, edges: GraphEdge[]): { upserted: number } {
  const stmt = db.prepare(
    `INSERT INTO graph_edge (id, source, target, event_id, relation_type, weight, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       weight = graph_edge.weight + excluded.weight,
       last_seen_at = excluded.last_seen_at`
  );
  let n = 0;
  for (const e of edges) {
    stmt.run([e.id, e.source, e.target, e.relationType, e.weight, e.firstSeenAt, e.lastSeenAt]);
    n++;
  }
  stmt.free();
  return { upserted: n };
}

export function loadArticles(db: Database, limit = 200): SourceArticle[] {
  const stmt = db.prepare(
    `SELECT raw_hash, source, title, content, url, lang, published_at, crawled_at
     FROM source_article ORDER BY crawled_at DESC LIMIT ?`
  );
  stmt.bind([limit]);
  const out: SourceArticle[] = [];
  while (stmt.step()) {
    const r = stmt.getAsObject() as Record<string, string | null>;
    out.push({
      id: r.raw_hash!,
      source: r.source!,
      title: r.title!,
      content: r.content ?? undefined,
      url: r.url!,
      lang: (r.lang as 'zh' | 'en') ?? 'en',
      publishedAt: r.published_at ?? null,
      crawledAt: r.crawled_at!,
      rawHash: r.raw_hash!
    });
  }
  stmt.free();
  return out;
}

