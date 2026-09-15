import type { Insight } from '../../../shared/insight.js';
import type { CausalChain } from '../../../shared/causal.js';
import type { TrendsResult } from '../../../shared/trend.js';

export interface ExportSnapshotInput {
  generatedAt: string;
  insights: Insight[];
  chains: CausalChain[];
  trends: TrendsResult | null;
}

const fmtTime = (iso: string): string => (iso || '').replace('T', ' ').slice(0, 19);

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
      for (const [i, node] of c.nodes.entries()) {
        out.push(`${i + 1}. ${node.title}（${fmtTime(node.occurredAt)}，${node.articleCount} 篇）`);
        const link = c.links[i];
        if (link) {
          out.push(`   → 锚点 Anchor: ${link.anchor} [${link.kind === 'ai' ? 'AI' : 'rule'}]${link.assertion ? `：${link.assertion}` : ''}`);
        }
      }
      out.push('');
      out.push(`摘要 Summary: ${c.summary ?? '无 / none'}`);
      out.push('');
    }
  } else {
    out.push('- 无 / none');
    out.push('');
  }

  out.push('## 数据量 / Stats');
  out.push(`- AI 解读: ${insights.length}`);
  out.push(`- 因果链: ${chains.length}`);
  out.push('');
  return out.join('\n');
}

export function buildJsonSnapshot(input: ExportSnapshotInput): string {
  return JSON.stringify(input, null, 2);
}