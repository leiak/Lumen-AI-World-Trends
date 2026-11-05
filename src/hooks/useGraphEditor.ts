import { useCallback, useReducer } from 'react';
import {
  AGENT_NODE_TYPES,
  type AgentNodeType,
  type GraphEdgeSpec,
  type GraphNodeSpec,
  type GraphSpec,
  type GraphSpecIssue,
  type NodeConfig
} from '../../shared/agent';

export interface GraphEditorState {
  draft?: GraphSpec;
  baseVersion?: number;
  baseDigest?: string;
  dirty: boolean;
  saving: boolean;
  issues: GraphSpecIssue[];
  notice?: string;
  error?: string;
  savedAt?: string;
}

const INITIAL: GraphEditorState = { dirty: false, saving: false, issues: [] };

type Action =
  | { type: 'load'; spec: GraphSpec; digest: string }
  | { type: 'label'; nodeId: string; value: string }
  | { type: 'joinMode'; nodeId: string; value: 'all' | 'any' | undefined }
  | { type: 'config'; nodeId: string; field: string; value: string | number }
  | { type: 'setting'; field: string; value: number }
  | { type: 'position'; nodeId: string; x: number; y: number }
  | { type: 'addNode'; nodeType: AgentNodeType }
  | { type: 'removeNodes'; ids: string[] }
  | { type: 'removeEdges'; ids: string[] }
  | { type: 'connect'; source: string; target: string }
  | { type: 'edgeCondition'; edgeId: string; kind: 'always' | 'debate_rounds' | 'risk_rounds' }
  | { type: 'edgeTarget'; edgeId: string; value: string }
  | { type: 'edgeWhenDone'; edgeId: string; value: string }
  | { type: 'saveStart' }
  | { type: 'saveOk'; spec: GraphSpec; digest: string; at: string }
  | { type: 'saveFail'; issues: GraphSpecIssue[]; message: string }
  | { type: 'clearError' }
  | { type: 'reset' };

const DEFAULT_CONFIG: Record<AgentNodeType, NodeConfig> = {
  memory: { type: 'memory', lookbackDays: 90, maxLessons: 5 },
  evidence: { type: 'evidence', dimension: 'heat', topN: 10, windowDays: 7 },
  bull: { type: 'bull', maxRounds: 2 },
  bear: { type: 'bear', maxRounds: 2 },
  judge: { type: 'judge', requireDirection: true },
  fact_check: { type: 'fact_check', toleranceBps: 50 },
  planner: { type: 'planner', maxTriggers: 3 },
  risk_aggressive: { type: 'risk_aggressive', maxRounds: 1 },
  risk_conservative: { type: 'risk_conservative', maxRounds: 1 },
  risk_neutral: { type: 'risk_neutral', maxRounds: 1 },
  final: { type: 'final', requireApproval: true }
};

const DEFAULT_LABEL: Record<AgentNodeType, string> = {
  memory: '历史教训',
  evidence: '取证',
  bull: '看多',
  bear: '看空',
  judge: '裁决',
  fact_check: '事实核查',
  planner: '观察方案',
  risk_aggressive: '激进风控',
  risk_conservative: '保守风控',
  risk_neutral: '中性风控',
  final: '最终结论'
};

function nextNodeId(spec: GraphSpec, type: AgentNodeType): string {
  const prefix = type.replace('risk_', 'r_').replace(/[^a-z0-9_]/g, '');
  for (let i = 1; i < 100; i++) {
    const id = `${prefix}_${i}`.slice(0, 40);
    if (!spec.nodes.some((n) => n.id === id)) return id;
  }
  return `${prefix}_x`.slice(0, 40);
}

function nextEdgeId(spec: GraphSpec): string {
  for (let i = 1; i < 200; i++) {
    const id = `e_${i}`;
    if (!spec.edges.some((e) => e.id === id)) return id;
  }
  return `e_${Date.now()}`;
}

