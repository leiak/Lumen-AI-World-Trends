import { describe, it, expect, beforeEach } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { insertArticles } from '../electron/main/db/persistence.js';
import { listByHot, saveArticleEntities } from '../electron/main/graph/repository.js';
import type { SourceArticle } from '../shared/models.js';

function makeArticle(overrides: Partial<SourceArticle>): SourceArticle {
  return {
    id: overrides.id ?? 'id-' + Math.random().toString(36).slice(2, 8),
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

describe('listByHot', () => {
  let db: Database;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    migrate(db);
  });

  it('returns articles with hot_score DESC within 24h window', () => {
    const now = new Date();
    const h2 = new Date(now.getTime() - 2 * 3600 * 1000).toISOString();
    const h5 = new Date(now.getTime() - 5 * 3600 * 1000).toISOString();
    const d2 = new Date(now.getTime() - 48 * 3600 * 1000).toISOString();
    saveArticle(db, makeArticle({ rawHash: 'a1', title: '24h 内 #1', publishedAt: h2, hotScore: 100 }));
    saveArticle(db, makeArticle({ rawHash: 'a2', title: '24h 内 #2', publishedAt: h5, hotScore: 200 }));
    saveArticle(db, makeArticle({ rawHash: 'a3', title: '24h 外', publishedAt: d2, hotScore: 999 }));

    const out = listByHot(db, { window: '24h' });
    expect(out.map((a) => a.title)).toEqual(['24h 内 #2', '24h 内 #1']);
    expect(out.every((a) => a.hotScore !== null && a.hotScore !== undefined)).toBe(true);
  });

  it('excludes articles with NULL hot_score', () => {
    saveArticle(db, makeArticle({ rawHash: 'b1', title: '有热度', hotScore: 50 }));
    saveArticle(db, makeArticle({ rawHash: 'b2', title: '无热度 (RSS)', hotScore: null }));

    const out = listByHot(db, { window: 'all' });
    expect(out.map((a) => a.title)).toEqual(['有热度']);
  });

  it('window=7d includes 24h-7d window', () => {
    const d3 = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    const d10 = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    saveArticle(db, makeArticle({ rawHash: 'c1', title: '3 天前', publishedAt: d3, hotScore: 10 }));
    saveArticle(db, makeArticle({ rawHash: 'c2', title: '10 天前', publishedAt: d10, hotScore: 999 }));

    const out = listByHot(db, { window: '7d' });
    expect(out.map((a) => a.title)).toEqual(['3 天前']);
  });

  it('countryEntity filters via article_entity join', () => {
    saveArticle(db, makeArticle({ rawHash: 'd1', title: '中国热点', hotScore: 100 }));
    saveArticle(db, makeArticle({ rawHash: 'd2', title: '日本热点', hotScore: 80 }));
    saveArticleEntities(db, 'd1', [{ name: '中国', type: 'country', lang: 'zh' }], new Date().toISOString());
    saveArticleEntities(db, 'd2', [{ name: '日本', type: 'country', lang: 'zh' }], new Date().toISOString());

    const out = listByHot(db, { window: 'all', countryEntity: '中国' });
    expect(out.map((a) => a.title)).toEqual(['中国热点']);
  });

  it('limit cap works', () => {
    for (let i = 0; i < 10; i++) {
      saveArticle(db, makeArticle({ rawHash: 'e' + i, title: 'a' + i, hotScore: 100 - i }));
    }
    const out = listByHot(db, { window: 'all', limit: 3 });
    expect(out).toHaveLength(3);
  });
});