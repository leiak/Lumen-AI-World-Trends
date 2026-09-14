import { describe, it, expect } from 'vitest';
import initSqlJs from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { insertArticles } from '../electron/main/db/persistence.js';
import { createGazetteer } from '../electron/main/extract/gazetteer.js';
import { buildGraph } from '../electron/main/graph/build.js';
import type { SourceArticle } from '../shared/models.js';

const mk = (id: string, title: string, content: string): SourceArticle => ({
  id, source: 'bbc', title, content, url: `http://x/${id}`, lang: 'en',
  publishedAt: null, crawledAt: `2026-01-01T00:00:0${id.length}:00Z`, rawHash: id
});

describe('buildGraph', () => {
  it('抽取实体、聚类事件、构建共现边并落库', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    migrate(db);

    const articles = [
      mk('a', 'China and US trade', 'China US export'),
      mk('b', 'US China meet', 'China United States summit')
    ];
    insertArticles(db, articles);

    const gaz = createGazetteer([
      { name: 'China', type: 'country', lang: 'en' },
      { name: 'US', type: 'country', lang: 'en' },
      { name: 'United States', type: 'country', lang: 'en' }
    ]);

    const r1 = await buildGraph(db, articles, gaz);

    expect(r1.articles).toBe(2);
    expect(r1.entities).toBe(3);
    expect(r1.events).toBe(1);
    expect(r1.edges).toBe(4); // A:1 对 + B:3 对（China-US 在 A/B 重复合并）

    const r2 = await buildGraph(db, articles, gaz);
    expect(r2.entities).toBe(0);
    expect(r2.events).toBe(0);
    db.close();
  });
});