/** 轮数只有一个事实来源：节点配置、settings、条件边同步，避免手改后必然校验失败。 */
function syncDebateRounds(spec: GraphSpec, rounds: number): GraphSpec {
  return {
    ...spec,
    settings: { ...spec.settings, maxDebateRounds: rounds },
    nodes: spec.nodes.map((n) =>
      n.type === 'bull' || n.type === 'bear'
        ? { ...n, config: { ...n.config, maxRounds: rounds } as NodeConfig }
        : n
    ),
    edges: spec.edges.map((e) =>
      e.condition?.kind === 'debate_rounds'
        ? { ...e, condition: { ...e.condition, maxRounds: rounds } }
        : e
    )
  };
}

function syncRiskRounds(spec: GraphSpec, rounds: number): GraphSpec {
  return {
    ...spec,
    settings: { ...spec.settings, maxRiskRounds: rounds },
    nodes: spec.nodes.map((n) =>
      n.type === 'risk_aggressive' || n.type === 'risk_conservative' || n.type === 'risk_neutral'
        ? { ...n, config: { ...n.config, maxRounds: rounds } as NodeConfig }
        : n
    ),
    edges: spec.edges.map((e) =>
      e.condition?.kind === 'risk_rounds'
        ? { ...e, condition: { ...e.condition, maxRounds: rounds } }
        : e
    )
  };
}

const RISK_TYPE_ORDER = ['risk_aggressive', 'risk_conservative', 'risk_neutral'] as const;

function riskOrder(spec: GraphSpec): string[] {
  const existing = spec.edges.find((e) => e.condition?.kind === 'risk_rounds')?.condition;
  if (existing && existing.kind === 'risk_rounds') return existing.order;
  return RISK_TYPE_ORDER.map((t) => spec.nodes.find((n) => n.type === t)?.id).filter(
    (id): id is string => typeof id === 'string'
  );
}

function findNodeId(spec: GraphSpec, type: AgentNodeType): string | undefined {
  return spec.nodes.find((n) => n.type === type)?.id;
}

/** 切换条件类型时给出“合法默认值”；非法源节点仍保留原目标，交给服务端拒绝并定位。 */
function applyEdgeCondition(
  spec: GraphSpec,
  edgeId: string,
  kind: 'always' | 'debate_rounds' | 'risk_rounds'
): GraphSpec {
  const edge = spec.edges.find((e) => e.id === edgeId);
  if (!edge) return spec;
  if (kind === 'always') {
    return {
      ...spec,
      edges: spec.edges.map((e) => (e.id === edgeId ? { ...e, condition: undefined } : e))
    };
  }
  let target = edge.target;
  let whenDone = '';
  let order: string[] | undefined;
  if (kind === 'debate_rounds') {
    const counterpart = edge.source === findNodeId(spec, 'bull') ? findNodeId(spec, 'bear') :
      edge.source === findNodeId(spec, 'bear') ? findNodeId(spec, 'bull') : undefined;
    if (counterpart) target = counterpart;
    whenDone = findNodeId(spec, 'judge') ?? findNodeId(spec, 'final') ?? '';
  } else {
    order = riskOrder(spec);
    const idx = order.indexOf(edge.source);
    if (idx >= 0) target = order[(idx + 1) % order.length];
    whenDone = findNodeId(spec, 'planner') ?? findNodeId(spec, 'final') ?? '';
  }
  const maxRounds = kind === 'debate_rounds' ? spec.settings.maxDebateRounds : spec.settings.maxRiskRounds;
  return {
    ...spec,
    edges: spec.edges.map((e) =>
      e.id === edgeId
        ? { ...e, target, condition: kind === 'debate_rounds'
            ? { kind, maxRounds, whenDone }
            : { kind, maxRounds, whenDone, order: order ?? riskOrder(spec) } }
        : e
    )
  };
}

