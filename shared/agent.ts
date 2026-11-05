/** 多智能体分析（M25）的跨进程契约。
 *  只放类型与常量，不放运行时实现；主进程与 renderer 共用。 */

export type JsonObject = Record<string, unknown>;

/** 可枚举错误码：IPC 返回与节点失败事件共用。 */
export type AgentErrorCode =
  | 'E_VALIDATION'
  | 'E_GRAPH_NOT_FOUND'
  | 'E_NODE_TYPE_UNKNOWN'
  | 'E_GRAPH_INVALID'
  | 'E_RUN_NOT_FOUND'
  | 'E_RUN_ACTIVE'
  | 'E_RUN_TERMINAL'
  | 'E_CANCELED'
  | 'E_TIMEOUT'
  | 'E_RECURSION_LIMIT'
  | 'E_PROVIDER'
  | 'E_PROVIDER_RATE_LIMIT'
  | 'E_STRUCTURED_OUTPUT'
  | 'E_DB'
  | 'E_PROCESS_RESTART'
  /** P5：重启后恢复审批挂起时，图上已持久化的 spec 摘要与快照不一致。 */
  | 'E_RESUME_STALE_GRAPH'
  /** P7：断点续跑时 run 绑定的 prompt 快照缺失/被篡改，无法安全恢复。 */
  | 'E_RESUME_STALE_PROMPT'
  /** P7：run 处于 interrupted 但没有可用的 checkpoint（例如等待审批的 run）。 */
  | 'E_RESUME_NO_CHECKPOINT'
  | 'E_INTERNAL';

export type AgentIpcResponse<T> =
  | { ok: true; data: T }
  | { ok: false; code: AgentErrorCode; message: string; details?: unknown };

export interface AgentSubject {
  /** 归一化 key，如 topic:china / country:US / event:evt-123 / stock:sh600519 */
  key: string;
  label: string;
  /** stock 为 M26 股票分析独立入口；其余取值保持原智能体语义。 */
  kind: 'topic' | 'country' | 'event' | 'stock';
}

// —— P6：角色 prompt 编辑 ——

/** 可编辑 system prompt 的角色（memory 不调用模型，不在其中）。 */
export const AGENT_PROMPT_ROLES = [
  'evidence',
  'bull',
  'bear',
  'judge',
  'planner',
  'risk_aggressive',
  'risk_conservative',
  'risk_neutral',
  'final'
] as const;

export type AgentPromptRole = (typeof AGENT_PROMPT_ROLES)[number];

/** 单角色 system prompt 文本上限。 */
export const PROMPT_MAX_SYSTEM_CHARS = 800;
/** 渲染变量后的 system prompt 上限（超长会被硬截断）。 */
export const PROMPT_MAX_RENDERED_CHARS = 1200;
/** 唯一允许的占位符；只做一次字符串替换，不做模板求值。 */
export const PROMPT_PLACEHOLDERS = [
  '{{subject.key}}',
  '{{subject.label}}',
  '{{asOf}}',
  '{{round}}',
  '{{memory.lessons}}',
  '{{evidence.summary}}'
] as const;

export interface AgentPromptIssue {
  code: AgentErrorCode;
  message: string;
  role: AgentPromptRole;
  /** 出错位置（0-based 字符偏移），用于 UI 定位。 */
  offset?: number;
}

/** 一次运行绑定的 prompt 版本快照；version 0 = 内置默认。 */
export interface AgentPromptPackSnapshot {
  version: number;
  digest: string;
  /** 仅保存覆盖默认值的角色；缺省角色使用内置模板。 */
  prompts: Partial<Record<AgentPromptRole, string>>;
}

export interface AgentPromptPackView extends AgentPromptPackSnapshot {
  createdAt: string;
  updatedAt: string;
  /** true 表示没有覆盖，全部使用内置模板。 */
  isDefault: boolean;
  defaults: Record<AgentPromptRole, string>;
  limits: { maxSystemChars: number; maxRenderedChars: number };
  placeholders: readonly string[];
}

