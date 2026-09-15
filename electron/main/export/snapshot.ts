import type { Insight } from '../../../shared/insight.js';
import type { CausalChain } from '../../../shared/causal.js';
import type { TrendsResult } from '../../../shared/trend.js';

export interface ExportSnapshotInput {
  generatedAt: string;
  insights: Insight[];
  chains: CausalChain[];
  narratives?: CausalChain[];
  trends: TrendsResult | null;
}

const fmtTime = (iso: string): string => (iso || '').replace('T', ' ').slice(0, 19);

function pushLinks(out: string[], chain: CausalChain): void {
  let i = 1;
  for (const node of chain.nodes) {
    out.push(`${i}. ${node.title}（${fmtTime(node.occurredAt)}，${node.articleCount} 篇）`);
    i++;
    for (const l of chain.links.filter((x) => x.fromEventId === node.eventId)) {
      out.push(
        `   → 锚点 Anchor: ${l.anchor} [${l.kind === 'ai' ? 'AI' : 'rule'}]${l.assertion ? `：${l.assertion}` : ''}`
      );
    }
  }
}

export function buildMarkdownSnapshot(input: ExportSnapshotInput): string {
  const { generatedAt, insights, chains, trends } = input;
  const out: string[] = [];
  out.push('# Lumen 世界趋势快照 / World Trends Snapshot');
  out.push('');
  out.push(`生成时间 Generated: ${fmtTime(generatedAt)}`);
  out.push('');

  out.push('## 趋势总览 / Trends');
  if (trends && trends.trends.length > 0) {
    for (const tp of trends.trends) {
      out.push(`- ${tp.name}: ${tp.count} 篇 (动量 ${tp.momentum > 0 ? '+' : ''}${tp.momentum} ${tp.rising ? '▲' : '▼'})`);
    }
    if (trends.countries.length > 0) {
      out.push('');
      out.push(`国家热点 Countries: ${trends.countries.map((c) => `${c.name}(${c.count})`).join('、')}`);
    }
  } else {
    out.push('- 无 / none');
  }
  out.push('');

  out.push('## AI 解读 / AI Insights');
  if (insights.length > 0) {
    for (const ins of insights) {
      out.push(`### [${ins.type}] ${ins.title} · ${ins.model} · ${fmtTime(ins.generatedAt)}`);
      out.push('');
      out.push(ins.content);
      out.push('');
    }
  } else {
    out.push('- 无 / none');
    out.push('');
  }

  out.push('## 因果链 / Causal Chains');
  if (chains.length > 0) {
    for (const c of chains) {
      out.push(`### ${c.rootEntity} · ${c.model} · ${fmtTime(c.generatedAt)} (${c.nodes.length} 事件 / ${c.links.length} 链路)`);
      out.push('');
      pushLinks(out, c);
      out.push('');
      out.push(`摘要 Summary: ${c.summary ?? '无 / none'}`);
      out.push('');
    }
  } else {
    out.push('- 无 / none');
    out.push('');
  }

  out.push('## 全局叙事 / Narratives');
  if (input.narratives && input.narratives.length > 0) {
    for (const n of input.narratives) {
      const entitiesLabel = n.entities && n.entities.length > 1 ? `（${n.entities.length} 实体）` : '';
      out.push(`### ${n.rootEntity}${entitiesLabel} · ${n.model} · ${fmtTime(n.generatedAt)} (${n.nodes.length} 事件 / ${n.links.length} 链路)`);
      out.push('');
      pushLinks(out, n);
      out.push('');
      if (n.summary) out.push(`摘要 Summary: ${n.summary}`);
      out.push('');
    }
  } else {
    out.push('- 无 / none');
    out.push('');
  }

  out.push('## 数据量 / Stats');
  out.push(`- AI 解读: ${insights.length}`);
  out.push(`- 因果链: ${chains.length}`);
  out.push(`- 全局叙事: ${input.narratives?.length ?? 0}`);
  out.push('');
  return out.join('\n');
}

export function buildJsonSnapshot(input: ExportSnapshotInput): string {
  return JSON.stringify(input, null, 2);
}

