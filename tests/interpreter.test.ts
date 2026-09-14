import { describe, it, expect } from 'vitest';
import { MockProvider } from '../electron/main/ai/provider.js';
import { interpretCausal, parseInsight, buildCausalPrompt } from '../electron/main/ai/interpreter.js';
import type { TrendsResult } from '../shared/trend.js';

const empty: TrendsResult = {
  trends: [],
  countries: [{ name: 'China', count: 5 }],
  generatedAt: '2026-01-09T00:00:00Z'
};

describe('interpreter', () => {
  it('buildCausalPrompt 含世界热点上下文', () => {
    const messages = buildCausalPrompt(empty);
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].content).toContain('China');
  });

  it('interpretCausal 用 mock 产出 Insight', async () => {
    const insight = await interpretCausal(new MockProvider(), empty);
    expect(insight.type).toBe('causal');
    expect(insight.title.length).toBeGreaterThan(0);
    expect(insight.content.length).toBeGreaterThan(0);
    expect(insight.model).toBe('mock');
  });

  it('parseInsight 生成稳定 id', () => {
    const a = parseInsight('causal', 't', 'out', 'mock', '2026-01-01T00:00:00Z');
    const b = parseInsight('causal', 't', 'out', 'mock', '2026-01-01T00:00:00Z');
    expect(a.id).toBe(b.id);
  });
});