export interface AgentPromptsGetResponse {
  pack: AgentPromptPackView;
}

export interface AgentPromptsSaveRequest {
  /** 提交所有角色的编辑值；与默认模板相同的项会被归一化为“未覆盖”。 */
  prompts: Partial<Record<AgentPromptRole, string>>;
}

export interface AgentPromptsSaveResponse {
  pack: AgentPromptPackView;
}

export interface RunOptions {
  maxDebateRounds?: number;
  maxRiskRounds?: number;
  maxToolRounds?: number;
  timeoutMs?: number;
  maxCostUsd?: number;
  /** 测试/演示：强制 MockProvider，跳过成本与时长限制 */
  forceMock?: boolean;
}

export interface StartRunRequest {
  graphId: string;
  graphVersion?: number;
  /** P4：编辑器加载时的 spec 摘要；主进程比对当前版本，防止“用旧图跑新改动”。 */
  expectedDigest?: string;
  subject: AgentSubject;
  /** ISO 时间；不得晚于当前时间 */
  asOf: string;
  options?: RunOptions;
}

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface StartRunResponse {
  runId: string;
  threadId: string;
  status: 'running';
  startedAt: string;
  /** P4：本次运行绑定的图版本与 spec 摘要。 */
  graphId: string;
  graphVersion: number;
  graphDigest: string;
}

export interface CancelRunRequest {
  runId: string;
  reason?: 'user' | 'timeout' | 'replaced';
}

export interface CancelRunResponse {
  runId: string;
  status: 'canceled' | 'completed' | 'failed' | 'interrupted';
  alreadyTerminal: boolean;
}

export type ApprovalResolution =
  | { type: 'approve' }
  | { type: 'edit'; patch: JsonObject }
  | { type: 'reject'; reason?: string };

export interface ResumeRunRequest {
  runId: string;
  resolution: ApprovalResolution;
}

export interface ResumeRunResponse {
  runId: string;
  /** reject 会直接进入 canceled；其余先返回 running，随后由事件推进。 */
  status: 'running' | 'completed' | 'failed' | 'canceled';
  resumedAt: string;
}

/** P7：任意断点续跑（不涉及人工审批）。 */
export interface ResumeCheckpointRequest {
  runId: string;
}

export interface ResumeCheckpointResponse {
  runId: string;
  status: 'running';
  resumedAt: string;
  /** 本次恢复起点的已持久化 checkpoint。 */
  fromCheckpointId: string;
}

/** P7：启动恢复元数据；只有完整时才把残留 running run 标为可续跑。 */
export interface AgentRunRecovery {
  v: 1;
  kind: 'checkpoint';
  checkpointId: string;
  checkpointStep: number;
  graphId: string;
  graphVersion: number;
  graphDigest: string;
  promptVersion: number;
  promptDigest: string;
  threadId: string;
  isMock: boolean;
  usage: RunUsage;
  recoveredAt: string;
}

/** 挂起在 final 节点前的审批上下文，供 UI 展示与人工决策。 */
export interface ApprovalContext {
  nodeId: string;
  stage: 'final_approval';
  decision?: FinalDecision;
  proposal?: ObservationPlan;
}

export interface EventsPageRequest {
  runId: string;
  afterSeq?: number;
}

export interface EventsPage {
  runId: string;
  events: RunEventEnvelope[];
  nextSeq: number;
}

export type TrendRating = 'strong_up' | 'up' | 'neutral' | 'down' | 'strong_down' | 'review';

/** 存储层用英文枚举键，UI 展示层映射为中文。 */
export const RATING_LABELS: Record<TrendRating, string> = {
  strong_up: '强升温',
  up: '升温',
  neutral: '平稳',
  down: '降温',
  strong_down: '强降温',
  review: '待复核'
};

export const RATING_VALUES: TrendRating[] = [
  'strong_up',
  'up',
  'neutral',
  'down',
  'strong_down',
  'review'
];

export interface EvidenceSignal {
  claim: string;
  direction: 'up' | 'down' | 'flat';
  strength: 1 | 2 | 3;
  sourceIds: string[];
}

