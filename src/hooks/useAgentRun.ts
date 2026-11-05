import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type {
  AgentGraphGetResponse,
  AgentGraphStatus,
  AgentIpcResponse,
  AgentRunDetail,
  AgentRunRecovery,
  AgentRunStatus,
  AgentRunSummary,
  ApprovalContext,
  ApprovalResolution,
  CancelRunResponse,
  DebateEntry,
  DebateState,
  EventsPage,
  FinalDecision,
  GraphSpec,
  JsonObject,
  MemoryInjection,
  ResumeCheckpointResponse,
  ResumeRunResponse,
  RiskDebateState,
  RiskEntry,
  RunEventEnvelope,
  RunUsage,
  StartRunRequest,
  StartRunResponse,
  TrendRating
} from '../../shared/agent';

export type FlowNodeState = 'pending' | 'running' | 'done' | 'error';

export interface NodeRuntimeView {
  status: FlowNodeState;
  preview?: string;
  output?: JsonObject;
  elapsedMs?: number;
  error?: string;
}

export interface AgentRunViewState {
  runId?: string;
  status: AgentRunStatus | 'idle';
  seq: number;
  nodes: Record<string, NodeRuntimeView>;
  /** P5：运行中节点的增量文本（按 nodeId 累积）。 */
  streams: Record<string, string>;
  decision?: FinalDecision;
  rating?: TrendRating;
  reviewRequired: boolean;
  usage?: RunUsage;
  debate: DebateState;
  risk: RiskDebateState;
  approval?: ApprovalContext;
  /** P7：可断点续跑的元数据；与 approval 互斥。 */
  recovery?: AgentRunRecovery;
  /** P3：本次运行注入的历史教训。 */
  memory?: { context: string; lessons: MemoryInjection[] };
  /** P6：最近一次条件路由，edgeId 可定位到画布上的具体边。 */
  lastRoute?: { from: string; to: string; condition: string; edgeId?: string };
  /** P6：运行绑定的 prompt 版本快照。 */
  prompt?: import('../../shared/agent').AgentPromptPackSnapshot;
  error?: string;
}

function emptyDebate(maxRounds = 0): DebateState {
  return { count: 0, maxRounds, currentRound: 1, currentSpeaker: null, entries: [] };
}

function emptyRisk(maxRounds = 0): RiskDebateState {
  return { count: 0, maxRounds, currentRound: 1, currentStance: null, entries: [] };
}

function asRisk(value: unknown): RiskDebateState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Partial<RiskDebateState>;
  if (!Array.isArray(r.entries)) return undefined;
  return {
    count: typeof r.count === 'number' ? r.count : r.entries.length,
    maxRounds: typeof r.maxRounds === 'number' ? r.maxRounds : 0,
    currentRound: typeof r.currentRound === 'number' ? r.currentRound : 1,
    currentStance:
      r.currentStance === 'aggressive' ||
      r.currentStance === 'conservative' ||
      r.currentStance === 'neutral'
        ? r.currentStance
        : null,
    entries: r.entries as RiskEntry[]
  };
}

function asDebate(value: unknown): DebateState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const d = value as Partial<DebateState>;
  if (!Array.isArray(d.entries)) return undefined;
  return {
    count: typeof d.count === 'number' ? d.count : d.entries.length,
    maxRounds: typeof d.maxRounds === 'number' ? d.maxRounds : 0,
    currentRound: typeof d.currentRound === 'number' ? d.currentRound : 1,
    currentSpeaker:
      d.currentSpeaker === 'bull' || d.currentSpeaker === 'bear' ? d.currentSpeaker : null,
    entries: d.entries as DebateEntry[]
  };
}

type Action =
  | { type: 'reset'; runId: string }
  | { type: 'event'; env: RunEventEnvelope }
  | { type: 'batch'; events: RunEventEnvelope[] }
  | { type: 'hydrate'; detail: AgentRunDetail }
  | { type: 'resumed' }
  | { type: 'notice'; message: string }
  | { type: 'error'; message: string };

const IDLE: AgentRunViewState = {
  status: 'idle',
  seq: 0,
  nodes: {},
  streams: {},
  reviewRequired: false,
  debate: emptyDebate(),
  risk: emptyRisk()
};

async function invokeAgent<T>(channel: string, payload?: unknown): Promise<AgentIpcResponse<T>> {
  try {
    return (await window.lumen.invoke(channel, payload)) as AgentIpcResponse<T>;
  } catch (err) {
    return {
      ok: false,
      code: 'E_INTERNAL',
      message: err instanceof Error ? err.message : String(err)
    };
  }
}

