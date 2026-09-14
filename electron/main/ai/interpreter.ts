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

export function buildWeeklyPrompt(trends: TrendsResult): ChatMessage[] {
  const top = trends.trends.slice(0, 10).map(
    (t) => `${t.name}: ${t.count}次, 动量${t.momentum > 0 ? '+' : ''}${t.momentum}`
  );
  const countries = trends.countries.slice(0, 8).map((c) => `${c.name}: ${c.count}`);
  const context =
    '近一周热度数据:\n' +
    top.map((s) => '- ' + s).join('\n') +
    '\n\n世界热点(国家维度):\n' +
    countries.map((s) => '- ' + s).join('\n');
  return [
    {
      role: 'system',
      content:
        '你是世界趋势周报编辑。基于近一周热度数据输出一份简洁中文周报（不超过 500 字）：先用一句话总结本周格局；再分 3-5 个要点讲最值得关注的话题变化并给出数据支撑；最后给一句下周展望。'
    },
    { role: 'user', content: context }
  ];
}

export async function interpretWeekly(
  provider: AiProvider,
  trends: TrendsResult,
  now = new Date().toISOString()
): Promise<Insight> {
  const messages = buildWeeklyPrompt(trends);
  const output = await provider.generate(messages);
  return parseInsight('weekly', `周报 · ${now.slice(0, 10)}`, output, provider.name, now);
}
