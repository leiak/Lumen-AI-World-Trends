import { createHash } from 'node:crypto';
import type { TrendsResult } from '../../../shared/trend.js';
import type { Insight, InsightType } from '../../../shared/insight.js';
import type { AiProvider, ChatMessage } from './provider.js';

export function buildCausalPrompt(trends: TrendsResult): ChatMessage[] {
  const top = trends.trends.slice(0, 8).map(
    (t) => `${t.name}: ${t.count}次, 动量${t.momentum > 0 ? '+' : ''}${t.momentum}`
  );
  const countries = trends.countries.slice(0, 8).map((c) => `${c.name}: ${c.count}`);
  const context =
    '当前最热话题(top趋势):\n' +
    top.map((s) => '- ' + s).join('\n') +
    '\n\n世界热点(国家维度):\n' +
    countries.map((s) => '- ' + s).join('\n');
  return [
    {
      role: 'system',
      content:
        '你是世界趋势分析助手。基于给定热度数据，用简洁中文给出不超过 400 字的因果解读，指出最值得关注的变化与可能的因果链。'
    },
    { role: 'user', content: context }
  ];
}

export function parseInsight(
  type: InsightType,
  title: string,
  output: string,
  model: string,
  now = new Date().toISOString()
): Insight {
  return {
    id: createHash('sha1').update(`${type}|${now}|${output}`).digest('hex'),
    type,
    title,
    content: output,
    generatedAt: now,
    model
  };
}

export async function interpretCausal(
  provider: AiProvider,
  trends: TrendsResult,
  topTopic = '本周世界动态'
): Promise<Insight> {
  const messages = buildCausalPrompt(trends);
  const output = await provider.generate(messages);
  return parseInsight('causal', topTopic, output, provider.name);
}
