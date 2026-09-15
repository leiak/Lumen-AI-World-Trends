import { describe, it, expect } from 'vitest';
import type { CausalChain } from '../shared/causal.js';
import {
  buildNarrativeSummaryPrompt,
  parseNarrativeSummary,
  summarizeNarrative,
  buildCounterfactualPrompt,
  parseCounterfactual,
  reasonCounterfactual
} from '../electron/main/causal/interpret.js';

const chain: CausalChain = {
  id: 'c1',
  rootEntity: 'China',
  entities: ['China', 'Oil', 'US'],
  generatedAt: '2026-01-03T00:00:00Z',
  model: 'merge',
  nodes: [
    { eventId: 'ev1', title: 'Sanctions', occurredAt: '2026-01-01T00:00:00Z', articleCount: 2 },
    { eventId: 'ev2', title: 'Oil jumps', occurredAt: '2026-01-03T00:00:00Z', articleCount: 3 }
  ],
  links: [
    { fromEventId: 'ev1', toEventId: 'ev2', anchor: 'Oil', kind: 'rule', assertion: '因为制裁，油价上行。' }
  ]
};

const fake = {
  name: 'fake',
  generate: async () =>
    'SUMMARY: 制裁推高油价，影响全球能源市场。\nCOUNTERFACTUAL: 若无制裁，油价或平稳运行。'
};

describe('叙事 AI 摘要', () => {
  it('buildNarrativeSummaryPrompt 含参与实体与事件', () => {
    const messages = buildNarrativeSummaryPrompt(chain);
    expect(messages.length).toBe(2);
    expect(messages[1]!.content).toContain('China、Oil、US');
    expect(messages[1]!.content).toContain('Oil jumps');
    expect(messages[1]!.content).toContain('因为制裁，油价上行。');
  });

  it('parseNarrativeSummary 提取 SUMMARY 行；缺失回退整段', () => {
    expect(parseNarrativeSummary('SUMMARY: 制裁推高油价。')).toBe('制裁推高油价。');
    expect(parseNarrativeSummary('SUMMARY：制裁推高油价。')).toBe('制裁推高油价。');
    expect(parseNarrativeSummary('随便说点什么')).toBe('随便说点什么');
  });

  it('summarizeNarrative 产出带摘要的链', async () => {
    const out = await summarizeNarrative(fake, chain, '2026-01-05T00:00:00Z');
    expect(out.summary).toContain('制裁推高油价');
    expect(out.model).toBe('fake');
    expect(out.generatedAt).toBe('2026-01-05T00:00:00Z');
    expect(out.entities).toEqual(['China', 'Oil', 'US']);
  });
});

describe('反事实推演', () => {
  it('buildCounterfactualPrompt 默认假设首个事件', () => {
    const messages = buildCounterfactualPrompt(chain);
    expect(messages[1]!.content).toContain('如果首个事件「Sanctions」没有发生');
  });

  it('自定义假设被带入提示词', () => {
    const messages = buildCounterfactualPrompt(chain, '如果油价没有上涨');
    expect(messages[1]!.content).toContain('如果油价没有上涨');
  });

  it('parseCounterfactual 提取 COUNTERFACTUAL 行；缺失回退整段', () => {
    expect(parseCounterfactual('COUNTERFACTUAL: 若无制裁，油价或平稳运行。')).toBe('若无制裁，油价或平稳运行。');
    expect(parseCounterfactual('没有标记的文本')).toBe('没有标记的文本');
  });

  it('reasonCounterfactual 产出推演文本', async () => {
    const out = await reasonCounterfactual(fake, chain);
    expect(out.text).toContain('若无制裁');
    expect(out.model).toBe('fake');
    expect(out.generatedAt.length).toBeGreaterThan(0);
  });
});