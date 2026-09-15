import { describe, it, expect } from 'vitest';
import type { CausalChain } from '../shared/causal.js';
import { buildCausalPrompt, parseCausalOutput, interpretCausalChain } from '../electron/main/causal/interpret.js';

const chain: CausalChain = {
  id: 'c1',
  rootEntity: 'China',
  generatedAt: '2026-01-03T00:00:00Z',
  model: 'rule',
  nodes: [
    { eventId: 'ev1', title: 'Sanctions', occurredAt: '2026-01-01T00:00:00Z', articleCount: 2 },
    { eventId: 'ev2', title: 'Oil jumps', occurredAt: '2026-01-03T00:00:00Z', articleCount: 3 }
  ],
  links: [{ fromEventId: 'ev1', toEventId: 'ev2', anchor: 'Oil', kind: 'rule' }]
};

const fake = {
  name: 'fake',
  generate: async () =>
    'LINK 0: 因为制裁升级，所以油价上行。\nSUMMARY: 制裁推高油价，短期难回落。'
};

describe('因果链 AI 断言', () => {
  it('buildCausalPrompt 含实体与链接索引', () => {
    const messages = buildCausalPrompt(chain);
    expect(messages.length).toBe(2);
    expect(messages[1]!.content).toContain('China');
    expect(messages[1]!.content).toContain('0: ev1 → ev2');
  });

  it('parseCausalOutput 按序号回填断言并抽取摘要', () => {
    const { links, summary } = parseCausalOutput(chain, 'LINK 0: 因为制裁升级，所以油价上行。\nSUMMARY: 制裁推高油价。');
    expect(links[0]!.kind).toBe('ai');
    expect(links[0]!.assertion).toContain('油价上行');
    expect(summary).toBe('制裁推高油价。');
  });

  it('缺 SUMMARY 行时回退整段为摘要', () => {
    const { summary } = parseCausalOutput(chain, 'LINK 0: 因为 A，所以 B。');
    expect(summary).toContain('LINK 0');
  });

  it('interpretCausalChain 产出 ai 链', async () => {
    const out = await interpretCausalChain(fake, chain, '2026-01-05T00:00:00Z');
    expect(out.model).toBe('fake');
    expect(out.generatedAt).toBe('2026-01-05T00:00:00Z');
    expect(out.links[0]!.assertion).toContain('制裁');
    expect(out.summary).toContain('短期难回落');
    expect(out.links[0]!.kind).toBe('ai');
  });
});