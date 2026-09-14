import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { insertArticles } from '../electron/main/db/persistence.js';
import {
  saveEntities, saveEvents, mergeEdges, loadArticles
} from '../electron/main/graph/repository.js';
import type { GraphEdge } from '../electron/main/graph/relation.js';

let db: Database;

beforeAll(async () => {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  migrate(db);
});

describe('graph repository', () => {
  it('saveEntities 幂等', () => {
    const e = { name: 'China', type: 'country' as const, lang: 'en' as const };
    expect(saveEntities(db, [e])).toBe(1);
    expect(saveEntities(db, [e])).toBe(0);
  });

  it('mergeEdges 同 id 不重复新增', () => {
    const edge = (id: string, source: string, target: string): GraphEdge => ({
      id, source, target, relationType: 'co-occurrence', weight: 1,
      firstSeenAt: '2026-01-01T00:00:00Z', lastSeenAt: '2026-01-01T00:00:00Z'
    });
    const e1 = edge('x', 'China', 'US');
    expect(mergeEdges(db, [e1]).upserted).toBe(1);
    expect(mergeEdges(db, [e1]).upserted).toBe(1); // upsert 不抛错
  });

  it('saveEvents + loadArticles 落库与读取', () => {
    const articles = [{
      id: 'r1', source: 'bbc', title: 'T', url: 'http://x/1', lang: 'en' as const,
      publishedAt: null, crawledAt: '2026-01-01T00:00:00Z', rawHash: 'r1'
    }];
    expect(insertArticles(db, articles)).toBe(1);
    saveEvents(db, [{
      id: 'ev1', title: 'China event', articleIds: ['r1'], entityIds: [],
      occurredAt: '2026-01-01T00:00:00Z'
    }]);
    const loaded = loadArticles(db, 10);
    expect(loaded.some((a) => a.id === 'r1')).toBe(true);
  });
});