/** 世界趋势维度（原有 4 个）与股票维度（M26 新增 4 个）。 */
export type EvidenceDimension =
  | 'heat'
  | 'sentiment'
  | 'geopolitics'
  | 'structure'
  | 'market'
  | 'fundamentals'
  | 'disclosures'
  | 'news';

export interface EvidenceReport {
  dimension: EvidenceDimension;
  summary: string;
  signals: EvidenceSignal[];
  dataGaps: string[];
  confidence: number;
}

export interface DebateTurn {
  stance: 'bull' | 'bear';
  argument: string;
  rebuttals: Array<{ target: string; point: string }>;
  evidenceRefs: string[];
  confidence: number;
}

/** 单次发言记录：在 DebateTurn 上附加轮次，供 judge 与 UI 消费。 */
export interface DebateEntry extends DebateTurn {
  round: number;
  /** 该发言所在节点尝试的真实开始/结束时间；历史回放由节点结果补齐，不单独存列。 */
  startedAt?: string;
  endedAt?: string;
}

/** 辩论状态整体覆盖（不允许部分更新）。 */
export interface DebateState {
  count: number;
  maxRounds: number;
  currentRound: number;
  currentSpeaker: 'bull' | 'bear' | null;
  entries: DebateEntry[];
}

export interface InvestmentPlan {
  direction: 'up' | 'down' | 'neutral';
  thesis: string;
  drivers: string[];
  invalidation: string[];
  horizonDays: number;
}

/** P2：planner 的可执行观察/预警方案。 */
export interface ObservationPlan {
  action: 'watch' | 'alert' | 'escalate' | 'dismiss';
  summary: string;
  triggers: string[];
  invalidations: string[];
  reviewInDays: number;
}

export type RiskStance = 'aggressive' | 'conservative' | 'neutral';

export interface RiskTurn {
  stance: RiskStance;
  challenge: string;
  mitigations: string[];
  residualRisks: string[];
  confidence: number;
}

export interface RiskEntry extends RiskTurn {
  round: number;
  /** 与 DebateEntry 一致：复用节点尝试的 started_at / ended_at。 */
  startedAt?: string;
  endedAt?: string;
}

/** 三方风控辩论状态，整对象覆盖。 */
export interface RiskDebateState {
  count: number;
  maxRounds: number;
  currentRound: number;
  currentStance: RiskStance | null;
  entries: RiskEntry[];
}

export interface FinalDecision {
  rating: TrendRating;
  confidence: number;
  horizonDays: number;
  thesis: string;
  keyRisks: string[];
  nextCheckAt: string;
  reviewRequired: boolean;
  reviewReason?: string;
  /** M26：股票分析附带的归因分解；世界趋势决策不带该字段。 */
  stock?: import('./stock-agent.js').StockAttribution;
}

// —— 记忆：结算基准、结果、反思 ——

/** 决策时的基准快照；只使用 asOf 及之前的窗口，避免未来数据泄漏。 */
export interface MemoryBaseline {
  capturedAt: string;
  asOf: string;
  windowDays: number;
  articleCount: number;
  /** 1-based；话题不存于实体表时为 null。 */
  hotRank: number | null;
  /** 窗口后半段文章数 - 前半段文章数。 */
  momentum: number;
}

export type MemoryVerdict = 'hit' | 'miss' | 'inconclusive';

/** 结算窗口的实际指标与相对基准的变化。 */
export interface MemoryOutcome {
  windowStart: string;
  windowEnd: string;
  articleCount: number;
  hotRank: number | null;
  momentum: number;
  articleDelta: number;
  /** 正数表示排名上升（名次数字变小）。 */
  hotRankDelta: number | null;
  momentumDelta: number;
  verdict: MemoryVerdict;
  hit: boolean | null;
  reason: string;
  /** M26：股票结算走 T+5 超额收益口径；此时上面的热度字段为 0/null。 */
  stock?: import('./stock-agent.js').StockOutcome;
}

export interface MemoryInjection {
  memoryId: string;
  decisionId: string;
  subjectKey: string;
  asOf: string;
  resolvedAt: string;
  rating: TrendRating;
  reflection: string;
}

