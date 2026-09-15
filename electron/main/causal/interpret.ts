import type { CausalChain, CausalLink } from '../../../shared/causal.js';
import type { AiProvider, ChatMessage } from '../ai/provider.js';

export function buildCausalPrompt(chain: CausalChain): ChatMessage[] {
  const lines = chain.nodes.map(
    (n, i) => `${i + 1}. ${n.title}（${n.occurredAt.slice(0, 10)}，${n.articleCount} 篇）`
  );
  const index = chain.links
    .map((l, i) => `${i}: ${l.fromEventId} → ${l.toEventId}（锚点 ${l.anchor}）`)
    .join('\n');
  const context = `根实体: ${chain.rootEntity}\n事件序列:\n${lines.join(
    '\n'
  )}\n链接索引(序号: 原因事件 → 结果事件, 锚点 = 共享实体):\n${index}`;
  return [
    {
      role: 'system',
      content:
        '你是因果链分析助手。基于给定事件序列与链接索引，逐段用一句话输出因果断言，格式严格为每行：LINK <序号>: 因为…，所以…（不超过 80 字）。最后用一行 SUMMARY: 输出整体摘要（不超过 120 字）。只输出上述内容，不要额外解释。'
    },
    { role: 'user', content: context }
  ];
}

export function parseCausalOutput(
  chain: CausalChain,
  output: string
): { links: CausalLink[]; summary: string } {
  const links = chain.links.map((l) => ({ ...l }));
  let summary = '';
  for (const line of output.split('\n')) {
    const linkMatch = line.match(/LINK\s+(\d+)\s*[:：]\s*(.+)/);
    if (linkMatch) {
      const idx = Number(linkMatch[1]);
      const text = linkMatch[2].trim();
      if (links[idx]) {
        links[idx].kind = 'ai';
        links[idx].assertion = text;
      }
      continue;
    }
    const sumMatch = line.match(/SUMMARY\s*[:：]\s*(.+)/i);
    if (sumMatch) {
      summary = sumMatch[1].trim();
      continue;
    }
  }
  if (!summary) summary = output.trim();
  return { links, summary };
}

export async function interpretCausalChain(
  provider: AiProvider,
  chain: CausalChain,
  now = new Date().toISOString()
): Promise<CausalChain> {
  const messages = buildCausalPrompt(chain);
  const output = await provider.generate(messages);
  const { links, summary } = parseCausalOutput(chain, output);
  return { ...chain, links, summary, model: provider.name, generatedAt: now };
}

export function buildNarrativeSummaryPrompt(chain: CausalChain): ChatMessage[] {
  const lines = chain.nodes.map(
    (n, i) => `${i + 1}. ${n.title}（${n.occurredAt.slice(0, 10)}，${n.articleCount} 篇）`
  );
  const entities = chain.entities?.length ? chain.entities.join('、') : chain.rootEntity;
  const linkLines = chain.links
    .map(
      (l, i) =>
        `${i}: ${l.fromEventId} → ${l.toEventId}（锚点 ${l.anchor}${l.assertion ? `：${l.assertion}` : ''}）`
    )
    .join('\n');
  return [
    {
      role: 'system',
      content:
        '你是全球事件叙事分析师。基于给定事件序列与因果链路，用一句话概括这段叙事的整体走向与影响（不超过 150 字）。格式严格为：SUMMARY: <内容>。只输出这一行，不要额外解释。'
    },
    {
      role: 'user',
      content: `参与实体: ${entities}\n事件序列:\n${lines.join('\n')}\n因果链路:\n${linkLines}`
    }
  ];
}

export function parseNarrativeSummary(output: string): string {
  for (const line of output.split('\n')) {
    const m = line.match(/SUMMARY\s*[:：]\s*(.+)/i);
    if (m) return m[1].trim();
  }
  return output.trim();
}

export async function summarizeNarrative(
  provider: AiProvider,
  chain: CausalChain,
  now = new Date().toISOString()
): Promise<CausalChain> {
  const summary = parseNarrativeSummary(await provider.generate(buildNarrativeSummaryPrompt(chain)));
  return { ...chain, summary, model: provider.name, generatedAt: now };
}

export function buildCounterfactualPrompt(chain: CausalChain, hypothesis?: string): ChatMessage[] {
  const lines = chain.nodes.map((n, i) => `${i + 1}. ${n.title}（${n.occurredAt.slice(0, 10)}）`);
  const entities = chain.entities?.length ? chain.entities.join('、') : chain.rootEntity;
  const h = hypothesis?.trim() || `如果首个事件「${chain.nodes[0]?.title ?? ''}」没有发生`;
  return [
    {
      role: 'system',
      content:
        '你是反事实推演分析师。基于给定事件序列与假设，推演世界走向会有哪些不同（不超过 150 字）。格式严格为：COUNTERFACTUAL: <内容>。只输出这一行，不要额外解释。'
    },
    {
      role: 'user',
      content: `参与实体: ${entities}\n事件序列:\n${lines.join('\n')}\n反事实假设: ${h}`
    }
  ];
}

export function parseCounterfactual(output: string): string {
  for (const line of output.split('\n')) {
    const m = line.match(/COUNTERFACTUAL\s*[:：]\s*(.+)/i);
    if (m) return m[1].trim();
  }
  return output.trim();
}

export async function reasonCounterfactual(
  provider: AiProvider,
  chain: CausalChain,
  hypothesis?: string
): Promise<{ text: string; model: string; generatedAt: string }> {
  const text = parseCounterfactual(await provider.generate(buildCounterfactualPrompt(chain, hypothesis)));
  return { text, model: provider.name, generatedAt: new Date().toISOString() };
}