import { Annotation } from '@langchain/langgraph';
import type {
  AgentSubject,
  DebateState,
  DebateTurn,
  EvidenceReport,
  FinalDecision,
  InvestmentPlan,
  MemoryInjection,
  ObservationPlan,
  RiskDebateState,
  RunUsage
} from '../../../shared/agent.js';
import type { StockFactCheckResult } from '../../../shared/stock-agent.js';

export interface AgentEvidenceBundle {
  [dimension: string]: EvidenceReport;
}

/** 并行节点只写自己的 key：evidenceBundle 顶层合并，bullTurn/bearTurn 分开，避免写冲突。
 *  注意 channel 名不能与 graph 节点 id 重名（LangGraph 会报错），故用 evidenceBundle 而非 evidence。 */
export const AgentStateAnnotation = Annotation.Root({
  runId: Annotation<string>({ reducer: (_prev, next) => next, default: () => '' }),
  asOf: Annotation<string>({ reducer: (_prev, next) => next, default: () => '' }),
  subject: Annotation<AgentSubject>({
    reducer: (_prev, next) => next,
    default: () => ({ key: '', label: '', kind: 'topic' })
  }),
  evidenceBundle: Annotation<AgentEvidenceBundle>({
    reducer: (prev, next) => ({ ...prev, ...next }),
    default: () => ({})
  }),
  /** P3：memory 节点产出的历史教训文本，供后续 prompt 消费。 */
  memoryContext: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => ''
  }),
  memoryUsed: Annotation<MemoryInjection[]>({
    reducer: (_prev, next) => next,
    default: () => []
  }),
  /** 辩论整体状态：每轮整对象覆盖，避免 LangGraph 只做浅合并导致历史丢失。 */
  debate: Annotation<DebateState>({
    reducer: (_prev, next) => next,
    default: () => ({ count: 0, maxRounds: 0, currentRound: 1, currentSpeaker: null, entries: [] })
  }),
  bullTurn: Annotation<DebateTurn | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined
  }),
  bearTurn: Annotation<DebateTurn | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined
  }),
  plan: Annotation<InvestmentPlan | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined
  }),
  /** 三方风控整体状态：整对象覆盖，保证历史完整。 */
  risk: Annotation<RiskDebateState>({
    reducer: (_prev, next) => next,
    default: () => ({ count: 0, maxRounds: 0, currentRound: 1, currentStance: null, entries: [] })
  }),
  proposal: Annotation<ObservationPlan | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined
  }),
  decision: Annotation<FinalDecision | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined
  }),
  /** M26：裁决后的数字闸门结果；只在股票图使用。 */
  factCheck: Annotation<StockFactCheckResult | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined
  }),
  usage: Annotation<RunUsage>({
    reducer: (_prev, next) => next,
    default: () => ({ calls: 0, promptChars: 0, completionChars: 0 })
  })
});

export type AgentState = typeof AgentStateAnnotation.State;
export type AgentStateUpdate = typeof AgentStateAnnotation.Update;
