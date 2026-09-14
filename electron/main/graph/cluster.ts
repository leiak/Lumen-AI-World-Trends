import { createHash } from 'node:crypto';
import type { NamedEntity } from '../../../shared/entities.js';
import type { SourceArticle } from '../../../shared/models.js';

export interface ArticleWithEntities {
  article: SourceArticle;
  entities: NamedEntity[];
}

export interface EventBundle {
  id: string;
  title: string;
  articleIds: string[];
  entityIds: string[];
  occurredAt: string;
}

class UnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    let root = this.parent.get(x) ?? x;
    if (root !== x) {
      this.parent.set(x, this.find(root));
      root = this.parent.get(x)!;
    }
    return root;
  }

  union(a: string, b: string): void {
    this.parent.set(a, b);
  }
}

export function clusterArticles(items: ArticleWithEntities[]): EventBundle[] {
  const uf = new UnionFind();
  // entity -> 所属文章
  const entityArticles = new Map<string, string[]>();
  for (const item of items) {
    const seen = new Set<string>();
    for (const e of item.entities) {
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      const list = entityArticles.get(e.name) ?? [];
      list.push(item.article.id);
      entityArticles.set(e.name, list);
    }
  }
  // 共享实体的文章 union
  for (const [, ids] of entityArticles) {
    for (let i = 1; i < ids.length; i++) uf.union(ids[i], ids[0]);
  }
  // 收集成分
  const comp = new Map<string, string[]>();
  const rootOf = new Map<string, string>();
  for (const item of items) {
    const root = uf.find(item.article.id);
    const rootKey = rootOf.get(item.article.id) ?? root;
    rootOf.set(item.article.id, rootKey);
    const list = comp.get(rootKey) ?? [];
    list.push(item.article.id);
    comp.set(rootKey, list);
  }

  const byArticle = new Map(items.map((i) => [i.article.id, i]));

  return Array.from(comp.values())
    .map((articleIds) => {
      const ia = articleIds
        .map((id) => byArticle.get(id)!)
        .sort((a, b) => a.article.crawledAt.localeCompare(b.article.crawledAt));
      const allEntities = ia.flatMap((i) => i.entities);
      const count = new Map<string, number>();
      for (const e of allEntities) count.set(e.name, (count.get(e.name) ?? 0) + 1);
      const title =
        Array.from(count.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '综合事件';
      const entityIds = Array.from(new Set(allEntities.map((e) => e.name))).sort((a, b) =>
        a.localeCompare(b)
      );
      const sortedIds = [...articleIds].sort();
      return {
        id: createHash('sha1').update(sortedIds.join('|')).digest('hex'),
        title,
        articleIds: sortedIds,
        entityIds,
        occurredAt: ia[0].article.crawledAt
      };
    })
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}
