import type { Database } from 'sql.js';
import type {
  AgentNodeType,
  AgentPromptRole,
  ApprovalResolution,
  DebateEntry,
  DebateState,
  EvidenceDimension,
  GraphNodeSpec,
  RiskDebateState,
  RiskEntry,
  RiskStance
} from '../../../shared/agent.js';
import type { ChatMessage } from '../ai/provider.js';
import type { SourceArticle } from '../../../shared/models.js';
import { computeTrends } from '../trends/engine.js';
import { listByHot } from '../graph/repository.js';
import type { AgentState, AgentStateUpdate } from './state.js';
import { loadMemoryContext } from './memory.js';
import {
  buildDebatePrompt,
  buildEvidencePrompt,
  buildFinalPrompt,
  buildJudgePrompt,
  buildPlannerPrompt,
  buildRiskPrompt
} from './prompts.js';
import { debateRound, riskRound } from './routes.js';
import {
  decisionFromText,
  generateStructured,
  mergeDecisionPatch,
  parseDebateTurn,
  parseEvidenceReport,
  parseFinalDecision,
  parseObservationPlan,
  parseRiskTurn,
  planFromDecision,
  reviewDecision
} from './structured.js';

const DAY = 86400000;

export interface AgentNodeDeps {
  db: Database;
  generate: (messages: ChatMessage[]) => Promise<string>;
  checkCanceled: () => void;
  asOf: string;
  /** resume 时由 graph 层写入的人工审批结果；final 节点消费。 */
  approval?: ApprovalResolution;
  /** P6：本次运行绑定的角色 prompt 覆盖；缺省使用内置默认。 */
  prompts?: Partial<Record<AgentPromptRole, string>>;
}

export type NodeImplementation = (
  state: AgentState,
  node: GraphNodeSpec,
  deps: AgentNodeDeps
) => Promise<AgentStateUpdate>;

function evidenceArticles(db: Database, topN: number, asOf: string): SourceArticle[] {
  return listByHot(db, { window: '7d', limit: topN }).filter((a) => a.crawledAt <= asOf);
}

function reportsOf(state: AgentState) {
  return Object.values(state.evidenceBundle ?? {});
}

/** P3：memory 节点只读 agent_memory，按时间正确性过滤（resolved_at/as_of 均不得晚于 asOf）。 */
async function runMemory(
  state: AgentState,
  node: GraphNodeSpec,
  deps: AgentNodeDeps
): Promise<AgentStateUpdate> {
  if (node.config.type !== 'memory') return {};
  deps.checkCanceled();
  const asOf = state.asOf || deps.asOf;
  const { context, lessons } = loadMemoryContext(deps.db, {
    asOf,
    subjectKey: state.subject.key,
    sameLimit: node.config.maxLessons,
    otherLimit: Math.min(3, node.config.maxLessons),
    lookbackDays: node.config.lookbackDays
  });
  return { memoryContext: context, memoryUsed: lessons };
}

async function runEvidence(
  state: AgentState,
  node: GraphNodeSpec,
  deps: AgentNodeDeps
): Promise<AgentStateUpdate> {
  if (node.config.type !== 'evidence') return {};
  const cfg = node.config;
  const dimension: EvidenceDimension = cfg.dimension;
  deps.checkCanceled();
  const asOf = state.asOf || deps.asOf;
  const trends = computeTrends(deps.db, {
    now: asOf,
    topN: cfg.topN,
    horizonMs: cfg.windowDays * DAY
  });
  const articles = evidenceArticles(deps.db, cfg.topN, asOf);
  const messages = buildEvidencePrompt(
    { ...node, config: { type: 'evidence', dimension, topN: cfg.topN, windowDays: cfg.windowDays } },
    state.subject,
    asOf,
    trends,
    articles,
    state.memoryContext,
    deps.prompts?.evidence
  );
  const { value, raw } = await generateStructured(
    deps.generate,
    messages,
    (text) => parseEvidenceReport(text, dimension),
    '上一次输出不是合法 JSON 或字段不合规。请只输出符合 schema 的单个 JSON 对象。'
  );
  const report = value ?? {
    dimension,
    summary: raw.trim().slice(0, 300) || '取证结构化输出失败',
    signals: [],
    dataGaps: ['structured output failed'],
    confidence: 0
  };
  return { evidenceBundle: { [dimension]: report } };
}