export interface MemoryRecord {
  id: string;
  decisionId: string;
  subjectKey: string;
  asOf: string;
  resolvedAt: string;
  rating: TrendRating;
  horizonDays: number;
  outcome: MemoryOutcome;
  reflection: string;
  createdAt: string;
}

export type DecisionStatus = 'pending' | 'settled' | 'insufficient' | 'review';

export interface MemoryDecisionView {
  id: string;
  runId: string;
  subjectKey: string;
  subjectLabel: string;
  asOf: string;
  rating: TrendRating;
  horizonDays: number;
  resolveAfter: string;
  status: DecisionStatus;
  /** 世界趋势用热度基准；股票分析（M26）用 StockBaseline。 */
  baseline?: MemoryBaseline | import('./stock-agent.js').StockBaseline;
  outcome?: MemoryOutcome;
  reflection?: string;
  resolvedAt?: string;
  createdAt: string;
}

export interface MemoryStats {
  pending: number;
  settled: number;
  insufficient: number;
  hits: number;
  misses: number;
  inconclusive: number;
  /** hits / (hits + misses)；无可结算记录时为 0。 */
  hitRate: number;
}

/** 记忆面板作用域：trend 为原智能体口径，stock 为股票口径；缺省返回全量（旧行为）。 */
export interface MemoryListRequest {
  scope?: 'trend' | 'stock';
}

export interface MemoryListResponse {
  pending: MemoryDecisionView[];
  settled: MemoryRecord[];
  insufficient: MemoryDecisionView[];
  stats: MemoryStats;
}

export interface MemorySettleDetail {
  decisionId: string;
  subjectKey: string;
  status: 'settled' | 'insufficient' | 'already_settled' | 'not_due' | 'not_settleable' | 'not_found';
  message: string;
}

export interface MemorySettleResponse {
  now: string;
  scanned: number;
  settled: number;
  insufficient: number;
  skipped: number;
  details: MemorySettleDetail[];
}

export interface RunUsage {
  calls: number;
  promptChars: number;
  completionChars: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
}

/** 节点白名单：P2 扩展 planner / risk×3 / final；P3 增加 memory。 */
export type AgentNodeType =
  | 'memory'
  | 'evidence'
  | 'bull'
  | 'bear'
  | 'judge'
  /** M26：裁决后的数字闸门；只在股票图使用，不影响世界趋势默认图。 */
  | 'fact_check'
  | 'planner'
  | 'risk_aggressive'
  | 'risk_conservative'
  | 'risk_neutral'
  | 'final';

export const AGENT_NODE_TYPES: AgentNodeType[] = [
  'memory',
  'evidence',
  'bull',
  'bear',
  'judge',
  'fact_check',
  'planner',
  'risk_aggressive',
  'risk_conservative',
  'risk_neutral',
  'final'
];

export const RISK_NODE_TYPES: AgentNodeType[] = [
  'risk_aggressive',
  'risk_conservative',
  'risk_neutral'
];

export type NodeConfig =
  | { type: 'memory'; lookbackDays: number; maxLessons: number }
  | {
      type: 'evidence';
      dimension: EvidenceDimension;
      topN: number;
      windowDays: number;
    }
  | { type: 'bull'; maxRounds: number }
  | { type: 'bear'; maxRounds: number }
  | { type: 'judge'; requireDirection: true }
  | { type: 'fact_check'; toleranceBps: number }
  | { type: 'planner'; maxTriggers: number }
  | { type: 'risk_aggressive'; maxRounds: number }
  | { type: 'risk_conservative'; maxRounds: number }
  | { type: 'risk_neutral'; maxRounds: number }
  | { type: 'final'; requireApproval: true };

export interface GraphNodeSpec {
  /** [a-z0-9_-]{1,40}，唯一 */
  id: string;
  type: AgentNodeType;
  label: string;
  position: { x: number; y: number };
  /** 入度 > 1 时的汇合语义，默认 all */
  joinMode?: 'all' | 'any';
  config: NodeConfig;
}

