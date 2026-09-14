import { describe, it, expect } from 'vitest';
import initSqlJs from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { saveEntities, saveArticleEntities, saveEvents } from '../electron/main/graph/repository.js';
import { insertArticles } from '../electron/main/db/persistence.js';
import { queryGraph } from '../electron/main/graph/repository.js';

describe('queryGraph', () => {
  it('返回 topN 节点与节点间链接', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    migrate(db);
    const a = { id: 'r', source: 'bbc', title: 'T', url: 'u', lang: 'en' as const, publishedAt: null, crawledAt: '2026-01-01T00:00:00Z', rawHash: 'r' };
    insertArticles(db, [a]);
    saveEntities(db, [
      { name: 'China', type: 'country', lang: 'en' },
      { name: 'US', type: 'country', lang: 'en' },
      { name: 'Russia', type: 'country', lang: 'en' }
    ]);
    saveArticleEntities(db, 'r', [
      { name: 'China', type: 'country', lang: 'en' },
      { name: 'US', type: 'country', lang: 'en' }
    ], '2026-01-01T00:00:00Z');
    db.run('INSERT INTO graph_edge (id, source, target, relation_type, weight, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?)',
      ['e1', 'china', 'us', 'co-occurrence', 3, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z']);

    const view = queryGraph(db, 3);
    expect(view.nodes.length).toBe(3);
    expect(view.nodes.find((n) => n.name === 'China')?.count).toBe(1);
    const link = view.links.find((l) => l.source === 'china' && l.target === 'us');
    expect(link?.weight).toBe(3);
    for (const l of view.links) {
      expect(view.nodes.some((n) => n.id === l.source)).toBe(true);
      expect(view.nodes.some((n) => n.id === l.target)).toBe(true);
    }
    db.close();
  });
});

describe('queryGraph includeEvents', () => {
  it('返回事件节点与事件→实体边；关闭时不含', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    migrate(db);
    const a = { id: 'r', source: 'bbc', title: 'T', url: 'u', lang: 'en' as const, publishedAt: null, crawledAt: '2026-01-01T00:00:00Z', rawHash: 'r' };
    insertArticles(db, [a]);
    saveEntities(db, [
      { name: 'China', type: 'country', lang: 'en' },
      { name: 'US', type: 'country', lang: 'en' }
    ]);
    saveArticleEntities(db, 'r', [
      { name: 'China', type: 'country', lang: 'en' },
      { name: 'US', type: 'country', lang: 'en' }
    ], '2026-01-01T00:00:00Z');
    saveEvents(db, [
      { id: 'ev1', title: 'Crisis talks', articleIds: ['r'], entityIds: ['china', 'us'], occurredAt: '2026-01-01T00:00:00Z' }
    ]);

    const view = queryGraph(db, { topN: 10, includeEvents: true, eventLimit: 5 });
    const evt = view.nodes.find((n) => n.kind === 'event');
    expect(evt?.name).toBe('Crisis talks');
    expect(evt?.id).toBe('evt:ev1');
    const evtLinks = view.links.filter((l) => l.source === 'evt:ev1');
    expect(evtLinks.map((l) => l.target).sort()).toEqual(['china', 'us']);
    expect(evtLinks.every((l) => l.weight >= 1)).toBe(true);

    const closed = queryGraph(db, { topN: 10, includeEvents: false });
    expect(closed.nodes.some((n) => n.kind === 'event')).toBe(false);
    expect(closed.links.some((l) => l.source === 'evt:ev1')).toBe(false);
    db.close();
  });
});