async function runDebate(
  state: AgentState,
  node: GraphNodeSpec,
  stance: 'bull' | 'bear',
  deps: AgentNodeDeps
): Promise<AgentStateUpdate> {
  deps.checkCanceled();
  const maxRounds =
    node.config.type === 'bull' || node.config.type === 'bear' ? node.config.maxRounds : 1;
  const debate: DebateState = state.debate ?? {
    count: 0,
    maxRounds,
    currentRound: 1,
    currentSpeaker: null,
    entries: []
  };
  const round = debateRound(debate.count);
  const opponentLatest = [...debate.entries].reverse().find((e) => e.stance !== stance);
  const messages = buildDebatePrompt(
    stance,
    state.subject,
    state.asOf,
    reportsOf(state),
    debate,
    opponentLatest,
    round,
    maxRounds,
    deps.prompts?.[stance]
  );
  const { value, raw } = await generateStructured(
    deps.generate,
    messages,
    (text) => parseDebateTurn(text, stance),
    '上一次输出不是合法 JSON 或字段不合规。请只输出符合 schema 的单个 JSON 对象。'
  );
  const turn = value ?? {
    stance,
    argument: raw.trim().slice(0, 250) || (stance === 'bull' ? '多头论据生成失败' : '空头论据生成失败'),
    rebuttals: [],
    evidenceRefs: [],
    confidence: 0
  };
  const entry: DebateEntry = { ...turn, round };
  const nextDebate: DebateState = {
    count: debate.count + 1,
    maxRounds,
    currentRound: round,
    currentSpeaker: stance,
    entries: [...debate.entries, entry]
  };
  return stance === 'bull'
    ? { debate: nextDebate, bullTurn: turn }
    : { debate: nextDebate, bearTurn: turn };
}

async function runJudge(state: AgentState, deps: AgentNodeDeps): Promise<AgentStateUpdate> {
  deps.checkCanceled();
  const messages = buildJudgePrompt(
    state.subject,
    state.asOf,
    reportsOf(state),
    state.debate?.entries ?? [],
    state.memoryContext,
    deps.prompts?.judge
  );
  const { value, raw } = await generateStructured(
    deps.generate,
    messages,
    parseFinalDecision,
    '上一次输出不是合法 JSON 或评级不在枚举内。请只输出符合 schema 的单个 JSON 对象；无法判断时 rating 用 review。'
  );
  const decision =
    value ?? decisionFromText(raw, 7) ?? reviewDecision(7, new Date(), 'structured_output_failed');
  return { decision, plan: planFromDecision(decision) };
}

function riskStanceOf(type: AgentNodeType): RiskStance | null {
  if (type === 'risk_aggressive') return 'aggressive';
  if (type === 'risk_conservative') return 'conservative';
  if (type === 'risk_neutral') return 'neutral';
  return null;
}

async function runRisk(
  state: AgentState,
  node: GraphNodeSpec,
  stance: RiskStance,
  deps: AgentNodeDeps
): Promise<AgentStateUpdate> {
  deps.checkCanceled();
  const maxRounds = (node.config as { maxRounds?: number }).maxRounds ?? 1;
  const risk: RiskDebateState = state.risk ?? {
    count: 0,
    maxRounds,
    currentRound: 1,
    currentStance: null,
    entries: []
  };
  const round = riskRound(risk.count);
  const others: RiskStance[] = (['aggressive', 'conservative', 'neutral'] as RiskStance[]).filter(
    (s) => s !== stance
  );
  const latestOthers: RiskEntry[] = others
    .map((s) => [...risk.entries].reverse().find((e) => e.stance === s))
    .filter((e): e is RiskEntry => Boolean(e));
  const messages = buildRiskPrompt(
    stance,
    state.subject,
    state.asOf,
    state.decision,
    state.proposal,
    state.debate?.entries ?? [],
    risk,
    latestOthers,
    round,
    maxRounds,
    deps.prompts?.[
      stance === 'aggressive' ? 'risk_aggressive' : stance === 'conservative' ? 'risk_conservative' : 'risk_neutral'
    ]
  );
  const { value, raw } = await generateStructured(
    deps.generate,
    messages,
    (text) => parseRiskTurn(text, stance),
    '上一次输出不是合法 JSON 或字段不合规。请只输出符合 schema 的单个 JSON 对象。'
  );
  const turn = value ?? {
    stance,
    challenge: raw.trim().slice(0, 250) || `${stance} 风控发言生成失败`,
    mitigations: [],
    residualRisks: [],
    confidence: 0
  };
  const entry: RiskEntry = { ...turn, round };
  return {
    risk: {
      count: risk.count + 1,
      maxRounds,
      currentRound: round,
      currentStance: stance,
      entries: [...risk.entries, entry]
    }
  };
}