export type NodeRef = string | '__start__' | '__end__';

export type BuiltinCondition =
  | { kind: 'always' }
  | { kind: 'debate_rounds'; maxRounds: number; whenDone: NodeRef }
  | { kind: 'risk_rounds'; maxRounds: number; order: string[]; whenDone: NodeRef };

export interface GraphEdgeSpec {
  id: string;
  source: NodeRef;
  target: NodeRef;
  condition?: BuiltinCondition;
}

/** 人类可读的条件路由标签；无条件边返回 null。 */
export function edgeRouteLabel(edge: GraphEdgeSpec): string | null {
  const cond = edge.condition;
  if (!cond || cond.kind === 'always') return null;
  if (cond.kind === 'debate_rounds') {
    return `辩论：第 ${cond.maxRounds} 轮后 → ${cond.whenDone}，否则 → ${edge.target}`;
  }
  if (cond.kind === 'risk_rounds') {
    return `风控：第 ${cond.maxRounds} 轮后 → ${cond.whenDone}，否则按顺序 → ${edge.target}`;
  }
  return null;
}

export interface RunSettings {
  maxDebateRounds: number;
  maxRiskRounds: number;
  maxToolRounds: number;
  recursionLimit: number;
  nodeTimeoutMs: number;
  runTimeoutMs: number;
  maxCostUsd: number;
  maxNodes: number;
}

export interface GraphSpec {
  specVersion: 1;
  id: string;
  version: number;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  nodes: GraphNodeSpec[];
  edges: GraphEdgeSpec[];
  settings: RunSettings;
}

export interface AgentGraphSummary {
  id: string;
  version: number;
  name: string;
  description?: string;
  updatedAt: string;
}

// —— P4：受约束的图编辑与版本持久化 ——

export type AgentGraphStatus = 'draft' | 'published';

