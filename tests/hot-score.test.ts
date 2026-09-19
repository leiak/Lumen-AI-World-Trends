import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { insertArticles } from '../electron/main/db/persistence.js';
import type { SourceArticle } from '../shared/models.js';

describe('article.hot_score', () => {
  let db: Database;

  beforeAll(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    migrate(db);
  });

  it('写入 hot_score 后可读回', () => {
    const art: SourceArticle = {
      id: 'h1',
      source: 'weibo-hot',
      title: '微博热搜条目',
      url: 'http://weibo.test/x',
      lang: 'zh',
      publishedAt: null,
      crawledAt: '2026-09-19T00:00:00Z',
      rawHash: 'h1',
      hotScore: 1234567
    };
    insertArticles(db, [art]);
    const stmt = db.prepare('SELECT hot_score FROM source_article WHERE raw_hash=?');
    stmt.bind(['h1']);
    expect(stmt.step()).toBe(true);
    const row = stmt.getAsObject() as { hot_score: number | null };
    stmt.free();
    expect(row.hot_score).toBe(1234567);
  });

  it('未填 hotScore 时为 null（兼容旧 RSS）', () => {
    const art: SourceArticle = {
      id: 'r1',
      source: 'bbc',
      title: 'Old RSS',
      url: 'http://bbc.test/x',
      lang: 'en',
      publishedAt: null,
      crawledAt: '2026-09-19T00:00:00Z',
      rawHash: 'r1'
    };
    insertArticles(db, [art]);
    const stmt = db.prepare('SELECT hot_score FROM source_article WHERE raw_hash=?');
    stmt.bind(['r1']);
    expect(stmt.step()).toBe(true);
    const row = stmt.getAsObject() as { hot_score: number | null };
    stmt.free();
    expect(row.hot_score).toBeNull();
  });
});