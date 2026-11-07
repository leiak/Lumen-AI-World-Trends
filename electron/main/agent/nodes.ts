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
import { computeLayerStatus, listStockFacts } from '../stocks/facts.js';
import { STOCK_DEFAULT_BENCHMARK, STOCK_LAYER_LABELS } from '../../../shared/stock-agent.js';
import type { StockFact, StockFactLayer } from '../../../shared/stock-agent.js';
import { checkDecisionNumbers } from './fact-check.js';
import type { AgentState, AgentStateUpdate } from './state.js';
import { loadMemoryContext } from './memory.js';
import {
  buildDebatePrompt,
  buildEvidencePrompt,
  buildFinalPrompt,
  buildJudgePrompt,
  buildPlannerPrompt,
  buildRiskPrompt,
  buildStockJudgePrompt
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
  parseStockDecision,
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
  /** 本 run 的图命名空间；无 override 时默认人设按作用域取模板。 */
  graphId?: string;
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

const STOCK_DIMENSIONS = new Set<StockFactLayer>(['market', 'fundamentals', 'disclosures', 'news']);

function stockSymbolOf(subjectKey: string): string {
  return subjectKey.includes(':') ? subjectKey.slice(subjectKey.indexOf(':') + 1) : subjectKey;
}

function fmtValue(f: StockFact): string {
  if (typeof f.value === 'number') return `${f.value}${f.unit ?? ''}`;
  return f.valueText ?? '';
}

/** M26：股票取证是确定性的，只读 stock_fact（严格 asOf 截断），不调用模型。
 *  缺失维度必须写成 dataGaps，不能把缺失当成“没有发生”。 */
function runStockEvidence(
  state: AgentState,
  node: GraphNodeSpec,
  deps: AgentNodeDeps
): AgentStateUpdate {
  if (node.config.type !== 'evidence') return {};
  const dimension = node.config.dimension as StockFactLayer;
  if (!STOCK_DIMENSIONS.has(dimension)) return {};
  deps.checkCanceled();
  const asOf = state.asOf || deps.asOf;
  const symbol = stockSymbolOf(state.subject.key);
  const facts = listStockFacts(deps.db, symbol, asOf);
  const status = computeLayerStatus(facts).find((s) => s.layer === dimension);
  const layerFacts = facts.filter((f) => f.layer === dimension);

  if (layerFacts.length === 0) {
    const gaps = status?.gaps ?? [`${STOCK_LAYER_LABELS[dimension]}维度缺失`];
    return {
      evidenceBundle: {
        [dimension]: {
          dimension,
          summary: `该维度缺失：${STOCK_LAYER_LABELS[dimension]}（本地事实表中没有 ${symbol} 在 asOf 之前的数据）`,
          signals: [],
          dataGaps: gaps,
          confidence: 0
        }
      }
    };
  }

  const signals: Array<{
    claim: string;
    direction: 'up' | 'down' | 'flat';
    strength: 1 | 2 | 3;
    sourceIds: string[];
  }> = [];
  let summary = '';
  let direction: 'up' | 'down' | 'flat' = 'flat';
  let confidence = 0.5;

  if (dimension === 'market') {
    const last = layerFacts[layerFacts.length - 1];
    const prev = layerFacts.length > 1 ? layerFacts[layerFacts.length - 2] : null;
    if (prev && typeof last.value === 'number' && typeof prev.value === 'number') {
      direction = last.value > prev.value ? 'up' : last.value < prev.value ? 'down' : 'flat';
    }
    summary = `最新收盘价 ${fmtValue(last)} [fact:${last.factId}]；样本覆盖${layerFacts.length >= 2 ? '完整' : '不足'}；相对基准 ${STOCK_DEFAULT_BENCHMARK} 的超额收益由结算层按 T+5 交易日计算。`;
    signals.push({
      claim: `最近收盘价 ${fmtValue(last)}（${prev ? '较前一交易日' : '首条样本'}）`,
      direction,
      strength: 2,
      sourceIds: [last.factId]
    });
    confidence = layerFacts.length >= 2 ? 0.7 : 0.4;
  } else if (dimension === 'fundamentals') {
    const latest = new Map<string, StockFact>();
    for (const f of layerFacts) latest.set(f.metric, f);
    const parts: string[] = [];
    for (const f of latest.values()) parts.push(`${f.metric} ${fmtValue(f)} [fact:${f.factId}]`);
    const profit = latest.get('net_profit_yoy');
    const rev = latest.get('revenue_yoy');
    const pv = typeof profit?.value === 'number' ? profit.value : null;
    const rv = typeof rev?.value === 'number' ? rev.value : null;
    direction = (pv ?? rv ?? 0) > 0 ? 'up' : (pv ?? rv ?? 0) < 0 ? 'down' : 'flat';
    summary = `本地财报表述：${parts.join('；')}；报告期 ${[...latest.values()][0]?.period ?? '未知'}。`;
    for (const f of latest.values()) {
      signals.push({
        claim: `${f.metric} ${fmtValue(f)}`,
        direction: typeof f.value === 'number' ? (f.value > 0 ? 'up' : f.value < 0 ? 'down' : 'flat') : 'flat',
        strength: 3,
        sourceIds: [f.factId]
      });
    }
    confidence = 0.75;
  } else if (dimension === 'disclosures') {
    const texts = layerFacts.map((f) => f.valueText ?? f.metric).filter(Boolean);
    summary = `公告/披露样本：${texts.join('；')}（来源 ${layerFacts[0].source}）。`;
    for (const f of layerFacts) {
      signals.push({
        claim: f.valueText ?? f.metric,
        direction: 'flat',
        strength: 2,
        sourceIds: [f.factId]
      });
    }
    confidence = 0.65;
  } else {
    const latest = new Map<string, StockFact>();
    for (const f of layerFacts) latest.set(f.metric, f);
    const parts = [...latest.values()].map((f) => `${f.metric} ${fmtValue(f)} [fact:${f.factId}]`);
    const sentiment = latest.get('sentiment_score');
    const sv = typeof sentiment?.value === 'number' ? sentiment.value : null;
    direction = sv === null ? 'flat' : sv > 0.1 ? 'up' : sv < -0.1 ? 'down' : 'flat';
    summary = `本地舆情表述：${parts.join('；')}。`;
    for (const f of latest.values()) {
      signals.push({
        claim: `${f.metric} ${fmtValue(f)}`,
        direction,
        strength: 2,
        sourceIds: [f.factId]
      });
    }
    confidence = 0.6;
  }

  return {
    evidenceBundle: {
      [dimension]: {
        dimension,
        summary,
        signals,
        dataGaps: status?.gaps ?? [],
        confidence
      }
    }
  };
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
  // M26：股票维度走确定性取证，不调用模型，也不影响世界趋势（heat/sentiment/...）。
  if (STOCK_DIMENSIONS.has(dimension as StockFactLayer)) {
    return runStockEvidence(state, node, deps);
  }
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
    deps.prompts?.evidence,
    deps.graphId
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
    deps.prompts?.[stance],
    deps.graphId
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
  if (state.subject.kind === 'stock') {
    const messages = buildStockJudgePrompt(
      state.subject,
      state.asOf,
      reportsOf(state),
      state.debate?.entries ?? [],
      state.memoryContext,
      deps.prompts?.judge,
      deps.graphId
    );
    const { value } = await generateStructured(
      deps.generate,
      messages,
      parseStockDecision,
      '上一次输出不是合法 JSON、评级不在枚举内或 stock 归因不合法。请只输出符合 schema 的单个 JSON 对象；无法判断时 rating 用 review。'
    );
    const parsed = value ?? reviewDecision(5, new Date(), 'structured_output_failed');
    // 缺失维度必须显式降级：有维度缺失时不得给出方向性评级（设计 §4.6 / §10 验收）。
    const decision =
      parsed.rating !== 'review' && (parsed.stock?.missingLayers.length ?? 0) > 0
        ? {
            ...parsed,
            rating: 'review' as const,
            reviewRequired: true,
            reviewReason: 'missing_dimension'
          }
        : parsed;
    return { decision, plan: planFromDecision(decision) };
  }
  const messages = buildJudgePrompt(
    state.subject,
    state.asOf,
    reportsOf(state),
    state.debate?.entries ?? [],
    state.memoryContext,
    deps.prompts?.judge,
    deps.graphId
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
    ],
    deps.graphId
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
    deps.prompts?.planner,
    deps.graphId
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
      decision: state.subject.kind === 'stock'
        ? { ...base, rating: 'review', reviewRequired: true, reviewReason: base.reviewReason ?? 'judge_review' }
        : reviewDecision(base.horizonDays, new Date(), base.reviewReason ?? 'judge_review')
    };
  }
  // M26：股票结论已经过数字闸门，final 只签署，不再让模型改写数字。
  if (state.subject.kind === 'stock') {
    return { decision: base };
  }
  const messages = buildFinalPrompt(
    state.subject,
    state.asOf,
    state.decision,
    state.proposal,
    state.debate?.entries ?? [],
    state.risk?.entries ?? [],
    state.memoryContext,
    deps.prompts?.final,
    deps.graphId
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

/** M26：数字闸门。裁决叙事中无法在本地事实表匹配的数字，强制 review。 */
async function runFactCheck(
  state: AgentState,
  node: GraphNodeSpec,
  deps: AgentNodeDeps
): Promise<AgentStateUpdate> {
  if (node.config.type !== 'fact_check') return {};
  deps.checkCanceled();
  const toleranceBps = node.config.toleranceBps;
  const decision = state.decision;
  if (!decision) {
    return {
      factCheck: {
        ok: false,
        checkedNumbers: [],
        unverifiedNumbers: [],
        referencedFactIds: [],
        toleranceBps,
        reason: '裁决缺失，无法核查'
      }
    };
  }
  const facts = listStockFacts(deps.db, stockSymbolOf(state.subject.key), state.asOf || deps.asOf);
  // 即使裁决已因缺失维度要求复核，数字闸门仍要独立跑一次：
  // 编造数字必须优先标记为 unverified_number（P0 硬要求）。
  const result = checkDecisionNumbers(decision, facts, toleranceBps);
  if (result.unverifiedNumbers.length === 0) return { factCheck: result };
  const gated = {
    ...decision,
    rating: 'review' as const,
    reviewRequired: true,
    reviewReason: 'unverified_number'
  };
  return { factCheck: result, decision: gated, plan: planFromDecision(gated) };
}

export const nodeImplementations: Record<AgentNodeType, NodeImplementation> = {
  memory: runMemory,
  evidence: runEvidence,
  bull: (state, node, deps) => runDebate(state, node, 'bull', deps),
  bear: (state, node, deps) => runDebate(state, node, 'bear', deps),
  judge: (state, _node, deps) => runJudge(state, deps),
  fact_check: (state, node, deps) => runFactCheck(state, node, deps),
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
