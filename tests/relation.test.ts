import { describe, it, expect } from 'vitest';
import { buildCooccurrenceEdges } from '../electron/main/graph/relation.js';
import type { NamedEntity } from '../shared/entities.js';

const ents = (names: string[]): NamedEntity[] =>
  names.map((name) => ({ name, type: 'country', lang: 'en' }));

describe('co-occurrence relation', () => {
  it('n 个实体产生 C(n,2) 条无向边', () => {
    const article = { source: 'bbc', id: 'a1', crawledAt: '2026-01-01T00:00:00Z' };
    const edges = buildCooccurrenceEdges(article, ents(['China', 'US', 'Japan']));
    expect(edges).toHaveLength(3);
    for (const e of edges) {
      expect(e.relationType).toBe('co-occurrence');
      expect(e.source < e.target).toBe(true); // 字典序稳定
    }
  });

  it('同一 pair 的 edgeId 幂等稳定', () => {
    const a = { source: 'bbc', id: 'a1', crawledAt: '2026-01-01T00:00:00Z' };
    const b = { source: 'bbc', id: 'a2', crawledAt: '2026-01-02T00:00:00Z' };
    const e1 = buildCooccurrenceEdges(a, ents(['China', 'US']))[0];
    const e2 = buildCooccurrenceEdges(b, ents(['China', 'US']))[0];
    expect(e1.id).toBe(e2.id);
    expect(e1.source).toBe(e2.source);
  });
});
