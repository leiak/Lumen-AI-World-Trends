import { describe, it, expect } from 'vitest';
import initSqlJs from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { insertArticles } from '../electron/main/db/persistence.js';
import { saveEntities, saveArticleEntities } from '../electron/main/graph/repository.js';
import { countryDetail, countrySeries } from '../electron/main/world/detail.js';
import type { SourceArticle } from '../shared/models.js';

async function seed() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  migrate(db);

  const art = (id: string, at: string): SourceArticle => ({
    id, source: 'bbc', title: `Story ${id}`, url: `http://x/${id}`,
    lang: 'en', publishedAt: null, crawledAt: at, rawHash: id
  });
  insertArticles(db, [art('a1', '2026-01-02T08:00:00Z'), art('a2', '2026-01-02T10:00:00Z'), art('a3', '2026-01-01T08:00:00Z')]);

  const china = { name: 'China', type: 'country' as const, lang: 'en' as const };
  const us = { name: 'US', type: 'country' as const, lang: 'en' as const };
  const russia = { name: 'Russia', type: 'country' as const, lang: 'en' as const };
  const ukraine = { name: 'Ukraine', type: 'country' as const, lang: 'en' as const };
  saveEntities(db, [china, us, russia, ukraine]);
  saveArticleEntities(db, 'a1', [china, us, ukraine], '2026-01-02T08:00:00Z');
  saveArticleEntities(db, 'a2', [china, russia], '2026-01-02T10:00:00Z');
  saveArticleEntities(db, 'a3', [china, us], '2026-01-01T08:00:00Z');
  return db;
}

describe('countryDetail', () => {
  it('返回文章数、关联话题与相关文章', async () => {
    const db = await seed();
    const d = countryDetail(db, 'China');
    expect(d).not.toBeNull();
    expect(d!.count).toBe(3);
    const us = d!.topics.find((tp) => tp.name === 'US');
    expect(us?.count).toBe(2);
    expect(d!.articles.map((a) => a.id).sort()).toEqual(['a1', 'a2', 'a3']);
    expect(d!.articles[0]?.id).toBe('a2'); // 最新在前
    db.close();
  });

  it('未知国家返回 null', async () => {
    const db = await seed();
    expect(countryDetail(db, 'NotACountry')).toBeNull();
    db.close();
  });
});

describe('countrySeries', () => {
  it('返回按名字的时间桶序列', async () => {
    const db = await seed();
    const res = countrySeries(db, ['China', 'US'], { now: '2026-01-02T12:00:00Z', bucketCount: 4 });
    const china = res.series.find((s) => s.name === 'China');
    const us = res.series.find((s) => s.name === 'US');
    expect(china?.points.reduce((s, p) => s + p.count, 0)).toBe(3);
    expect(us?.points.reduce((s, p) => s + p.count, 0)).toBe(2);
    expect(res.series.length).toBe(2);
    db.close();
  });
});