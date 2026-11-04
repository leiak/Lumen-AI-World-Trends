import {
  MemorySaver,
  START,
  END,
  StateGraph,
  interrupt,
  isGraphInterrupt,
  type BaseCheckpointSaver
} from '@langchain/langgraph';
import { edgeRouteLabel, type ApprovalContext, type ApprovalResolution, type DebateEntry, type DebateState, type GraphNodeSpec, type GraphSpec, type JsonObject, type MemoryInjection, type RiskDebateState, type RiskEntry, type RiskStance } from '../../../shared/agent.js';
import type { AgentNodeDeps } from './nodes.js';
import { nodeImplementations } from './nodes.js';
import { AgentCanceledError, AgentTimeoutError } from './errors.js';
import { debateRound, riskRound, routeDebate, routeRisk } from './routes.js';
import { AgentStateAnnotation, type AgentState, type AgentStateUpdate } from './state.js';

export interface GraphRunHooks {
  onNodeStarted(node: GraphNodeSpec, attempt: number, inputSummary: string): void;
  onNodeCompleted(node: GraphNodeSpec, output: JsonObject, elapsedMs: number, attempt: number): void;
  onNodeFailed(node: GraphNodeSpec, error: unknown, elapsedMs: number, attempt: number): void;
  onDebateTurn(node: GraphNodeSpec, entry: DebateEntry, count: number, maxRounds: number, attempt: number): void;
  onRiskTurn(node: GraphNodeSpec, entry: RiskEntry, count: number, maxRounds: number, attempt: number): void;
  onRouteTaken(from: string, to: string, condition: string, edgeId: string): void;
  checkCanceled(): void;
  /** P5：在节点执行的异步上下文中运行，供 token 流式事件定位到具体节点。 */
  withNodeContext?<T>(node: GraphNodeSpec, attempt: number, fn: () => Promise<T>): Promise<T>;
}

