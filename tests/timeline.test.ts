import { describe, it, expect } from 'vitest';
import initSqlJs from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { insertArticles } from '../electron/main/db/persistence.js';
import { saveEntities, saveArticleEntities, saveEvents, listEvents } from '../electron/main/graph/repository.js';
import type { SourceArticle } from '../shared/models.js';
import type { EntityType } from '../shared/entities.js';

async function seed() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  migrate(db);

  const art = (id: string, title: string, at: string): SourceArticle => ({
    id, source: 'bbc', title, url: `http://x/${id}`, lang: 'en',
    publishedAt: null, crawledAt: at, rawHash: id
  });
  insertArticles(db, [art('a1', 'Story one', '2026-01-03T00:00:00Z')]);
  insertArticles(db, [art('a2', 'Story two', '2026-01-01T00:00:00Z')]);

  const china = { name: 'China', type: 'country' as EntityType, lang: 'en' as const };
  const us = { name: 'US', type: 'country' as EntityType, lang: 'en' as const };
  saveEntities(db, [china, us]);
  saveArticleEntities(db, 'a1', [china], '2026-01-03T00:00:00Z');
  saveArticleEntities(db, 'a2', [us], '2026-01-01T00:00:00Z');

  saveEvents(db, [
    { id: 'ev1', title: 'China event', articleIds: ['a1'], entityIds: ['china'], occurredAt: '2026-01-03T00:00:00Z' },
    { id: 'ev2', title: 'US event', articleIds: ['a2'], entityIds: ['us'], occurredAt: '2026-01-01T00:00:00Z' }
  ]);
  return db;
}

describe('listEvents', () => {
  it('按时间倒序返回事件及其文章', async () => {
    const db = await seed();
    const events = listEvents(db);
    expect(events.map((e) => e.id)).toEqual(['ev1', 'ev2']);
    expect(events[0].title).toBe('China event');
    expect(events[0].articles.map((a) => a.id)).toEqual(['a1']);
    db.close();
  });
});