/** 校验错误定位：错误码 + 人类可读原因 + 节点/边 id。 */
export interface GraphSpecIssue {
  code: AgentErrorCode;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface AgentGraphVersionSummary extends AgentGraphSummary {
  status: AgentGraphStatus;
  /** 当前默认运行使用的版本（同一 graph_id 最多一个 active）。 */
  isActive: boolean;
  digest: string;
  createdAt: string;
}

export interface AgentGraphGetRequest {
  graphId: string;
  /** 缺省取 active published 版本。 */
  version?: number;
}

export interface AgentGraphGetResponse {
  spec: GraphSpec;
  status: AgentGraphStatus;
  isActive: boolean;
  digest: string;
}

export interface AgentGraphSaveRequest {
  spec: GraphSpec;
  /** true/publish 缺省：保存为新版本并设为 active；false：只存草稿。 */
  publish?: boolean;
}

export interface AgentGraphSaveResponse {
  graphId: string;
  version: number;
  digest: string;
  status: AgentGraphStatus;
  isActive: boolean;
  spec: GraphSpec;
}

export interface AgentGraphDeleteRequest {
  graphId: string;
  version: number;
}

export interface AgentGraphDeleteResponse {
  graphId: string;
  version: number;
  deleted: true;
  /** 删除 active 版本后是否自动提升了另一个 published 版本。 */
  promotedVersion?: number;
}

// —— 运行事件 ——

export type RunEvent =
  | {
      type: 'run.started';
      graphId: string;
      graphVersion: number;
      subject: AgentSubject;
      asOf: string;
    }
  | { type: 'run.resumed'; resolution: 'approve' | 'edit' | 'reject' | 'checkpoint' }
  | { type: 'node.started'; nodeId: string; nodeType: AgentNodeType; attempt: number }
  | { type: 'node.progress'; nodeId: string; percent?: number; message?: string }
  | { type: 'node.token'; nodeId: string; delta: string; attempt?: number; reset?: boolean }
  | {
      type: 'node.completed';
      nodeId: string;
      outputPreview: string;
      outputRef: string;
      elapsedMs: number;
    }
  | {
      type: 'node.failed';
      nodeId: string;
      code: AgentErrorCode;
      message: string;
      retryable: boolean;
    }
  /** 辩论发言事件：node.completed 之后、route.taken 之前发出。 */
  | {
      type: 'debate.turn';
      nodeId: string;
      round: number;
      speaker: 'bull' | 'bear';
      argument: string;
      rebuttals: Array<{ target: string; point: string }>;
      evidenceRefs: string[];
      confidence: number;
      count: number;
      maxRounds: number;
      /** 与落库的 started_at / ended_at 同源，保证运行中与历史回放显示一致。 */
      startedAt?: string;
      endedAt?: string;
    }
  /** 风控发言事件：node.completed 之后、route.taken 之前发出。 */
  | {
      type: 'risk.turn';
      nodeId: string;
      round: number;
      stance: RiskStance;
      challenge: string;
      mitigations: string[];
      residualRisks: string[];
      confidence: number;
      count: number;
      maxRounds: number;
      startedAt?: string;
      endedAt?: string;
    }
  /** condition 是人类可读标签；edgeId 用于把路由定位到具体边。 */
  | { type: 'route.taken'; from: string; to: string; condition: string; edgeId?: string }
  | {
      type: 'run.interrupted';
      nodeId: string;
      reason: string;
      payload?: JsonObject;
    }
  | {
      type: 'run.completed';
      rating: TrendRating;
      reviewRequired: boolean;
      elapsedMs: number;
      usage: RunUsage;
    }
  | { type: 'run.failed'; code: AgentErrorCode; message: string }
  | { type: 'run.canceled'; reason: 'user' | 'timeout' | 'replaced' | 'rejected' }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export interface RunEventEnvelope {
  v: 1;
  runId: string;
  /** 从 1 开始，同一 run 内严格递增 */
  seq: number;
  ts: string;
  event: RunEvent;
}

/** 主进程 → renderer 的事件推送 channel（invoke 之外唯一需要监听的通道）。 */
export const AGENT_EVENT_CHANNEL = 'agent:event';

// —— 查询视图 ——

export interface AgentRunSummary {
  runId: string;
  graphId: string;
  graphVersion: number;
  /** P4：运行绑定的 spec 摘要；旧 run 可能为空。 */
  graphDigest?: string;
  /** P6：运行绑定的 prompt 版本与摘要；旧 run 为 0/空。 */
  promptVersion?: number;
  promptDigest?: string;
  status: AgentRunStatus;
  subject: AgentSubject;
  asOf: string;
  startedAt: string;
  endedAt?: string;
  rating?: TrendRating;
  reviewRequired: boolean;
  errorCode?: AgentErrorCode;
}

export type NodeResultStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface AgentNodeResultView {
  nodeId: string;
  nodeType: AgentNodeType;
  attempt: number;
  status: NodeResultStatus;
  startedAt?: string;
  endedAt?: string;
  elapsedMs?: number;
  inputSummary?: string;
  output?: JsonObject;
  errorCode?: AgentErrorCode;
  errorMessage?: string;
}

export interface AgentRunDetail extends AgentRunSummary {
  config?: RunOptions;
  state?: JsonObject;
  nodes: AgentNodeResultView[];
  decision?: FinalDecision;
  /** 处于 interrupted 时，挂起审批的上下文；仅审批挂起才存在。 */
  approval?: ApprovalContext;
  /** P7：从 checkpoint 恢复的元数据；仅“等待手动续跑”的 interrupted 才存在。 */
  recovery?: AgentRunRecovery;
  /** P3：本次运行注入的历史教训。 */
  memory?: { context: string; lessons: MemoryInjection[] };
  /** P4：运行当时使用的图名称（从对应版本快照读取，不随当前 active 图变化）。 */
  graphName?: string;
  /** P6：运行当时使用的 prompt 快照，历史回放不随后续编辑变化。 */
  prompt?: AgentPromptPackSnapshot;
}

export interface AgentRunsListRequest {
  limit?: number;
  /** 按图隔离运行列表；缺省返回全部（兼容旧调用）。 */
  graphId?: string;
}
