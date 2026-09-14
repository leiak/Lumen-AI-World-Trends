import { describe, it, expect } from 'vitest';
import initSqlJs from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { insertArticles, upsertSourceState } from '../electron/main/db/persistence.js';
import { saveEntities, saveArticleEntities, saveEvents } from '../electron/main/graph/repository.js';
import { loadDashboardSnapshot } from '../electron/main/dash/summary.js';
import type { SourceArticle } from '../shared/models.js';

async function seed() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  migrate(db);

  const art = (id: string, at: string): SourceArticle => ({
    id, source: 'bbc', title: `Story ${id}`, url: `http://x/${id}`,
    lang: 'en', publishedAt: null, crawledAt: at, rawHash: id
  });
  insertArticles(db, [
    art('a1', '2026-01-02T08:00:00Z'), // 今日
    art('a2', '2026-01-02T10:00:00Z'), // 今日
    art('a3', '2026-01-01T08:00:00Z')  // 昨日
  ]);
  upsertSourceState(db, 'bbc', '2026-01-02T11:00:00Z');

  const china = { name: 'China', type: 'country' as const, lang: 'en' as const };
  const us = { name: 'US', type: 'country' as const, lang: 'en' as const };
  saveEntities(db, [china, us]);
  saveArticleEntities(db, 'a1', [china, us], '2026-01-02T08:00:00Z');
  saveArticleEntities(db, 'a2', [china], '2026-01-02T10:00:00Z');
  saveEvents(db, [
    { id: 'ev1', title: 'China event', articleIds: ['a1'], entityIds: ['china'], occurredAt: '2026-01-02T08:00:00Z' }
  ]);
  db.run(
    `INSERT INTO graph_edge (id, source, target, relation_type, weight, first_seen_at, last_seen_at)
     VALUES ('e1','china','us','co-occurrence',2,'2026-01-02T08:00:00Z','2026-01-02T08:00:00Z')`
  );
  return db;
}

describe('loadDashboardSnapshot', () => {
  it('汇总计数、今日新增、Top 话题与调度状态', async () => {
    const db = await seed();
    const snap = loadDashboardSnapshot(db, {
      now: '2026-01-02T12:00:00Z',
      intervalMinutes: 30,
      lastAutoRunAt: '2026-01-02T09:00:00Z'
    });

    expect(snap.metrics.articles).toBe(3);
    expect(snap.metrics.entities).toBe(2);
    expect(snap.metrics.events).toBe(1);
    expect(snap.metrics.edges).toBe(1);
    expect(snap.metrics.addedToday).toBe(2);

    expect(snap.topTopics.length).toBe(2);
    const china = snap.topTopics.find((t) => t.name === 'China');
    expect(china?.count).toBe(2);
    expect(snap.topTopics[0]?.name).toBe('China');

    expect(snap.lastCrawlAt).toBe('2026-01-02T11:00:00Z');
    expect(snap.lastAutoRunAt).toBe('2026-01-02T09:00:00Z');
    expect(snap.autoIntervalMinutes).toBe(30);
    expect(snap.generatedAt).toBe('2026-01-02T12:00:00Z');
    db.close();
  });

  it('空库返回零值与空话题', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    migrate(db);
    const snap = loadDashboardSnapshot(db, { intervalMinutes: 30, now: '2026-01-02T12:00:00Z' });
    expect(snap.metrics.articles).toBe(0);
    expect(snap.topTopics).toEqual([]);
    expect(snap.lastCrawlAt).toBeNull();
    db.close();
  });
});