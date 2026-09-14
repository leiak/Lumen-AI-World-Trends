import { createHash } from 'node:crypto';
import type { NamedEntity } from '../../../shared/entities.js';

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relationType: 'co-occurrence';
  weight: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface EdgeArticle {
  source: string;
  id: string;
  crawledAt: string;
}

export function buildCooccurrenceEdges(
  article: EdgeArticle,
  entities: NamedEntity[]
): GraphEdge[] {
  const uniq = new Map<string, NamedEntity>();
  for (const e of entities) uniq.set(e.name, e);
  const names = Array.from(uniq.values())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  const edges: GraphEdge[] = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const source = names[i];
      const target = names[j];
      edges.push({
        id: createHash('sha1').update(`${source}|${target}`).digest('hex'),
        source,
        target,
        relationType: 'co-occurrence',
        weight: 1,
        firstSeenAt: article.crawledAt,
        lastSeenAt: article.crawledAt
      });
    }
  }
  return edges;
}
