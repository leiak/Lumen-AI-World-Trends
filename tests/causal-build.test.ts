import { describe, it, expect } from 'vitest';
import initSqlJs from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { insertArticles } from '../electron/main/db/persistence.js';
import { saveEntities, saveArticleEntities, saveEvents } from '../electron/main/graph/repository.js';
import { buildCausalChain } from '../electron/main/causal/build.js';
import type { SourceArticle } from '../shared/models.js';

async function seedTwoEvents() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  migrate(db);
  const art = (id: string, at: string): SourceArticle => ({
    id, source: 'bbc', title: `Story ${id}`, url: `http://x/${id}`,
    lang: 'en', publishedAt: null, crawledAt: at, rawHash: id
  });
  insertArticles(db, [art('a1', '2026-01-01T08:00:00Z'), art('a2', '2026-01-03T08:00:00Z')]);

  const china = { name: 'China', type: 'country' as const, lang: 'en' as const };
  const oil = { name: 'Oil', type: 'topic' as const, lang: 'en' as const };
  saveEntities(db, [china, oil]);
  saveArticleEntities(db, 'a1', [china, oil], '2026-01-01T08:00:00Z');
  saveArticleEntities(db, 'a2', [china, oil], '2026-01-03T08:00:00Z');
  // 事件1 关联 a1，事件2 关联 a2；共享实体 Oil（China 除外）
  saveEvents(db, [
    { id: 'ev1', title: 'China sanctions', articleIds: ['a1'], entityIds: ['china', 'oil'], occurredAt: '2026-01-01T08:00:00Z' },
    { id: 'ev2', title: 'Oil price jumps', articleIds: ['a2'], entityIds: ['china', 'oil'], occurredAt: '2026-01-03T08:00:00Z' }
  ]);
  return db;
}

describe('buildCausalChain', () => {
  it('按时间排序生成事件链与共享实体锚点', async () => {
    const db = await seedTwoEvents();
    const chain = buildCausalChain(db, 'China', { maxEvents: 5 });
    expect(chain).not.toBeNull();
    expect(chain!.nodes.map((n) => n.eventId)).toEqual(['ev1', 'ev2']);
    expect(chain!.nodes[0]!.title).toBe('China sanctions');
    expect(chain!.links).toHaveLength(1);
    expect(chain!.links[0]!.fromEventId).toBe('ev1');
    expect(chain!.links[0]!.toEventId).toBe('ev2');
    expect(chain!.links[0]!.anchor).toBe('Oil');
    expect(chain!.links[0]!.kind).toBe('rule');
    expect(chain!.model).toBe('rule');
    db.close();
  });

  it('单事件或未知实体返回 null', async () => {
    const db = await seedTwoEvents();
    const single = buildCausalChain(db, 'China', { maxEvents: 1 });
    expect(single).toBeNull();
    expect(buildCausalChain(db, 'Atlantis')).toBeNull();
    db.close();
  });
});