function applyEvent(state: AgentRunViewState, env: RunEventEnvelope): AgentRunViewState {
  if (state.runId && env.runId !== state.runId) return state;
  if (env.seq <= state.seq) return state;
  const event = env.event;
  const nodes = { ...state.nodes };
  const streams = { ...state.streams };
  let status = state.status;
  let rating = state.rating;
  let reviewRequired = state.reviewRequired;
  let usage = state.usage;
  let debate = state.debate;
  let risk = state.risk;
  let approval = state.approval;
  let recovery = state.recovery;
  let lastRoute = state.lastRoute;
  let error = state.error;

  switch (event.type) {
    case 'node.started':
      nodes[event.nodeId] = { ...nodes[event.nodeId], status: 'running' };
      streams[event.nodeId] = '';
      break;
    case 'node.token':
      // token 是过程态：按 nodeId 累积；reset 表示同一节点开始新一次生成尝试。
      streams[event.nodeId] = event.reset ? event.delta : `${streams[event.nodeId] ?? ''}${event.delta}`;
      break;
    case 'node.completed':
      nodes[event.nodeId] = {
        status: 'done',
        preview: event.outputPreview,
        elapsedMs: event.elapsedMs
      };
      delete streams[event.nodeId];
      break;
    case 'node.failed':
      nodes[event.nodeId] = {
        ...nodes[event.nodeId],
        status: 'error',
        error: `${event.code}: ${event.message}`
      };
      delete streams[event.nodeId];
      break;
    case 'run.completed':
      status = 'completed';
      rating = event.rating;
      reviewRequired = event.reviewRequired;
      usage = event.usage;
      break;
    case 'run.failed':
      status = 'failed';
      error = `${event.code}: ${event.message}`;
      for (const id of Object.keys(nodes)) {
        if (nodes[id].status === 'running') nodes[id] = { ...nodes[id], status: 'error', error: event.message };
      }
      break;
    case 'run.canceled':
      status = 'canceled';
      for (const id of Object.keys(nodes)) {
        if (nodes[id].status === 'running') nodes[id] = { ...nodes[id], status: 'error', error: '已取消' };
      }
      break;
    case 'debate.turn': {
      const entry: DebateEntry = {
        round: event.round,
        stance: event.speaker,
        argument: event.argument,
        rebuttals: event.rebuttals,
        evidenceRefs: event.evidenceRefs,
        confidence: event.confidence,
        ...(event.startedAt ? { startedAt: event.startedAt } : {}),
        ...(event.endedAt ? { endedAt: event.endedAt } : {})
      };
      // afterSeq 补拉或重放时按“轮次 + 立场”去重，避免历史重复。
      const entries = state.debate.entries.filter(
        (e) => !(e.round === entry.round && e.stance === entry.stance)
      );
      entries.push(entry);
      debate = {
        count: event.count,
        maxRounds: event.maxRounds,
        currentRound: event.round,
        currentSpeaker: event.speaker,
        entries
      };
      break;
    }
    case 'risk.turn': {
      const entry: RiskEntry = {
        round: event.round,
        stance: event.stance,
        challenge: event.challenge,
        mitigations: event.mitigations,
        residualRisks: event.residualRisks,
        confidence: event.confidence,
        ...(event.startedAt ? { startedAt: event.startedAt } : {}),
        ...(event.endedAt ? { endedAt: event.endedAt } : {})
      };
      const entries = state.risk.entries.filter(
        (e) => !(e.round === entry.round && e.stance === entry.stance)
      );
      entries.push(entry);
      risk = {
        count: event.count,
        maxRounds: event.maxRounds,
        currentRound: event.round,
        currentStance: event.stance,
        entries
      };
      break;
    }
    case 'run.interrupted':
      status = 'interrupted';
      // 挂起的 final 节点回到 pending，等待人工审批；不标记为错误。
      for (const id of Object.keys(nodes)) {
        if (nodes[id].status === 'running') nodes[id] = { ...nodes[id], status: 'pending' };
      }
      approval = (event.payload as unknown as ApprovalContext) ?? state.approval;
      break;
    case 'run.resumed':
      status = 'running';
      approval = undefined;
      recovery = undefined;
      break;
    case 'route.taken':
      lastRoute = { from: event.from, to: event.to, condition: event.condition, edgeId: event.edgeId };
      break;
    case 'run.started':
      status = 'running';
      break;
    default:
      break;
  }
  return {
    ...state,
    runId: env.runId,
    seq: env.seq,
    status,
    nodes,
    streams,
    rating,
    reviewRequired,
    usage,
    debate,
    risk,
    approval,
    recovery,
    lastRoute,
    error
  };
}

