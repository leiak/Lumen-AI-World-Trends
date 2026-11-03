import type { DebateState, RiskDebateState } from '../../../shared/agent.js';

/** 辩论路由纯函数：只读状态，不调模型、不产生副作用，便于单测。
 *  终止条件以“已发言次数”为准（count >= 2 × maxRounds），绝不依赖模型自述。
 *  maxRounds=0 时立即进入 whenDone，作为边界防御。 */
export function routeDebate(
  debate: DebateState | undefined,
  maxRounds: number,
  whenDone: string
): string {
  const rounds = Math.max(0, Math.floor(maxRounds));
  const count = debate?.count ?? 0;
  if (count >= 2 * rounds) return whenDone;
  // 上一位发言者决定下一位：bull 之后是 bear，bear 之后是 bull；尚未发言时从 bull 开始。
  return debate?.currentSpeaker === 'bull' ? 'bear' : 'bull';
}

/** 当前轮次（1-based）：每两次发言为一轮。 */
export function debateRound(count: number): number {
  return Math.floor(Math.max(0, count) / 2) + 1;
}

/** 三方风控路由：按 order 顺序轮转，count >= 3 × maxRounds 时进入 whenDone。
 *  与辩论一致，只读状态、不调模型，终止由计数决定。 */
export function routeRisk(
  risk: RiskDebateState | undefined,
  maxRounds: number,
  order: string[],
  whenDone: string
): string {
  const rounds = Math.max(0, Math.floor(maxRounds));
  const count = risk?.count ?? 0;
  if (count >= 3 * rounds || order.length !== 3) return whenDone;
  return order[count % order.length];
}

/** 风控轮次（1-based）：每三次发言为一轮。 */
export function riskRound(count: number): number {
  return Math.floor(Math.max(0, count) / 3) + 1;
}
