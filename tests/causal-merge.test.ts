import { describe, it, expect } from 'vitest';
import initSqlJs from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { insertArticles } from '../electron/main/db/persistence.js';
import { saveEntities, saveArticleEntities, saveEvents } from '../electron/main/graph/repository.js';
import { mergeCausalChains, buildGlobalNarratives } from '../electron/main/causal/merge.js';
import type { CausalChain } from '../shared/causal.js';
import type { SourceArticle } from '../shared/models.js';

function chain(
  id: string,
  root: string,
  events: { id: string; title: string; at: string; cnt: number }[],
  links: { from: string; to: string; anchor: string }[],
  model = 'rule'
): CausalChain {
  return {
    id,
    rootEntity: root,
    generatedAt: '2026-01-09T00:00:00Z',
    model,
    nodes: events.map((e) => ({ eventId: e.id, title: e.title, occurredAt: e.at, articleCount: e.cnt })),
    links: links.map((l) => ({ fromEventId: l.from, toEventId: l.to, anchor: l.anchor, kind: 'rule' }))
  };
}

describe('mergeCausalChains', () => {
  it('共享事件的两条链合并为一条并按时间排节点', () => {
    const a = chain('a', 'China', [
      { id: 'ev1', title: 'A1', at: '2026-01-01T00:00:00Z', cnt: 3 },
      { id: 'ev2', title: 'A2', at: '2026-01-03T00:00:00Z', cnt: 5 }
    ], [{ from: 'ev1', to: 'ev2', anchor: 'Oil' }]);
    const b = chain('b', 'Oil', [
      { id: 'ev2', title: 'A2', at: '2026-01-03T00:00:00Z', cnt: 5 },
      { id: 'ev3', title: 'B2', at: '2026-01-05T00:00:00Z', cnt: 2 }
    ], [{ from: 'ev2', to: 'ev3', anchor: 'US' }]);
    const merged = mergeCausalChains([a, b]);
    expect(merged).toHaveLength(1);
    const m = merged[0]!;
    expect(m.nodes.map((n) => n.eventId)).toEqual(['ev1', 'ev2', 'ev3']);
    expect(m.links).toHaveLength(2);
    expect(m.model).toBe('merge');
    expect(m.entities).toEqual(['China', 'Oil']);
  });

  it('无共享事件的多条链保持分离', () => {
    const a = chain('a', 'China', [
      { id: 'ev1', title: 'A1', at: '2026-01-01T00:00:00Z', cnt: 1 },
      { id: 'ev2', title: 'A2', at: '2026-01-03T00:00:00Z', cnt: 1 }
    ], [{ from: 'ev1', to: 'ev2', anchor: 'X' }]);
    const b = chain('b', 'US', [
      { id: 'ev9', title: 'B1', at: '2026-01-02T00:00:00Z', cnt: 1 },
      { id: 'ev8', title: 'B2', at: '2026-01-04T00:00:00Z', cnt: 1 }
    ], [{ from: 'ev9', to: 'ev8', anchor: 'Y' }]);
    const out = mergeCausalChains([a, b]);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.nodes.length).sort((x, y) => y - x)).toEqual([2, 2]);
  });

  it('重复链路去重且主根取节点最多者', () => {
    const link = { from: 'ev1', to: 'ev2', anchor: 'Oil' };
    const a = chain('a', 'China', [
      { id: 'ev1', title: 'A1', at: '2026-01-01T00:00:00Z', cnt: 1 },
      { id: 'ev2', title: 'A2', at: '2026-01-03T00:00:00Z', cnt: 1 }
    ], [link]);
    const b = chain('b', 'Oil', [
      { id: 'ev1', title: 'A1', at: '2026-01-01T00:00:00Z', cnt: 1 },
      { id: 'ev2', title: 'A2', at: '2026-01-03T00:00:00Z', cnt: 1 }
    ], [link]);
    const merged = mergeCausalChains([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.links).toHaveLength(1);
    expect(merged[0]!.rootEntity).toBe('China');
  });
});

describe('buildGlobalNarratives', () => {
  async function seed() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    migrate(db);
    const art = (id: string, at: string): SourceArticle => ({
      id, source: 'bbc', title: `Story ${id}`, url: `http://x/${id}`,
      lang: 'en', publishedAt: null, crawledAt: at, rawHash: id
    });
    insertArticles(db, [
      art('a1', '2026-01-01T08:00:00Z'),
      art('a2', '2026-01-03T08:00:00Z'),
      art('a3', '2026-01-05T08:00:00Z'),
      art('a4', '2026-02-01T08:00:00Z'),
      art('a5', '2026-02-03T08:00:00Z')
    ]);
    const china = { name: 'China', type: 'country' as const, lang: 'en' as const };
    const oil = { name: 'Oil', type: 'topic' as const, lang: 'en' as const };
    const us = { name: 'US', type: 'country' as const, lang: 'en' as const };
    const fed = { name: 'Fed', type: 'organization' as const, lang: 'en' as const };
    saveEntities(db, [china, oil, us, fed]);
    saveArticleEntities(db, 'a1', [china, oil], '2026-01-01T08:00:00Z');
    saveArticleEntities(db, 'a2', [china, oil], '2026-01-03T08:00:00Z');
    saveArticleEntities(db, 'a3', [china, oil], '2026-01-05T08:00:00Z');
    saveArticleEntities(db, 'a4', [us, fed], '2026-02-01T08:00:00Z');
    saveArticleEntities(db, 'a5', [us, fed], '2026-02-03T08:00:00Z');
    saveEvents(db, [
      { id: 'ev1', title: 'China export ban', articleIds: ['a1'], entityIds: ['china', 'oil'], occurredAt: '2026-01-01T08:00:00Z' },
      { id: 'ev2', title: 'Oil price jumps', articleIds: ['a2'], entityIds: ['china', 'oil'], occurredAt: '2026-01-03T08:00:00Z' },
      { id: 'ev3', title: 'China stimulus', articleIds: ['a3'], entityIds: ['china', 'oil'], occurredAt: '2026-01-05T08:00:00Z' },
      { id: 'ev4', title: 'US Fed policy', articleIds: ['a4'], entityIds: ['us', 'fed'], occurredAt: '2026-02-01T08:00:00Z' },
      { id: 'ev5', title: 'US markets rally', articleIds: ['a5'], entityIds: ['us', 'fed'], occurredAt: '2026-02-03T08:00:00Z' }
    ]);
    return db;
  }

  it('把跨实体共享事件的链合并成两条叙事', async () => {
    const db = await seed();
    const narratives = buildGlobalNarratives(db, { maxEntities: 10 });
    expect(narratives).toHaveLength(2);
    const big = narratives.find((n) => n.nodes.length === 3);
    expect(big).toBeDefined();
    expect(big!.nodes.map((n) => n.eventId)).toEqual(['ev1', 'ev2', 'ev3']);
    expect(big!.entities).toEqual(expect.arrayContaining(['China', 'Oil']));
    expect(big!.links).toHaveLength(2);
    expect(big!.model).toBe('merge');
    const small = narratives.find((n) => n.nodes.length === 2);
    expect(small).toBeDefined();
    expect(small!.nodes.map((n) => n.eventId)).toEqual(['ev4', 'ev5']);
    expect(small!.entities).toEqual(expect.arrayContaining(['US', 'Fed']));
    db.close();
  });
});