async function runPlanner(
  state: AgentState,
  node: GraphNodeSpec,
  deps: AgentNodeDeps
): Promise<AgentStateUpdate> {
  deps.checkCanceled();
  const maxTriggers = (node.config as { maxTriggers?: number }).maxTriggers ?? 4;
  const base = state.decision ?? reviewDecision(7, new Date(), 'judge_missing');
  const messages = buildPlannerPrompt(
    state.subject,
    state.asOf,
    state.decision,
    state.debate?.entries ?? [],
    state.risk?.entries ?? [],
    maxTriggers,
    deps.prompts?.planner
  );
  const { value, raw } = await generateStructured(
    deps.generate,
    messages,
    parseObservationPlan,
    '上一次输出不是合法 JSON 或字段不合规。请只输出符合 schema 的单个 JSON 对象。'
  );
  const proposal = value ?? {
    action: base.reviewRequired ? ('alert' as const) : ('watch' as const),
    summary: raw.trim().slice(0, 300) || '观察方案结构化输出失败',
    triggers: [],
    invalidations: base.keyRisks,
    reviewInDays: Math.min(30, Math.max(1, base.horizonDays))
  };
  return { proposal };
}

async function runFinal(state: AgentState, deps: AgentNodeDeps): Promise<AgentStateUpdate> {
  deps.checkCanceled();
  const base = state.decision ?? reviewDecision(7, new Date(), 'judge_missing');
  // 人工修改优先：直接以裁决结论为底稿应用补丁，不再调用模型。
  if (deps.approval?.type === 'edit') {
    const merged = mergeDecisionPatch(base, deps.approval.patch);
    return {
      decision:
        merged ?? reviewDecision(base.horizonDays, new Date(), 'approval_edit_invalid')
    };
  }
  // 裁决已判定需要人工复核时，final 不得把 review 洗成方向性评级。
  if (base.rating === 'review') {
    return {
      decision: reviewDecision(
        base.horizonDays,
        new Date(),
        base.reviewReason ?? 'judge_review'
      )
    };
  }
  const messages = buildFinalPrompt(
    state.subject,
    state.asOf,
    state.decision,
    state.proposal,
    state.debate?.entries ?? [],
    state.risk?.entries ?? [],
    state.memoryContext,
    deps.prompts?.final
  );
  const { value, raw } = await generateStructured(
    deps.generate,
    messages,
    parseFinalDecision,
    '上一次输出不是合法 JSON 或评级不在枚举内。请只输出符合 schema 的单个 JSON 对象；无法判断时 rating 用 review。'
  );
  const decision =
    value ?? decisionFromText(raw, base.horizonDays) ?? reviewDecision(base.horizonDays, new Date(), 'structured_output_failed');
  return { decision };
}

export const nodeImplementations: Record<AgentNodeType, NodeImplementation> = {
  memory: runMemory,
  evidence: runEvidence,
  bull: (state, node, deps) => runDebate(state, node, 'bull', deps),
  bear: (state, node, deps) => runDebate(state, node, 'bear', deps),
  judge: (state, _node, deps) => runJudge(state, deps),
  planner: (state, node, deps) => runPlanner(state, node, deps),
  risk_aggressive: (state, node, deps) => {
    const stance = riskStanceOf(node.type);
    return stance ? runRisk(state, node, stance, deps) : Promise.resolve({});
  },
  risk_conservative: (state, node, deps) => {
    const stance = riskStanceOf(node.type);
    return stance ? runRisk(state, node, stance, deps) : Promise.resolve({});
  },
  risk_neutral: (state, node, deps) => {
    const stance = riskStanceOf(node.type);
    return stance ? runRisk(state, node, stance, deps) : Promise.resolve({});
  },
  final: (state, _node, deps) => runFinal(state, deps)
};
