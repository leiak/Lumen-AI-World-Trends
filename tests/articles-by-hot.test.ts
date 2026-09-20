import { describe, it, expect, beforeEach } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { insertArticles } from '../electron/main/db/persistence.js';
import { listByHot, saveArticleEntities } from '../electron/main/graph/repository.js';
import type { SourceArticle } from '../shared/models.js';

/**
 * IPC end-to-end tests for `articles:byHot`.
 *
 * The IPC handler `articles:byHot` in electron/main/ipc/register.ts delegates
 * straight to `listByHot(db, payload)`. Exercising `listByHot` against an
 * in-memory sql.js database with the project's real migration schema is
 * therefore an end-to-end test of the IPC-shaped query path.
 */

function makeArticle(overrides: Partial<SourceArticle>): SourceArticle {
  return {
    id: overrides.id ?? overrides.rawHash ?? 'id-' + Math.random().toString(36).slice(2, 8),
    source: overrides.source ?? 'weibo-hot',
    title: overrides.title ?? '某热点话题',
    content: '',
    url: overrides.url ?? 'https://example.com/' + Math.random(),
    lang: overrides.lang ?? 'zh',
    publishedAt: overrides.publishedAt ?? new Date().toISOString(),
    crawledAt: overrides.crawledAt ?? new Date().toISOString(),
    rawHash: overrides.rawHash ?? 'h-' + Math.random().toString(36).slice(2, 10),
    hotScore: overrides.hotScore ?? null
  };
}

function saveArticle(db: Database, a: SourceArticle): void {
  insertArticles(db, [a]);
}

describe('articles:byHot end-to-end', () => {
  let db: Database;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    migrate(db);
  });

  it('listByHot({ window: 24h, limit: 2 }) returns top hot articles (NULL hot_score excluded)', () => {
    saveArticle(db, makeArticle({ rawHash: 'top1', title: 'top', hotScore: 500 }));
    saveArticle(db, makeArticle({ rawHash: 'top2', title: 'mid', hotScore: 300 }));
    saveArticle(db, makeArticle({ rawHash: 'top3', title: 'low', hotScore: 100 }));
    // Should be excluded: NULL hot_score (e.g. RSS without engagement signal).
    saveArticle(db, makeArticle({ rawHash: 'noScore', title: 'no-signal', hotScore: null }));

    const out = listByHot(db, { window: '24h', limit: 2 });

    expect(out).toHaveLength(2);
    expect(out[0].hotScore).toBe(500);
    expect(out[0].title).toBe('top');
    expect(out[1].hotScore).toBe(300);
    expect(out[1].title).toBe('mid');
    // NULL hot_score must be filtered out.
    expect(out.every((a) => a.hotScore !== null && a.hotScore !== undefined)).toBe(true);
    expect(out.map((a) => a.title)).not.toContain('no-signal');
  });

  it('listByHot({ countryEntity: 中国 }) filters via article_entity', () => {
    saveArticle(db, makeArticle({ rawHash: 'cn', title: '中国热点', hotScore: 100 }));
    saveArticle(db, makeArticle({ rawHash: 'jp', title: '日本热点', hotScore: 80 }));
    saveArticle(db, makeArticle({ rawHash: 'us', title: '美国热点', hotScore: 60 }));

    saveArticleEntities(
      db,
      'cn',
      [{ name: '中国', type: 'country', lang: 'zh' }],
      new Date().toISOString()
    );
    saveArticleEntities(
      db,
      'jp',
      [{ name: '日本', type: 'country', lang: 'zh' }],
      new Date().toISOString()
    );
    saveArticleEntities(
      db,
      'us',
      [{ name: '美国', type: 'country', lang: 'zh' }],
      new Date().toISOString()
    );

    const out = listByHot(db, { window: 'all', countryEntity: '中国' });

    expect(out.map((a) => a.title)).toEqual(['中国热点']);
    expect(out).toHaveLength(1);
    expect(out[0].rawHash).toBe('cn');
  });

  it('listByHot({ limit: 3 }) respects limit cap', () => {
    for (let i = 0; i < 5; i++) {
      saveArticle(db, makeArticle({ rawHash: 'cap' + i, title: 'a' + i, hotScore: 50 - i }));
    }

    const out = listByHot(db, { window: 'all', limit: 3 });

    expect(out).toHaveLength(3);
    // Top three by hot_score DESC.
    expect(out.map((a) => a.hotScore)).toEqual([50, 49, 48]);
  });
});
