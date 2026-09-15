import { createHash } from 'node:crypto';
import type { Database } from 'sql.js';
import type { CausalChain, CausalLink, CausalNode } from '../../../shared/causal.js';

export interface BuildCausalOptions {
  maxEvents?: number;
}

interface EventRow {
  id: string;
  title: string;
  occurred_at: string;
  cnt: number;
}

function loadEventsForEntity(db: Database, entityId: string, limit: number): EventRow[] {
  const stmt = db.prepare(
    `SELECT DISTINCT ev.id AS id, ev.title AS title, ev.occurred_at AS occurred_at,
            (SELECT COUNT(*) FROM article_event ae WHERE ae.event_id = ev.id) AS cnt
     FROM event ev
     JOIN article_event ae ON ae.event_id = ev.id
     JOIN article_entity ae2 ON ae2.article_id = ae.article_id
     WHERE ae2.entity_id = ? AND ev.occurred_at IS NOT NULL
     ORDER BY ev.occurred_at ASC LIMIT ?`
  );
  stmt.bind([entityId, limit]);
  const out: EventRow[] = [];
  while (stmt.step()) {
    const r = stmt.getAsObject() as unknown as EventRow;
    out.push(r);
  }
  stmt.free();
  return out;
}

function sharedEntityBetween(
  db: Database,
  eventA: string,
  eventB: string,
  exclude: string
): string | null {
  const stmt = db.prepare(
    `SELECT DISTINCT e.name AS name
     FROM article_entity ae1
     JOIN entity e ON e.id = ae1.entity_id
     JOIN article_event ev1 ON ev1.article_id = ae1.article_id AND ev1.event_id = ?
     JOIN article_entity ae2 ON ae2.entity_id = ae1.entity_id
     JOIN article_event ev2 ON ev2.article_id = ae2.article_id AND ev2.event_id = ?
     WHERE ae1.entity_id != ?
     LIMIT 1`
  );
  stmt.bind([eventA, eventB, exclude]);
  let name: string | null = null;
  if (stmt.step()) name = (stmt.getAsObject() as { name: string }).name;
  stmt.free();
  return name;
}

export function buildCausalChain(
  db: Database,
  rootEntity: string,
  opts: BuildCausalOptions = {}
): CausalChain | null {
  const entityId = rootEntity.toLowerCase();
  const maxEvents = opts.maxEvents ?? 5;
  const events = loadEventsForEntity(db, entityId, maxEvents);
  if (events.length < 2) return null;

  const nodes: CausalNode[] = events.map((e) => ({
    eventId: e.id,
    title: e.title,
    occurredAt: e.occurred_at,
    articleCount: e.cnt
  }));

  const links: CausalLink[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const anchor = sharedEntityBetween(db, nodes[i].eventId, nodes[i + 1].eventId, entityId);
    if (!anchor) continue;
    links.push({
      fromEventId: nodes[i].eventId,
      toEventId: nodes[i + 1].eventId,
      anchor,
      kind: 'rule'
    });
  }
  if (links.length === 0) return null;

  return {
    id: createHash('sha1')
      .update(`causal|${entityId}|${nodes.map((n) => n.eventId).join(',')}`)
      .digest('hex'),
    rootEntity,
    generatedAt: new Date().toISOString(),
    model: 'rule',
    nodes,
    links
  };
}