function applyConfig(spec: GraphSpec, nodeId: string, field: string, value: string | number): GraphSpec {
  const node = spec.nodes.find((n) => n.id === nodeId);
  if (!node) return spec;
  if (
    field === 'maxRounds' &&
    (node.type === 'bull' || node.type === 'bear') &&
    typeof value === 'number'
  ) {
    return syncDebateRounds(spec, value);
  }
  if (
    field === 'maxRounds' &&
    (node.type === 'risk_aggressive' || node.type === 'risk_conservative' || node.type === 'risk_neutral') &&
    typeof value === 'number'
  ) {
    return syncRiskRounds(spec, value);
  }
  return {
    ...spec,
    nodes: spec.nodes.map((n) =>
      n.id === nodeId
        ? { ...n, config: { ...n.config, [field]: value } as NodeConfig }
        : n
    )
  };
}

function reducer(state: GraphEditorState, action: Action): GraphEditorState {
  if (action.type === 'load') {
    return {
      draft: action.spec,
      baseVersion: action.spec.version,
      baseDigest: action.digest,
      dirty: false,
      saving: false,
      issues: [],
      savedAt: undefined
    };
  }
  if (action.type === 'saveStart') return { ...state, saving: true, issues: [], error: undefined };
  if (action.type === 'saveOk') {
    return {
      ...state,
      draft: action.spec,
      baseVersion: action.spec.version,
      baseDigest: action.digest,
      dirty: false,
      saving: false,
      issues: [],
      notice: String(action.spec.version),
      error: undefined,
      savedAt: action.at
    };
  }
  if (action.type === 'saveFail') {
    return { ...state, saving: false, issues: action.issues, error: action.message };
  }
  if (action.type === 'clearError') return { ...state, error: undefined };
  if (action.type === 'reset') return INITIAL;

  const spec = state.draft;
  if (!spec) return state;
  let next = spec;
  let error = state.error;

  switch (action.type) {
    case 'label': {
      const label = action.value.slice(0, 60);
      next = { ...spec, nodes: spec.nodes.map((n) => (n.id === action.nodeId ? { ...n, label } : n)) };
      break;
    }
    case 'joinMode':
      next = {
        ...spec,
        nodes: spec.nodes.map((n) => (n.id === action.nodeId ? { ...n, joinMode: action.value } : n))
      };
      break;
    case 'config':
      next = applyConfig(spec, action.nodeId, action.field, action.value);
      break;
    case 'setting': {
      if (action.field === 'maxDebateRounds') next = syncDebateRounds(spec, action.value);
      else if (action.field === 'maxRiskRounds') next = syncRiskRounds(spec, action.value);
      else next = { ...spec, settings: { ...spec.settings, [action.field]: action.value } };
      break;
    }
    case 'position':
      next = {
        ...spec,
        nodes: spec.nodes.map((n) =>
          n.id === action.nodeId ? { ...n, position: { x: action.x, y: action.y } } : n
        )
      };
      break;
    case 'addNode': {
      const id = nextNodeId(spec, action.nodeType);
      const node: GraphNodeSpec = {
        id,
        type: action.nodeType,
        label: DEFAULT_LABEL[action.nodeType],
        position: {
          x: 80 + (spec.nodes.length % 5) * 220,
          y: 60 + Math.floor(spec.nodes.length / 5) * 150
        },
        joinMode: action.nodeType === 'bull' || action.nodeType === 'bear' ? 'any' : 'all',
        config: DEFAULT_CONFIG[action.nodeType]
      };
      next = { ...spec, nodes: [...spec.nodes, node] };
      break;
    }
    case 'removeNodes': {
      const ids = new Set(action.ids);
      next = {
        ...spec,
        nodes: spec.nodes.filter((n) => !ids.has(n.id)),
        edges: spec.edges.filter((e) => !ids.has(e.source) && !ids.has(e.target))
      };
      break;
    }
    case 'removeEdges': {
      const ids = new Set(action.ids);
      next = { ...spec, edges: spec.edges.filter((e) => !ids.has(e.id)) };
      break;
    }
    case 'edgeCondition':
      next = applyEdgeCondition(spec, action.edgeId, action.kind);
      break;
    case 'edgeTarget':
      next = {
        ...spec,
        edges: spec.edges.map((e) => (e.id === action.edgeId ? { ...e, target: action.value } : e))
      };
      break;
    case 'edgeWhenDone':
      next = {
        ...spec,
        edges: spec.edges.map((e) =>
          e.id === action.edgeId && e.condition && e.condition.kind !== 'always'
            ? { ...e, condition: { ...e.condition, whenDone: action.value } }
            : e
        )
      };
      break;
    case 'connect': {
      if (action.source === action.target) {
        error = '不允许自环';
        break;
      }
      if (action.source === '__end__' || action.target === '__start__') {
        error = '边方向非法';
        break;
      }
      if (spec.edges.some((e) => e.source === action.source && e.target === action.target)) {
        error = '重复边';
        break;
      }
      const edge: GraphEdgeSpec = {
        id: nextEdgeId(spec),
        source: action.source,
        target: action.target
      };
      next = { ...spec, edges: [...spec.edges, edge] };
      error = undefined;
      break;
    }
    default:
      break;
  }

  if (next === spec) return error ? { ...state, error } : state;
  return { ...state, draft: next, dirty: true, error, issues: [] };
}

