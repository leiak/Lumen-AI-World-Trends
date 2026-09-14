import type { Database } from 'sql.js';
import type { NamedEntity } from '../../../shared/entities.js';
import type { SourceArticle } from '../../../shared/models.js';
import type { TimelineArticle, TimelineEvent } from '../../../shared/timeline.js';
import type { GraphNode, GraphLink, GraphView, GraphQueryOptions } from '../../../shared/graph-view.js';
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

export function saveArticleEntities(
  db: Database,
  articleId: string,
  entities: NamedEntity[],
  crawledAt: string
): number {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO article_entity (article_id, entity_id, crawled_at) VALUES (?, ?, ?)'
  );
  let n = 0;
  for (const e of entities) {
    stmt.run([articleId, e.name.toLowerCase(), crawledAt]);
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
  const ev = db.prepare(
    'INSERT OR IGNORE INTO event (id, title, summary, occurred_at, lang) VALUES (?, ?, NULL, ?, ?)'
  );
  const ae = db.prepare(
    'INSERT OR IGNORE INTO article_event (article_id, event_id) VALUES (?, ?)'
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

function rowToArticle(r: Record<string, string | null>): SourceArticle {
  return {
    id: r.raw_hash!,
    source: r.source!,
    title: r.title!,
    content: r.content ?? undefined,
    url: r.url!,
    lang: (r.lang as 'zh' | 'en') ?? 'en',
    publishedAt: r.published_at ?? null,
    crawledAt: r.crawled_at!,
    rawHash: r.raw_hash!
  };
}

export function loadArticles(db: Database, limit = 200): SourceArticle[] {
  const stmt = db.prepare(
    `SELECT raw_hash, source, title, content, url, lang, published_at, crawled_at
     FROM source_article ORDER BY crawled_at DESC LIMIT ?`
  );
  stmt.bind([limit]);
  const out: SourceArticle[] = [];
  while (stmt.step()) out.push(rowToArticle(stmt.getAsObject() as Record<string, string | null>));
  stmt.free();
  return out;
}

export function searchArticles(db: Database, query: string, limit = 50): SourceArticle[] {
  const like = `%${query}%`;
  const stmt = db.prepare(
    `SELECT raw_hash, source, title, content, url, lang, published_at, crawled_at
     FROM source_article WHERE title LIKE ? OR content LIKE ?
     ORDER BY crawled_at DESC LIMIT ?`
  );
  stmt.bind([like, like, limit]);
  const out: SourceArticle[] = [];
  while (stmt.step()) out.push(rowToArticle(stmt.getAsObject() as Record<string, string | null>));
  stmt.free();
  return out;
}

export function listEvents(db: Database, limit = 100): TimelineEvent[] {
  const stmt = db.prepare(
    'SELECT id, title, occurred_at FROM event ORDER BY occurred_at DESC LIMIT ?'
  );
  stmt.bind([limit]);
  const events: { id: string; title: string; occurred_at: string }[] = [];
  while (stmt.step()) events.push(stmt.getAsObject() as unknown as { id: string; title: string; occurred_at: string });
  stmt.free();

  const artStmt = db.prepare(
    `SELECT a.raw_hash AS id, a.title AS title, a.url AS url, a.source AS source
     FROM article_event ae JOIN source_article a ON a.raw_hash = ae.article_id
     WHERE ae.event_id = ? ORDER BY a.crawled_at DESC LIMIT 50`
  );

  const out: TimelineEvent[] = [];
  for (const e of events) {
    artStmt.bind([e.id]);
    const articles: TimelineArticle[] = [];
    while (artStmt.step()) {
      const r = artStmt.getAsObject() as unknown as { id: string; title: string; url: string; source: string };
      articles.push({ id: r.id, title: r.title, url: r.url, source: r.source });
    }
    artStmt.reset();
    out.push({
      id: e.id,
      title: e.title,
      occurredAt: e.occurred_at,
      articleCount: articles.length,
      articles
    });
  }
  artStmt.free();
  return out;
}

export function queryGraph(
  db: Database,
  opts: GraphQueryOptions | number = {}
): GraphView {
  const options: GraphQueryOptions = typeof opts === 'number' ? { topN: opts } : opts;
  const topN = options.topN ?? 20;
  const includeEvents = options.includeEvents ?? false;
  const eventLimit = options.eventLimit ?? 10;

  // 节点：实体按出现频次
  const nodeStmt = db.prepare(
    `SELECT e.id, e.name, e.type, COUNT(ae.article_id) AS cnt
     FROM entity e LEFT JOIN article_entity ae ON ae.entity_id = e.id
     GROUP BY e.id ORDER BY cnt DESC LIMIT ?`
  );
  nodeStmt.bind([topN]);
  const nodes: GraphNode[] = [];
  while (nodeStmt.step()) {
    const r = nodeStmt.getAsObject() as unknown as { id: string; name: string; type: string; cnt: number };
    nodes.push({ id: r.id, name: r.name, type: r.type, count: r.cnt, kind: 'entity' });
  }
  nodeStmt.free();

  // 事件节点（可选项）
  const eventById = new Map<string, string>();
  if (includeEvents) {
    const evtStmt = db.prepare(
      `SELECT e.id, e.title, e.occurred_at,
              (SELECT COUNT(*) FROM article_event ae WHERE ae.event_id = e.id) AS cnt
       FROM event e ORDER BY cnt DESC LIMIT ?`
    );
    evtStmt.bind([eventLimit]);
    while (evtStmt.step()) {
      const r = evtStmt.getAsObject() as unknown as {
        id: string;
        title: string;
        occurred_at: string | null;
        cnt: number;
      };
      const nodeId = `evt:${r.id}`;
      eventById.set(r.id, nodeId);
      nodes.push({
        id: nodeId,
        name: r.title,
        type: 'event',
        count: r.cnt,
        kind: 'event',
        occurredAt: r.occurred_at ?? undefined
      });
    }
    evtStmt.free();
  }

  const ids = new Set(nodes.map((n) => n.id));
  const links: GraphLink[] = [];

  // 实体共现边
  const edgeStmt = db.prepare(
    `SELECT source, target, weight FROM graph_edge ORDER BY weight DESC LIMIT 300`
  );
  while (edgeStmt.step()) {
    const r = edgeStmt.getAsObject() as unknown as { source: string; target: string; weight: number };
    const s = r.source.toLowerCase();
    const t = r.target.toLowerCase();
    if (ids.has(s) && ids.has(t)) {
      links.push({ source: s, target: t, weight: r.weight });
    }
  }
  edgeStmt.free();

  // 事件→实体边：事件与其关联文章命中的实体共享连接
  if (includeEvents) {
    const evtEdgeStmt = db.prepare(
      `SELECT ae2.event_id AS event_id, ae1.entity_id AS entity_id, COUNT(*) AS weight
       FROM article_event ae2 JOIN article_entity ae1 ON ae1.article_id = ae2.article_id
       GROUP BY ae2.event_id, ae1.entity_id`
    );
    while (evtEdgeStmt.step()) {
      const r = evtEdgeStmt.getAsObject() as unknown as {
        event_id: string;
        entity_id: string;
        weight: number;
      };
      const src = eventById.get(r.event_id);
      if (src && ids.has(r.entity_id)) {
        links.push({ source: src, target: r.entity_id, weight: r.weight });
      }
    }
    evtEdgeStmt.free();
  }

  return { nodes, links };
}