function reducer(state: AgentRunViewState, action: Action): AgentRunViewState {
  switch (action.type) {
    case 'reset':
      return { ...IDLE, runId: action.runId, status: 'running' };
    case 'event':
      return applyEvent(state, action.env);
    case 'batch':
      return action.events.reduce((acc, env) => applyEvent(acc, env), state);
    case 'hydrate': {
      const detail = action.detail;
      // 选择历史 run 或终态刷新时以落盘数据为准，避免残留上一次运行的节点与辩论。
      const nodes: Record<string, NodeRuntimeView> = {};
      for (const node of detail.nodes) {
        if (node.status === 'pending') continue;
        nodes[node.nodeId] = {
          status:
            node.status === 'succeeded'
              ? 'done'
              : node.status === 'running'
                ? 'running'
                : node.status === 'failed'
                  ? 'error'
                  : 'pending',
          preview: node.output ? JSON.stringify(node.output, null, 2).slice(0, 2000) : undefined,
          output: node.output,
          elapsedMs: node.elapsedMs,
          error: node.errorMessage ? `${node.errorCode ?? 'E_INTERNAL'}: ${node.errorMessage}` : undefined
        };
      }
      return {
        ...state,
        runId: detail.runId,
        status: detail.status,
        rating: detail.rating,
        reviewRequired: detail.reviewRequired,
        decision: detail.decision,
        nodes,
        streams: {},
        debate: asDebate(detail.state?.debate) ?? emptyDebate(),
        risk: asRisk(detail.state?.risk) ?? emptyRisk(),
        approval: detail.approval,
        recovery: detail.recovery,
        memory: detail.memory,
        prompt: detail.prompt,
        error: detail.errorCode ? `${detail.errorCode}` : undefined
      };
    }
    case 'resumed':
      return { ...state, status: 'running', approval: undefined, recovery: undefined, error: undefined };
    case 'notice':
      return { ...state, error: action.message };
    case 'error':
      return { ...state, status: 'failed', error: action.message };
    default:
      return state;
  }
}

function isTerminal(status: AgentRunStatus | 'idle'): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled' || status === 'interrupted';
}