export interface CompiledAgentGraph {
  graph: ReturnType<StateGraph<typeof AgentStateAnnotation>['compile']>;
  checkpointer: BaseCheckpointSaver;
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AgentTimeoutError(`节点执行超过 ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

function primaryOutput(node: GraphNodeSpec, update: AgentStateUpdate): JsonObject {
  if (node.type === 'memory') {
    const lessons = (update.memoryUsed as MemoryInjection[] | undefined) ?? [];
    return {
      context: update.memoryContext ?? '',
      lessons,
      lessonCount: lessons.length
    } as JsonObject;
  }
  if (node.type === 'evidence') {
    const bundle = update.evidenceBundle ?? {};
    const first = Object.values(bundle)[0];
    return (first ?? {}) as JsonObject;
  }
  if (node.type === 'bull') return (update.bullTurn ?? {}) as JsonObject;
  if (node.type === 'bear') return (update.bearTurn ?? {}) as JsonObject;
  if (node.type === 'planner') return (update.proposal ?? {}) as JsonObject;
  if (node.type === 'risk_aggressive' || node.type === 'risk_conservative' || node.type === 'risk_neutral') {
    const risk = update.risk as RiskDebateState | undefined;
    const entry = risk?.entries[risk.entries.length - 1];
    return (entry ?? {}) as JsonObject;
  }
  return (update.decision ?? {}) as JsonObject;
}

const RISK_TYPES = new Set(['risk_aggressive', 'risk_conservative', 'risk_neutral']);

function stanceOf(node: GraphNodeSpec): RiskStance {
  return node.type === 'risk_aggressive'
    ? 'aggressive'
    : node.type === 'risk_conservative'
      ? 'conservative'
      : 'neutral';
}

/** 编译 GraphSpec 为 LangGraph StateGraph：START 扇出、多入边按 joinMode 汇合、终端连 END。
 *  每次运行新建实例（MemorySaver 线程隔离），运行时不 eval 图内任何脚本。 */
export function compileAgentGraph(
  spec: GraphSpec,
  nodeDeps: AgentNodeDeps,
  hooks: GraphRunHooks,
  opts: {
    nodeTimeoutMs: number;
    skipTimeout: boolean;
    /** P5：重启恢复时用 final-only 图，审批结果已由外部注入，不再调用 interrupt。 */
    skipInterrupt?: boolean;
    /** P5：重启恢复时 final 已被中断过一次，新尝试从 attemptBase + 1 开始。 */
    attemptBase?: number;
    /** P7：断点续跑时按节点已有最大 attempt 续号，避免与历史尝试冲突。 */
    attemptBases?: Record<string, number>;
    /** P7：外部注入的 checkpointer（默认 MemorySaver，保持 P5 行为）。 */
    checkpointer?: BaseCheckpointSaver;
  }
): CompiledAgentGraph {
  const builder = new StateGraph(AgentStateAnnotation);
  // attempt：辩论/风控用轮次；其余节点用调用次数（final 在 resume 后为 2）。
  const invocations = new Map<string, number>();
  for (const node of spec.nodes) {
    const impl = nodeImplementations[node.type];
    builder.addNode(node.id, async (state: AgentState) => {
      const startedAt = Date.now();
      const invocationsSoFar = (invocations.get(node.id) ?? 0) + 1;
      invocations.set(node.id, invocationsSoFar);
      const attempt =
        node.type === 'bull' || node.type === 'bear'
          ? debateRound(state.debate?.count ?? 0)
          : RISK_TYPES.has(node.type)
            ? riskRound(state.risk?.count ?? 0)
            : invocationsSoFar + (opts.attemptBases?.[node.id] ?? opts.attemptBase ?? 0);
      const inputSummary = `${node.label} · asOf=${state.asOf} · subject=${state.subject.label}`;
      hooks.checkCanceled();
      hooks.onNodeStarted(node, attempt, inputSummary);
      try {
        // 最终结论前挂起等待人工审批；resume 时 interrupt 返回审批结果。
        // P5 跨进程恢复：新建的 final-only 图没有 checkpoint，审批已注入，跳过 interrupt。
        if (node.type === 'final' && !opts.skipInterrupt) {
          const payload: ApprovalContext = {
            nodeId: node.id,
            stage: 'final_approval',
            decision: state.decision,
            proposal: state.proposal
          };
          const resolution = interrupt<ApprovalContext, ApprovalResolution | undefined>(payload);
          nodeDeps.approval = resolution;
        }
        // 进入真实节点前再查一次取消标记，避免已取消仍发起模型调用。
        hooks.checkCanceled();
        const invokeNode = (): Promise<AgentStateUpdate> => impl(state, node, nodeDeps);
        const result = await withTimeout(
          hooks.withNodeContext ? hooks.withNodeContext(node, attempt, invokeNode) : invokeNode(),
          opts.skipTimeout ? Infinity : opts.nodeTimeoutMs
        );
        hooks.checkCanceled();
        const elapsedMs = Date.now() - startedAt;
        hooks.onNodeCompleted(node, primaryOutput(node, result), elapsedMs, attempt);
        if (node.type === 'bull' || node.type === 'bear') {
          const debate = result.debate as DebateState | undefined;
          const entry = debate?.entries[debate.entries.length - 1];
          if (entry) {
            hooks.onDebateTurn(node, entry, debate!.count, spec.settings.maxDebateRounds, attempt);
          }
        }
        if (RISK_TYPES.has(node.type)) {
          const risk = result.risk as RiskDebateState | undefined;
          const entry = risk?.entries[risk.entries.length - 1];
          if (entry) {
            hooks.onRiskTurn(node, entry, risk!.count, spec.settings.maxRiskRounds, attempt);
          }
        }
        return result;
      } catch (err) {
        // interrupt() 依赖异常冒泡；不能当作节点失败，也不能被包装成取消错误。
        if (isGraphInterrupt(err)) throw err;
        const elapsedMs = Date.now() - startedAt;
        hooks.onNodeFailed(node, err, elapsedMs, attempt);
        throw err instanceof Error ? err : new AgentCanceledError(String(err));
      }
    });
  }

  const nodeIds = new Set(spec.nodes.map((n) => n.id));
  const incoming = new Map<string, string[]>();
  for (const node of spec.nodes) incoming.set(node.id, []);

  // LangGraph 的边类型由 addNode 的 id 字面量联合推导；GraphSpec 是运行时数据，这里用 never 断言收窄。
  for (const edge of spec.edges) {
    if (edge.condition && edge.condition.kind !== 'always') continue;
    if (edge.source === '__start__') {
      builder.addEdge(START, edge.target as never);
      continue;
    }
    if (edge.target === '__end__') {
      builder.addEdge(edge.source as never, END);
      continue;
    }
    if (nodeIds.has(edge.target)) {
      incoming.get(edge.target)!.push(edge.source);
    }
  }

  // 条件边：路由函数只读状态（纯函数），不消耗模型；每次路由都发 route.taken。
  const conditionalSources = new Set<string>();
  for (const edge of spec.edges) {
    const condition = edge.condition;
    if (!condition || condition.kind === 'always') continue;
    if (conditionalSources.has(edge.source)) {
      throw new Error(`节点 ${edge.source} 只允许一条条件边`);
    }
    conditionalSources.add(edge.source);
    const router = (state: AgentState): string => {
      const next =
        condition.kind === 'debate_rounds'
          ? routeDebate(state.debate, condition.maxRounds, condition.whenDone)
          : routeRisk(state.risk, condition.maxRounds, condition.order, condition.whenDone);
      hooks.onRouteTaken(edge.source, next, edgeRouteLabel(edge) ?? `${condition.kind}:${condition.maxRounds}`, edge.id);
      return next;
    };
    const pathMap: Record<string, string> = {
      [edge.target]: edge.target,
      [condition.whenDone]: condition.whenDone
    };
    builder.addConditionalEdges(edge.source as never, router as never, pathMap as never);
  }

  const joinMode = new Map(spec.nodes.map((n) => [n.id, n.joinMode ?? 'all']));
  for (const node of spec.nodes) {
    const sources = incoming.get(node.id) ?? [];
    if (sources.length === 0) continue;
    if (sources.length === 1 || joinMode.get(node.id) === 'any') {
      for (const src of sources) builder.addEdge(src as never, node.id as never);
    } else {
      builder.addEdge(sources as never, node.id as never);
    }
  }

  const checkpointer = opts.checkpointer ?? new MemorySaver();
  const graph = builder.compile({ checkpointer });
  return { graph: graph as CompiledAgentGraph['graph'], checkpointer };
}
