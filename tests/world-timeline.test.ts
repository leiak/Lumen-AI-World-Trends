import { describe, it, expect } from 'vitest';
import initSqlJs from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { insertArticles } from '../electron/main/db/persistence.js';
import { saveEntities, saveArticleEntities } from '../electron/main/graph/repository.js';
import { countryDayTimeline } from '../electron/main/world/timeline.js';
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
    art('a1', '2026-01-02T08:00:00Z'),
    art('a2', '2026-01-02T10:00:00Z'),
    art('a3', '2026-01-01T08:00:00Z'),
    art('a4', '2026-01-01T11:00:00Z')
  ]);

  const china = { name: 'China', type: 'country' as const, lang: 'en' as const };
  const us = { name: 'US', type: 'country' as const, lang: 'en' as const };
  const russia = { name: 'Russia', type: 'country' as const, lang: 'en' as const };
  const ukraine = { name: 'Ukraine', type: 'country' as const, lang: 'en' as const };
  const brazil = { name: 'Brazil', type: 'country' as const, lang: 'en' as const };
  saveEntities(db, [china, us, russia, ukraine, brazil]);
  saveArticleEntities(db, 'a1', [china, us, ukraine], '2026-01-02T08:00:00Z');
  saveArticleEntities(db, 'a2', [china, russia], '2026-01-02T10:00:00Z');
  saveArticleEntities(db, 'a3', [china, us], '2026-01-01T08:00:00Z');
  saveArticleEntities(db, 'a4', [brazil], '2026-01-01T11:00:00Z');
  return db;
}

describe('countryDayTimeline', () => {
  it('按天返回国家热度，日期升序且空日为空数组', async () => {
    const db = await seed();
    const tl = countryDayTimeline(db, { days: 4, now: '2026-01-04T12:00:00Z' });
    expect(tl.dates).toEqual(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
    expect(tl.byDate.map((d) => d.date)).toEqual(tl.dates);

    const count = (date: string, name: string): number =>
      tl.byDate.find((d) => d.date === date)?.countries.find((c) => c.name === name)?.count ?? 0;
    expect(count('2026-01-01', 'China')).toBe(1);
    expect(count('2026-01-01', 'US')).toBe(1);
    expect(count('2026-01-01', 'Brazil')).toBe(1);
    expect(count('2026-01-02', 'China')).toBe(2);
    expect(count('2026-01-02', 'US')).toBe(1);
    expect(count('2026-01-02', 'Ukraine')).toBe(1);
    expect(count('2026-01-02', 'Russia')).toBe(1);
    expect(tl.byDate[2]?.countries).toEqual([]);
    expect(tl.byDate[3]?.countries).toEqual([]);
    db.close();
  });

  it('days 钳制到 1-60，默认窗口 7 天', async () => {
    const db = await seed();
    const tl = countryDayTimeline(db, { now: '2026-01-02T12:00:00Z' });
    expect(tl.dates).toHaveLength(7);
    expect(tl.dates[0]).toBe('2025-12-27');
    expect(tl.dates[6]).toBe('2026-01-02');
    const clamped = countryDayTimeline(db, { days: 200, now: '2026-01-02T12:00:00Z' });
    expect(clamped.dates).toHaveLength(60);
    db.close();
  });
});