export function useAgentRun(graphId = 'trend-analysis') {
  const [state, dispatch] = useReducer(reducer, IDLE);
  const [graph, setGraph] = useState<GraphSpec>();
  /** P4：当前 active 图的版本/摘要，用于运行绑定与“未保存改动”校验。 */
  const [graphMeta, setGraphMeta] = useState<{
    version: number;
    digest: string;
    status: AgentGraphStatus;
    isActive: boolean;
  }>();
  /** 运行中/历史 run 使用的图快照；不随当前 active 图变化。 */
  const [viewGraph, setViewGraph] = useState<
    { spec: GraphSpec; version: number; digest: string } | undefined
  >();
  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const runIdRef = useRef<string | undefined>(undefined);
  const seqRef = useRef(0);

  const refreshDetail = useCallback(async (runId: string) => {
    const res = await invokeAgent<AgentRunDetail>('agent:runs:get', { runId });
    if (res.ok) dispatch({ type: 'hydrate', detail: res.data });
    else dispatch({ type: 'error', message: res.message });
  }, []);

  const loadRuns = useCallback(async () => {
    setRunsLoading(true);
    const res = await invokeAgent<AgentRunSummary[]>('agent:runs:list', { limit: 30, graphId });
    if (res.ok) setRuns(res.data);
    setRunsLoading(false);
  }, [graphId]);

  const loadGraphSnapshot = useCallback(async (graphId: string, version?: number) => {
    const res = await invokeAgent<AgentGraphGetResponse>('agent:graphs:get', { graphId, version });
    return res.ok ? res.data : undefined;
  }, []);

  const refreshGraph = useCallback(async () => {
    const snapshot = await loadGraphSnapshot(graphId);
    if (!snapshot) return;
    setGraph(snapshot.spec);
    setGraphMeta({
      version: snapshot.spec.version,
      digest: snapshot.digest,
      status: snapshot.status,
      isActive: snapshot.isActive
    });
  }, [loadGraphSnapshot, graphId]);

  /** P4：保存新版本后由编辑器回写；若正在回放历史 run，则保留其版本快照不串味。 */
  const applySavedGraph = useCallback((spec: GraphSpec, digest: string) => {
    setGraph(spec);
    setViewGraph((prev) => (runIdRef.current ? prev : undefined));
    setGraphMeta({ version: spec.version, digest, status: 'published', isActive: true });
  }, []);

  const backfill = useCallback(
    async (runId: string, afterSeq: number) => {
      const res = await invokeAgent<EventsPage>('agent:runs:events', { runId, afterSeq });
      if (!res.ok) return;
      const events = res.data.events;
      if (events.length === 0) return;
      for (const env of events) {
        if (env.seq <= seqRef.current) continue;
        seqRef.current = env.seq;
        dispatch({ type: 'event', env });
      }
      const last = events[events.length - 1];
      if (
        last.event.type === 'run.completed' ||
        last.event.type === 'run.failed' ||
        last.event.type === 'run.canceled' ||
        last.event.type === 'run.interrupted'
      ) {
        void refreshDetail(runId);
        void loadRuns();
      }
    },
    [refreshDetail, loadRuns]
  );

  useEffect(() => {
    void refreshGraph();
    void loadRuns();
  }, [refreshGraph, loadRuns]);

  useEffect(() => {
    const off = window.lumen.onAgentEvent((env: RunEventEnvelope) => {
      if (!runIdRef.current || env.runId !== runIdRef.current) return;
      if (env.seq <= seqRef.current) return;
      if (env.seq > seqRef.current + 1) {
        // 事件丢失时用 afterSeq 补拉，补拉会包含当前这条。
        void backfill(env.runId, seqRef.current);
        return;
      }
      seqRef.current = env.seq;
      dispatch({ type: 'event', env });
      if (
        env.event.type === 'run.completed' ||
        env.event.type === 'run.failed' ||
        env.event.type === 'run.canceled' ||
        env.event.type === 'run.interrupted'
      ) {
        void refreshDetail(env.runId);
        void loadRuns();
      }
    });
    return off;
  }, [backfill, refreshDetail, loadRuns]);

  const start = useCallback(
    async (req: StartRunRequest) => {
      const res = await invokeAgent<StartRunResponse>('agent:run', req);
      if (!res.ok) {
        dispatch({ type: 'error', message: `${res.code}: ${res.message}` });
        return res;
      }
      runIdRef.current = res.data.runId;
      seqRef.current = 0;
      dispatch({ type: 'reset', runId: res.data.runId });
      void loadGraphSnapshot(res.data.graphId, res.data.graphVersion).then((snapshot) => {
        if (snapshot) {
          setViewGraph({ spec: snapshot.spec, version: res.data.graphVersion, digest: res.data.graphDigest });
        }
      });
      void backfill(res.data.runId, 0);
      void loadRuns();
      return res;
    },
    [backfill, loadRuns, loadGraphSnapshot]
  );

  const cancel = useCallback(async () => {
    if (!runIdRef.current) return undefined;
    const res = await invokeAgent<CancelRunResponse>('agent:cancel', {
      runId: runIdRef.current,
      reason: 'user'
    });
    if (!res.ok) dispatch({ type: 'error', message: `${res.code}: ${res.message}` });
    else void refreshDetail(res.data.runId);
    return res;
  }, [refreshDetail]);

  const resume = useCallback(
    async (resolution: ApprovalResolution) => {
      if (!runIdRef.current) return undefined;
      const res = await invokeAgent<ResumeRunResponse>('agent:runs:resume', {
        runId: runIdRef.current,
        resolution
      });
      if (!res.ok) {
        dispatch({ type: 'notice', message: `${res.code}: ${res.message}` });
        return res;
      }
      if (res.data.status === 'running') {
        dispatch({ type: 'resumed' });
      } else {
        void refreshDetail(res.data.runId);
        void loadRuns();
      }
      return res;
    },
    [refreshDetail, loadRuns]
  );

  /** P7：从 checkpoint 继续运行（无审批挂起时使用）。 */
  const resumeCheckpoint = useCallback(async () => {
    if (!runIdRef.current) return undefined;
    const res = await invokeAgent<ResumeCheckpointResponse>('agent:runs:resumeCheckpoint', {
      runId: runIdRef.current
    });
    if (!res.ok) {
      dispatch({ type: 'notice', message: `${res.code}: ${res.message}` });
      return res;
    }
    dispatch({ type: 'resumed' });
    void loadRuns();
    return res;
  }, [loadRuns]);

  const selectRun = useCallback(
    async (runId: string) => {
      runIdRef.current = runId;
      seqRef.current = 0;
      const res = await invokeAgent<AgentRunDetail>('agent:runs:get', { runId });
      if (!res.ok) {
        dispatch({ type: 'error', message: `${res.code}: ${res.message}` });
        return;
      }
      dispatch({ type: 'hydrate', detail: res.data });
      // P4：历史回放使用该 run 绑定的版本快照，后续改图不影响旧 run 的画布。
      const snapshot = await loadGraphSnapshot(res.data.graphId, res.data.graphVersion);
      setViewGraph(
        snapshot
          ? { spec: snapshot.spec, version: res.data.graphVersion, digest: snapshot.digest }
          : undefined
      );
    },
    [loadGraphSnapshot]
  );

  return {
    state,
    graph,
    graphMeta,
    viewGraph,
    streams: state.streams,
    runs,
    runsLoading,
    start,
    cancel,
    resume,
    resumeCheckpoint,
    selectRun,
    refreshGraph,
    applySavedGraph,
    loadRuns,
    isTerminal: isTerminal(state.status)
  };
}
