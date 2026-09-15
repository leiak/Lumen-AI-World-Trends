import { describe, it, expect } from 'vitest';
import { buildMarkdownSnapshot, buildJsonSnapshot } from '../electron/main/export/snapshot.js';
import type { Insight } from '../shared/insight.js';
import type { CausalChain } from '../shared/causal.js';
import type { TrendsResult } from '../shared/trend.js';

const trends: TrendsResult = {
  trends: [{ key: 'china', name: 'China', count: 8, buckets: [], momentum: 3, rising: true }],
  countries: [{ name: 'China', count: 8 }],
  generatedAt: '2026-01-09T00:00:00Z'
};

const insight: Insight = {
  id: 'i1', type: 'causal', title: '制裁推高油价', content: '因为制裁升级，所以油价上行。',
  generatedAt: '2026-01-09T00:00:00Z', model: 'mock'
};

const chain: CausalChain = {
  id: 'c1', rootEntity: 'China', generatedAt: '2026-01-09T00:00:00Z', model: 'mock',
  nodes: [
    { eventId: 'ev1', title: 'China sanctions', occurredAt: '2026-01-01T00:00:00Z', articleCount: 3 },
    { eventId: 'ev2', title: 'Oil price jumps', occurredAt: '2026-01-03T00:00:00Z', articleCount: 2 }
  ],
  entities: ['China', 'Oil'],
  links: [{ fromEventId: 'ev1', toEventId: 'ev2', anchor: 'Oil', kind: 'ai', assertion: '因为制裁升级，所以油价上行。' }],
  summary: '制裁推高油价。'
};

const input = {
  generatedAt: '2026-01-09T12:00:00Z',
  insights: [insight],
  chains: [chain],
  narratives: [chain],
  trends
};

describe('export snapshot', () => {
  it('Markdown 含趋势/AI 解读/因果链各段落', () => {
    const md = buildMarkdownSnapshot(input);
    expect(md).toContain('# Lumen');
    expect(md).toContain('- China: 8 篇 (动量 +3 ▲)');
    expect(md).toContain('[causal] 制裁推高油价');
    expect(md).toContain('因为制裁升级，所以油价上行。');
    expect(md).toContain('### China · mock ·');
    expect(md).toContain('2. Oil price jumps');
    expect(md).toContain('锚点 Anchor: Oil [AI]：因为制裁升级，所以油价上行。');
    expect(md).toContain('摘要 Summary: 制裁推高油价。');
    expect(md).toContain('## 全局叙事 / Narratives');
    expect(md).toContain('### China（2 实体） · mock ·');
    expect(md).toContain('- 全局叙事: 1');
    expect(md).toContain('# AI 解读');
  });

  it('空数据时输出 none 占位', () => {
    const md = buildMarkdownSnapshot({ generatedAt: 'x', insights: [], chains: [], trends: null });
    expect(md).toContain('- 无 / none');
    expect(md).toContain('## 数据量 / Stats');
  });

  it('JSON 快照可反序列化且字段完整', () => {
    const parsed = JSON.parse(buildJsonSnapshot(input)) as {
      generatedAt: string; insights: Insight[]; chains: CausalChain[]; trends: TrendsResult | null;
    };
    expect(parsed.generatedAt).toBe('2026-01-09T12:00:00Z');
    expect(parsed.insights).toHaveLength(1);
    expect(parsed.chains[0]?.rootEntity).toBe('China');
    expect(parsed.trends?.trends[0]?.name).toBe('China');
  });
});