export function useGraphEditor() {
  const [state, dispatch] = useReducer(reducer, INITIAL);

  const load = useCallback((spec: GraphSpec, digest: string) => {
    dispatch({ type: 'load', spec, digest });
  }, []);
  const label = useCallback((nodeId: string, value: string) => {
    dispatch({ type: 'label', nodeId, value });
  }, []);
  const joinMode = useCallback((nodeId: string, value: 'all' | 'any' | undefined) => {
    dispatch({ type: 'joinMode', nodeId, value });
  }, []);
  const config = useCallback((nodeId: string, field: string, value: string | number) => {
    dispatch({ type: 'config', nodeId, field, value });
  }, []);
  const setting = useCallback((field: string, value: number) => {
    dispatch({ type: 'setting', field, value });
  }, []);
  const position = useCallback((nodeId: string, x: number, y: number) => {
    dispatch({ type: 'position', nodeId, x, y });
  }, []);
  const addNode = useCallback((nodeType: AgentNodeType) => {
    if (!AGENT_NODE_TYPES.includes(nodeType)) return;
    dispatch({ type: 'addNode', nodeType });
  }, []);
  const removeNodes = useCallback((ids: string[]) => {
    if (ids.length > 0) dispatch({ type: 'removeNodes', ids });
  }, []);
  const removeEdges = useCallback((ids: string[]) => {
    if (ids.length > 0) dispatch({ type: 'removeEdges', ids });
  }, []);
  const connect = useCallback((source: string, target: string) => {
    dispatch({ type: 'connect', source, target });
  }, []);
  const setEdgeCondition = useCallback(
    (edgeId: string, kind: 'always' | 'debate_rounds' | 'risk_rounds') => {
      dispatch({ type: 'edgeCondition', edgeId, kind });
    },
    []
  );
  const setEdgeTarget = useCallback((edgeId: string, value: string) => {
    dispatch({ type: 'edgeTarget', edgeId, value });
  }, []);
  const setEdgeWhenDone = useCallback((edgeId: string, value: string) => {
    dispatch({ type: 'edgeWhenDone', edgeId, value });
  }, []);
  const saveStart = useCallback(() => dispatch({ type: 'saveStart' }), []);
  const saveOk = useCallback((spec: GraphSpec, digest: string, at: string) => {
    dispatch({ type: 'saveOk', spec, digest, at });
  }, []);
  const saveFail = useCallback((issues: GraphSpecIssue[], message: string) => {
    dispatch({ type: 'saveFail', issues, message });
  }, []);
  const clearError = useCallback(() => dispatch({ type: 'clearError' }), []);

  return {
    state,
    load,
    label,
    joinMode,
    config,
    setting,
    position,
    addNode,
    removeNodes,
    removeEdges,
    connect,
    setEdgeCondition,
    setEdgeTarget,
    setEdgeWhenDone,
    saveStart,
    saveOk,
    saveFail,
    clearError
  };
}
