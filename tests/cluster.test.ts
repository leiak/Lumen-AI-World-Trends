import { describe, it, expect } from 'vitest';
import { clusterArticles } from '../electron/main/graph/cluster.js';
import type { NamedEntity } from '../shared/entities.js';
import type { SourceArticle } from '../shared/models.js';

const mk = (id: string, title: string, entities: string[], crawledAt: string) => {
  const article: SourceArticle = {
    id, source: 'bbc', title, url: `http://x/${id}`, lang: 'en',
    publishedAt: null, crawledAt, rawHash: id
  };
  const ents: NamedEntity[] = entities.map((name) => ({ name, type: 'country', lang: 'en' }));
  return { article, entities: ents };
};

describe('clusterArticles', () => {
  it('共享实体的文章聚到同一事件，孤立文章单独成事件', () => {
    const items = [
      mk('a', 'A', ['China'], '2026-01-01T00:00:00Z'),
      mk('b', 'B', ['China', 'US'], '2026-01-02T00:00:00Z'),
      mk('c', 'C', ['US'], '2026-01-03T00:00:00Z'),
      mk('d', 'D', [], '2026-01-04T00:00:00Z')
    ];
    const bundles = clusterArticles(items);
    // a/b/c 通过 China/US 连通为一簇，d 单独
    const abc = bundles.find((b) => b.articleIds.includes('a'));
    expect(abc?.articleIds).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    expect(bundles.some((b) => b.articleIds.length === 1 && b.articleIds[0] === 'd')).toBe(true);
  });
});
