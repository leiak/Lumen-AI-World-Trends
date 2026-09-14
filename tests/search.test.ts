import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { insertArticles } from '../electron/main/db/persistence.js';
import { searchArticles } from '../electron/main/graph/repository.js';
import type { SourceArticle } from '../shared/models.js';

let db: Database;

beforeAll(async () => {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  migrate(db);
  const arts: SourceArticle[] = [
    { id: 'a', source: 'bbc', title: 'China tariffs rise', content: 'export data', url: 'u1', lang: 'en', publishedAt: null, crawledAt: '2026-01-02T00:00:00Z', rawHash: 'a' },
    { id: 'b', source: 'guardian', title: 'Markets', content: 'China export signal', url: 'u2', lang: 'en', publishedAt: null, crawledAt: '2026-01-01T00:00:00Z', rawHash: 'b' }
  ];
  insertArticles(db, arts);
});

describe('searchArticles', () => {
  it('按标题命中', () => {
    const rows = searchArticles(db, 'tariffs');
    expect(rows.map((r) => r.id)).toContain('a');
  });
  it('按内容命中', () => {
    const rows = searchArticles(db, 'export');
    expect(rows.length).toBe(2);
  });
  it('按时间降序', () => {
    const rows = searchArticles(db, 'China');
    expect(rows[0].crawledAt > rows[1].crawledAt).toBe(true);
  });
});
