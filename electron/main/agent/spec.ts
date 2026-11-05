import { createHash } from 'node:crypto';
import {
  AGENT_NODE_TYPES,
  RISK_NODE_TYPES,
  type AgentErrorCode,
  type AgentNodeType,
  type GraphEdgeSpec,
  type GraphNodeSpec,
  type GraphSpec,
  type GraphSpecIssue,
  type NodeConfig,
  type RunSettings
} from '../../../shared/agent.js';

export type SpecIssue = GraphSpecIssue;

/** ok=false 时保留首个问题的 code/message 供旧调用方使用，并用 issues 回传全部可定位问题。 */
export type SpecValidation =
  | { ok: true; spec: GraphSpec }
  | {
      ok: false;
      code: AgentErrorCode;
      message: string;
      issues: SpecIssue[];
    };

const NODE_ID_RE = /^[a-z0-9_-]{1,40}$/;
// __start__/__end__ 是 LangGraph 保留节点；其余为 AgentState 的 channel 名，
// LangGraph 不允许节点 id 与 state channel 重名。
const RESERVED_IDS = new Set([
  '__start__',
  '__end__',
  'subject',
  'evidenceBundle',
  'memoryContext',
  'memoryUsed',
  'bullTurn',
  'bearTurn',
  'debate',
  'risk',
  'proposal',
  'plan',
  'decision',
  'usage',
  'runId',
  'asOf'
]);
const AGENT_NODE_TYPE_SET = new Set<AgentNodeType>(AGENT_NODE_TYPES);
const RISK_TYPE_SET = new Set<AgentNodeType>(RISK_NODE_TYPES);

const TOP_KEYS = new Set([
  'specVersion',
  'id',
  'version',
  'name',
  'description',
  'createdAt',
  'updatedAt',
  'nodes',
  'edges',
  'settings'
]);
const NODE_KEYS = new Set(['id', 'type', 'label', 'position', 'joinMode', 'config']);
const EDGE_KEYS = new Set(['id', 'source', 'target', 'condition']);
const SETTINGS_KEYS = new Set([
  'maxDebateRounds',
  'maxRiskRounds',
  'maxToolRounds',
  'recursionLimit',
  'nodeTimeoutMs',
  'runTimeoutMs',
  'maxCostUsd',
  'maxNodes'
]);

function fail(code: AgentErrorCode, message: string, loc?: { nodeId?: string; edgeId?: string }): SpecValidation {
  const issue: SpecIssue = { code, message, ...loc };
  return { ok: false, code, message, issues: [issue] };
}

function failIssues(issues: SpecIssue[]): SpecValidation {
  const first = issues[0];
  return { ok: false, code: first.code, message: first.message, issues };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasUnknownKeys(obj: Record<string, unknown>, allowed: Set<string>): string | null {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return key;
  }
  return null;
}

function asInt(v: unknown, min: number, max: number): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

function isIso(v: unknown): boolean {
  return typeof v === 'string' && Number.isFinite(Date.parse(v));
}

function validateConfig(type: AgentNodeType, raw: unknown): NodeConfig | null {
  if (!isRecord(raw) || raw.type !== type) return null;
  if (type === 'memory') {
    const allowed = new Set(['type', 'lookbackDays', 'maxLessons']);
    if (hasUnknownKeys(raw, allowed)) return null;
    if (!asInt(raw.lookbackDays, 1, 365) || !asInt(raw.maxLessons, 1, 10)) return null;
    return {
      type: 'memory',
      lookbackDays: raw.lookbackDays as number,
      maxLessons: raw.maxLessons as number
    };
  }
  if (type === 'evidence') {
    const allowed = new Set(['type', 'dimension', 'topN', 'windowDays']);
    if (hasUnknownKeys(raw, allowed)) return null;
    const dim = raw.dimension;
    if (
      dim !== 'heat' &&
      dim !== 'sentiment' &&
      dim !== 'geopolitics' &&
      dim !== 'structure' &&
      dim !== 'market' &&
      dim !== 'fundamentals' &&
      dim !== 'disclosures' &&
      dim !== 'news'
    ) {
      return null;
    }
    if (!asInt(raw.topN, 1, 50) || !asInt(raw.windowDays, 1, 90)) return null;
    return { type: 'evidence', dimension: dim, topN: raw.topN as number, windowDays: raw.windowDays as number };
  }
  if (type === 'bull' || type === 'bear') {
    const allowed = new Set(['type', 'maxRounds']);
    if (hasUnknownKeys(raw, allowed)) return null;
    if (!asInt(raw.maxRounds, 1, 3)) return null;
    return { type, maxRounds: raw.maxRounds as number };
  }
  if (type === 'judge') {
    const allowed = new Set(['type', 'requireDirection']);
    if (hasUnknownKeys(raw, allowed)) return null;
    if (raw.requireDirection !== true) return null;
    return { type: 'judge', requireDirection: true };
  }
  if (type === 'fact_check') {
    const allowed = new Set(['type', 'toleranceBps']);
    if (hasUnknownKeys(raw, allowed)) return null;
    if (!asInt(raw.toleranceBps, 0, 5000)) return null;
    return { type: 'fact_check', toleranceBps: raw.toleranceBps as number };
  }
  if (type === 'planner') {
    const allowed = new Set(['type', 'maxTriggers']);
    if (hasUnknownKeys(raw, allowed)) return null;
    if (!asInt(raw.maxTriggers, 1, 6)) return null;
    return { type: 'planner', maxTriggers: raw.maxTriggers as number };
  }
  if (RISK_TYPE_SET.has(type)) {
    const allowed = new Set(['type', 'maxRounds']);
    if (hasUnknownKeys(raw, allowed)) return null;
    if (!asInt(raw.maxRounds, 1, 3)) return null;
    return {
      type: type as 'risk_aggressive' | 'risk_conservative' | 'risk_neutral',
      maxRounds: raw.maxRounds as number
    };
  }
  // final
  if (hasUnknownKeys(raw, new Set(['type', 'requireApproval']))) return null;
  if (raw.requireApproval !== true) return null;
  return { type: 'final', requireApproval: true };
}

function validateNode(raw: unknown): GraphNodeSpec | SpecIssue {
  if (!isRecord(raw)) return { code: 'E_VALIDATION', message: 'node 必须是对象' };
  const unknown = hasUnknownKeys(raw, NODE_KEYS);
  if (unknown) return { code: 'E_VALIDATION', message: `node 含未知字段: ${unknown}` };
  if (typeof raw.id !== 'string' || !NODE_ID_RE.test(raw.id) || RESERVED_IDS.has(raw.id)) {
    return { code: 'E_VALIDATION', message: `node id 非法: ${String(raw.id)}` };
  }
  if (typeof raw.type !== 'string' || !AGENT_NODE_TYPE_SET.has(raw.type as AgentNodeType)) {
    return { code: 'E_NODE_TYPE_UNKNOWN', message: `nodeType 不在白名单: ${String(raw.type)}` };
  }
  if (typeof raw.label !== 'string' || raw.label.trim().length === 0) {
    return { code: 'E_VALIDATION', message: `node ${raw.id} 缺少 label` };
  }
  const pos = raw.position;
  if (
    !isRecord(pos) ||
    typeof pos.x !== 'number' ||
    typeof pos.y !== 'number' ||
    !Number.isFinite(pos.x) ||
    !Number.isFinite(pos.y)
  ) {
    return { code: 'E_VALIDATION', message: `node ${raw.id} position 非法` };
  }
  if (raw.joinMode !== undefined && raw.joinMode !== 'all' && raw.joinMode !== 'any') {
    return { code: 'E_VALIDATION', message: `node ${raw.id} joinMode 非法` };
  }
  const config = validateConfig(raw.type as AgentNodeType, raw.config);
  if (!config) {
    return { code: 'E_VALIDATION', message: `node ${raw.id} config 与 type 不匹配或字段非法` };
  }
  return {
    id: raw.id,
    type: raw.type as AgentNodeType,
    label: raw.label,
    position: { x: pos.x, y: pos.y },
    joinMode: raw.joinMode as 'all' | 'any' | undefined,
    config
  };
}

function validateEdge(
  raw: unknown,
  nodeById: Map<string, GraphNodeSpec>
): GraphEdgeSpec | SpecIssue {
  if (!isRecord(raw)) return { code: 'E_VALIDATION', message: 'edge 必须是对象' };
  const unknown = hasUnknownKeys(raw, EDGE_KEYS);
  if (unknown) return { code: 'E_VALIDATION', message: `edge 含未知字段: ${unknown}` };
  if (typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > 60) {
    return { code: 'E_VALIDATION', message: 'edge id 非法' };
  }
  const source = raw.source;
  const target = raw.target;
  if (typeof source !== 'string' || typeof target !== 'string') {
    return { code: 'E_VALIDATION', message: `edge ${raw.id} source/target 非法` };
  }
  const nodeRefOk = (ref: string): boolean =>
    ref === '__start__' || ref === '__end__' || nodeById.has(ref);
  if (!nodeRefOk(source) || !nodeRefOk(target)) {
    return { code: 'E_GRAPH_INVALID', message: `edge ${raw.id} 指向不存在的节点` };
  }
  if (source === '__end__' || target === '__start__') {
    return { code: 'E_GRAPH_INVALID', message: `edge ${raw.id} 方向非法` };
  }
  if (source === target) {
    return { code: 'E_GRAPH_INVALID', message: `edge ${raw.id} 不允许自环` };
  }

  if (raw.condition === undefined) {
    return { id: raw.id, source, target };
  }
  const c = raw.condition;
  if (!isRecord(c) || typeof c.kind !== 'string') {
    return { code: 'E_VALIDATION', message: `edge ${raw.id} condition 非法` };
  }
  if (c.kind === 'always') {
    if (hasUnknownKeys(c, new Set(['kind']))) {
      return { code: 'E_VALIDATION', message: `edge ${raw.id} always condition 含未知字段` };
    }
    return { id: raw.id, source, target, condition: { kind: 'always' } };
  }
  if (c.kind === 'risk_rounds') {
    if (hasUnknownKeys(c, new Set(['kind', 'maxRounds', 'order', 'whenDone']))) {
      return { code: 'E_VALIDATION', message: `edge ${raw.id} risk_rounds 含未知字段` };
    }
    if (!asInt(c.maxRounds, 1, 3)) {
      return { code: 'E_VALIDATION', message: `edge ${raw.id} maxRounds 需为 1-3` };
    }
    if (!Array.isArray(c.order) || c.order.length !== 3) {
      return { code: 'E_GRAPH_INVALID', message: `edge ${raw.id} order 必须包含 3 个风控节点` };
    }
    const order = c.order.filter((x): x is string => typeof x === 'string');
    if (order.length !== 3 || new Set(order).size !== 3) {
      return { code: 'E_GRAPH_INVALID', message: `edge ${raw.id} order 元素非法或重复` };
    }
    for (const id of order) {
      const n = nodeById.get(id);
      if (!n || !RISK_TYPE_SET.has(n.type)) {
        return { code: 'E_GRAPH_INVALID', message: `edge ${raw.id} order 含非风控节点: ${id}` };
      }
    }
    if (typeof c.whenDone !== 'string' || !nodeById.has(c.whenDone)) {
      return { code: 'E_GRAPH_INVALID', message: `edge ${raw.id} whenDone 指向不存在的节点` };
    }
    const doneNode = nodeById.get(c.whenDone) as GraphNodeSpec;
    if (doneNode.type !== 'planner' && doneNode.type !== 'final') {
      return {
        code: 'E_GRAPH_INVALID',
        message: `edge ${raw.id} risk_rounds 的 whenDone 只能是 planner 或 final（风控出口）`
      };
    }
    const srcNode = source === '__start__' || source === '__end__' ? undefined : nodeById.get(source);
    const dstNode = target === '__start__' || target === '__end__' ? undefined : nodeById.get(target);
    if (!srcNode || !RISK_TYPE_SET.has(srcNode.type)) {
      return { code: 'E_GRAPH_INVALID', message: `edge ${raw.id} risk_rounds 只能来自风控节点` };
    }
    if (!dstNode || !RISK_TYPE_SET.has(dstNode.type)) {
      return { code: 'E_GRAPH_INVALID', message: `edge ${raw.id} risk_rounds 目标必须是风控节点` };
    }
    const expectedTarget = order[(order.indexOf(srcNode.id) + 1) % order.length];
    if (dstNode.id !== expectedTarget) {
      return {
        code: 'E_GRAPH_INVALID',
        message: `edge ${raw.id} risk_rounds 必须按 order 顺序流转（期望 ${expectedTarget}）`
      };
    }
    if (c.whenDone === target) {
      return {
        code: 'E_GRAPH_INVALID',
        message: `edge ${raw.id} whenDone 与条件分支 target 必须互斥`
      };
    }
    if ((srcNode.config as { maxRounds?: number }).maxRounds !== c.maxRounds) {
      return {
        code: 'E_VALIDATION',
        message: `edge ${raw.id} maxRounds 必须与节点 ${srcNode.id} 配置一致`
      };
    }
    return {
      id: raw.id,
      source,
      target,
      condition: {
        kind: 'risk_rounds',
        maxRounds: c.maxRounds as number,
        order,
        whenDone: c.whenDone
      }
    };
  }
  if (c.kind !== 'debate_rounds') {
    return { code: 'E_GRAPH_INVALID', message: `未知条件边类型: ${c.kind}` };
  }

  if (hasUnknownKeys(c, new Set(['kind', 'maxRounds', 'whenDone']))) {
    return { code: 'E_VALIDATION', message: `edge ${raw.id} debate_rounds 含未知字段` };
  }
  if (!asInt(c.maxRounds, 1, 3)) {
    return { code: 'E_VALIDATION', message: `edge ${raw.id} maxRounds 需为 1-3` };
  }
  if (typeof c.whenDone !== 'string' || !nodeById.has(c.whenDone)) {
    return { code: 'E_GRAPH_INVALID', message: `edge ${raw.id} whenDone 指向不存在的节点` };
  }
  const doneNode = nodeById.get(c.whenDone) as GraphNodeSpec;
  if (doneNode.type !== 'judge') {
    return {
      code: 'E_GRAPH_INVALID',
      message: `edge ${raw.id} debate_rounds 的 whenDone 只能指向 judge`
    };
  }
  const srcNode = source === '__start__' || source === '__end__' ? undefined : nodeById.get(source);
  const dstNode = target === '__start__' || target === '__end__' ? undefined : nodeById.get(target);
  if (!srcNode || (srcNode.type !== 'bull' && srcNode.type !== 'bear')) {
    return { code: 'E_GRAPH_INVALID', message: `edge ${raw.id} debate_rounds 只能来自 bull/bear` };
  }
  const expectedTarget = srcNode.type === 'bull' ? 'bear' : 'bull';
  if (!dstNode || dstNode.type !== expectedTarget) {
    return {
      code: 'E_GRAPH_INVALID',
      message: `edge ${raw.id} debate_rounds 必须指向对立方（${expectedTarget}）`
    };
  }
  if (c.whenDone === target) {
    return {
      code: 'E_GRAPH_INVALID',
      message: `edge ${raw.id} whenDone 与条件分支 target 必须互斥`
    };
  }
  if ((srcNode.config as { maxRounds?: number }).maxRounds !== c.maxRounds) {
    return {
      code: 'E_VALIDATION',
      message: `edge ${raw.id} maxRounds 必须与节点 ${srcNode.id} 配置一致`
    };
  }
  return {
    id: raw.id,
    source,
    target,
    condition: { kind: 'debate_rounds', maxRounds: c.maxRounds as number, whenDone: c.whenDone }
  };
}

function validateSettings(raw: unknown): RunSettings | SpecIssue {
  if (!isRecord(raw)) return { code: 'E_VALIDATION', message: 'settings 必须是对象' };
  const unknown = hasUnknownKeys(raw, SETTINGS_KEYS);
  if (unknown) return { code: 'E_VALIDATION', message: `settings 含未知字段: ${unknown}` };
  if (!asInt(raw.maxDebateRounds, 1, 3)) return { code: 'E_VALIDATION', message: 'maxDebateRounds 需为 1-3' };
  if (!asInt(raw.maxRiskRounds, 1, 3)) return { code: 'E_VALIDATION', message: 'maxRiskRounds 需为 1-3' };
  if (!asInt(raw.maxToolRounds, 0, 4)) return { code: 'E_VALIDATION', message: 'maxToolRounds 需为 0-4' };
  if (!asInt(raw.recursionLimit, 3, 100)) return { code: 'E_VALIDATION', message: 'recursionLimit 非法' };
  const recursionLimit = raw.recursionLimit as number;
  if (recursionLimit <= 2 * (raw.maxToolRounds as number) + 2) {
    return { code: 'E_VALIDATION', message: 'recursionLimit 必须大于 2*maxToolRounds+2' };
  }
  if (!asInt(raw.nodeTimeoutMs, 1000, 300000)) {
    return { code: 'E_VALIDATION', message: 'nodeTimeoutMs 需为 1000-300000' };
  }
  if (!asInt(raw.runTimeoutMs, 10000, 3600000)) {
    return { code: 'E_VALIDATION', message: 'runTimeoutMs 需为 10000-3600000' };
  }
  if (
    typeof raw.maxCostUsd !== 'number' ||
    !Number.isFinite(raw.maxCostUsd) ||
    raw.maxCostUsd <= 0 ||
    raw.maxCostUsd > 5
  ) {
    return { code: 'E_VALIDATION', message: 'maxCostUsd 需为 (0, 5]' };
  }
  if (!asInt(raw.maxNodes, 1, 32)) return { code: 'E_VALIDATION', message: 'maxNodes 需为 1-32' };
  return {
    maxDebateRounds: raw.maxDebateRounds as number,
    maxRiskRounds: raw.maxRiskRounds as number,
    maxToolRounds: raw.maxToolRounds as number,
    recursionLimit: raw.recursionLimit as number,
    nodeTimeoutMs: raw.nodeTimeoutMs as number,
    runTimeoutMs: raw.runTimeoutMs as number,
    maxCostUsd: raw.maxCostUsd as number,
    maxNodes: raw.maxNodes as number
  };
}

/** 手写校验器（不引入 zod）：未知字段、白名单、环路、可达性、终端节点全部显式检查。
 *  保存与编译前都调用；P0 只接受 4 节点类型与 always 边。 */
export function validateGraphSpec(raw: unknown): SpecValidation {
  if (!isRecord(raw)) return fail('E_VALIDATION', 'GraphSpec 必须是对象');
  const unknown = hasUnknownKeys(raw, TOP_KEYS);
  if (unknown) return fail('E_VALIDATION', `GraphSpec 含未知字段: ${unknown}`);
  if (raw.specVersion !== 1) return fail('E_VALIDATION', 'specVersion 必须为 1');
  if (typeof raw.id !== 'string' || !NODE_ID_RE.test(raw.id)) {
    return fail('E_VALIDATION', 'graph id 非法');
  }
  if (!asInt(raw.version, 1, 1_000_000)) return fail('E_VALIDATION', 'version 非法');
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0) {
    return fail('E_VALIDATION', 'name 不能为空');
  }
  if (!isIso(raw.createdAt) || !isIso(raw.updatedAt)) {
    return fail('E_VALIDATION', 'createdAt/updatedAt 必须为 ISO 时间');
  }
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    return fail('E_VALIDATION', 'description 必须是字符串');
  }
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    return fail('E_VALIDATION', 'nodes/edges 必须是数组');
  }
  const settings = validateSettings(raw.settings);
  if ('code' in settings) return fail(settings.code, settings.message);
  if (raw.nodes.length < 1 || raw.nodes.length > settings.maxNodes) {
    return fail('E_GRAPH_INVALID', `节点数量需在 1-${settings.maxNodes}`);
  }
  if (raw.edges.length > 64) return fail('E_GRAPH_INVALID', '边数量不得超过 64');

  const nodes: GraphNodeSpec[] = [];
  const nodeIds = new Set<string>();
  const nodeById = new Map<string, GraphNodeSpec>();
  const nodeIssues: SpecIssue[] = [];
  for (const n of raw.nodes) {
    const res = validateNode(n);
    if ('code' in res) {
      const nodeId =
        res.nodeId ?? (isRecord(n) && typeof n.id === 'string' && n.id.length > 0 ? n.id : undefined);
      nodeIssues.push(nodeId ? { ...res, nodeId } : res);
      continue;
    }
    if (nodeIds.has(res.id)) {
      nodeIssues.push({ code: 'E_VALIDATION', message: `node id 重复: ${res.id}`, nodeId: res.id });
      continue;
    }
    nodeIds.add(res.id);
    nodeById.set(res.id, res);
    nodes.push(res);
  }
  if (nodeIssues.length > 0) return failIssues(nodeIssues);

  const edges: GraphEdgeSpec[] = [];
  const edgeIds = new Set<string>();
  const pairs = new Set<string>();
  const edgeIssues: SpecIssue[] = [];
  for (const e of raw.edges) {
    const res = validateEdge(e, nodeById);
    if ('code' in res) {
      const edgeId =
        res.edgeId ?? (isRecord(e) && typeof e.id === 'string' && e.id.length > 0 ? e.id : undefined);
      edgeIssues.push(edgeId ? { ...res, edgeId } : res);
      continue;
    }
    if (edgeIds.has(res.id)) {
      edgeIssues.push({ code: 'E_VALIDATION', message: `edge id 重复: ${res.id}`, edgeId: res.id });
      continue;
    }
    const pair = `${res.source}->${res.target}`;
    if (pairs.has(pair)) {
      edgeIssues.push({ code: 'E_GRAPH_INVALID', message: `重复边: ${pair}`, edgeId: res.id });
      continue;
    }
    edgeIds.add(res.id);
    pairs.add(pair);
    edges.push(res);
  }
  if (edgeIssues.length > 0) return failIssues(edgeIssues);

  const byType = new Map<AgentNodeType, GraphNodeSpec[]>();
  for (const n of nodes) {
    const list = byType.get(n.type) ?? [];
    list.push(n);
    byType.set(n.type, list);
  }
  const evidence = byType.get('evidence') ?? [];
  const bull = byType.get('bull') ?? [];
  const bear = byType.get('bear') ?? [];
  const judge = byType.get('judge') ?? [];
  if (evidence.length === 0) return fail('E_GRAPH_INVALID', '至少需要 1 个 evidence 节点');

  // memory 只能有一个，且必须唯一无条件出边指向 evidence，保证它先于取证执行。
  const memoryNodes = byType.get('memory') ?? [];
  if (memoryNodes.length > 1) {
    return fail('E_GRAPH_INVALID', 'memory 节点最多 1 个', { nodeId: memoryNodes[1].id });
  }
  if (memoryNodes.length === 1) {
    const mem = memoryNodes[0];
    const outs = edges.filter((e) => e.source === mem.id);
    const toEvidence = outs.find((e) => {
      const target = nodeById.get(e.target);
      return (
        target?.type === 'evidence' &&
        (e.condition === undefined || e.condition.kind === 'always')
      );
    });
    if (!toEvidence) {
      return fail('E_GRAPH_INVALID', 'memory 节点必须有无条件边指向 evidence 节点', {
        nodeId: mem.id
      });
    }
    if (outs.length !== 1) {
      return fail('E_GRAPH_INVALID', 'memory 节点只允许一条指向 evidence 的出边', {
        nodeId: mem.id,
        edgeId: outs.find((e) => e.id !== toEvidence.id)?.id
      });
    }
  }
  if (bull.length !== 1 || bear.length !== 1) {
    const extra = bull.length > 1 ? bull[1].id : bear.length > 1 ? bear[1].id : undefined;
    return fail('E_GRAPH_INVALID', '当前需要恰好 1 个 bull 与 1 个 bear 节点', { nodeId: extra });
  }
  if (judge.length !== 1) {
    return fail('E_GRAPH_INVALID', '当前需要恰好 1 个 judge 节点', {
      nodeId: judge.length > 1 ? judge[1].id : undefined
    });
  }
  const planner = byType.get('planner') ?? [];
  const finals = byType.get('final') ?? [];
  if (planner.length > 1) {
    return fail('E_GRAPH_INVALID', 'planner 节点最多 1 个', { nodeId: planner[1].id });
  }
  // M26：数字闸门最多 1 个；世界趋势默认图不含该节点，校验行为不变。
  const factChecks = byType.get('fact_check') ?? [];
  if (factChecks.length > 1) {
    return fail('E_GRAPH_INVALID', 'fact_check 节点最多 1 个', { nodeId: factChecks[1].id });
  }
  if (finals.length !== 1) {
    return fail('E_GRAPH_INVALID', '必须且只能有 1 个 final 节点', {
      nodeId: finals.length > 1 ? finals[1].id : undefined
    });
  }

  const riskNodes = nodes.filter((n) => RISK_TYPE_SET.has(n.type));
  if (riskNodes.length > 0) {
    if (riskNodes.length !== 3) {
      return fail('E_GRAPH_INVALID', '风控节点必须同时存在 aggressive/conservative/neutral 三个', {
        nodeId: riskNodes.length > 3 ? riskNodes[3].id : riskNodes[0].id
      });
    }
    for (const t of RISK_NODE_TYPES) {
      if ((byType.get(t) ?? []).length !== 1) {
        return fail('E_GRAPH_INVALID', `风控节点 ${t} 必须恰好 1 个`);
      }
    }
    if (planner.length !== 1) {
      return fail('E_GRAPH_INVALID', '启用风控节点时必须有 1 个 planner 作为出口');
    }
  }

  // P6：轮数三方一致（settings / 节点 config / 条件边）与条件边约束一次尽量收集多条。
  const structuralIssues: SpecIssue[] = [];
  for (const n of riskNodes) {
    const rounds = (n.config as { maxRounds: number }).maxRounds;
    if (rounds !== settings.maxRiskRounds) {
      structuralIssues.push({
        code: 'E_VALIDATION',
        message: `节点 ${n.id} maxRounds 必须与 settings.maxRiskRounds 一致`,
        nodeId: n.id
      });
    }
  }

  // 轮数必须只有一个事实来源：settings 与 bull/bear 节点配置一致。
  const bullRounds = (bull[0].config as { maxRounds: number }).maxRounds;
  const bearRounds = (bear[0].config as { maxRounds: number }).maxRounds;
  if (bullRounds !== settings.maxDebateRounds) {
    structuralIssues.push({
      code: 'E_VALIDATION',
      message: `节点 ${bull[0].id} maxRounds 必须与 settings.maxDebateRounds 一致`,
      nodeId: bull[0].id
    });
  }
  if (bearRounds !== settings.maxDebateRounds) {
    structuralIssues.push({
      code: 'E_VALIDATION',
      message: `节点 ${bear[0].id} maxRounds 必须与 settings.maxDebateRounds 一致`,
      nodeId: bear[0].id
    });
  }

  const conditionalEdges = edges.filter((e) => e.condition && e.condition.kind !== 'always');
  const condSources = new Map<string, string>();
  for (const e of conditionalEdges) {
    const prev = condSources.get(e.source);
    if (prev) {
      structuralIssues.push({
        code: 'E_GRAPH_INVALID',
        message: `节点 ${e.source} 只允许一条条件边（与 ${prev} 冲突）`,
        edgeId: e.id
      });
      continue;
    }
    condSources.set(e.source, e.id);
  }

  const debateEdges = conditionalEdges.filter((e) => e.condition?.kind === 'debate_rounds');
  const bullToBear = debateEdges.find((e) => e.source === bull[0].id && e.target === bear[0].id);
  const bearToBull = debateEdges.find((e) => e.source === bear[0].id && e.target === bull[0].id);
  if (!bullToBear || !bearToBull) {
    structuralIssues.push({
      code: 'E_GRAPH_INVALID',
      message: '多轮辩论需要 bull→bear 与 bear→bull 两条 debate_rounds 条件边'
    });
  }
  for (const e of debateEdges) {
    const c = e.condition as { kind: 'debate_rounds'; maxRounds: number; whenDone: string };
    if (c.maxRounds !== settings.maxDebateRounds) {
      structuralIssues.push({
        code: 'E_VALIDATION',
        message: `edge ${e.id} maxRounds 必须与 settings.maxDebateRounds 一致`,
        edgeId: e.id
      });
    }
    if (!nodeById.has(c.whenDone)) {
      structuralIssues.push({
        code: 'E_GRAPH_INVALID',
        message: `edge ${e.id} whenDone 节点不存在`,
        edgeId: e.id
      });
    }
  }

  // 风控条件边：三个风控节点各一条，order 必须一致。
  const riskEdges = conditionalEdges.filter((e) => e.condition?.kind === 'risk_rounds');
  if (riskNodes.length === 0 && riskEdges.length > 0) {
    structuralIssues.push({
      code: 'E_GRAPH_INVALID',
      message: 'risk_rounds 条件边需要三个风控节点'
    });
  }
  if (riskNodes.length === 3) {
    let orderKey: string | null = null;
    for (const n of riskNodes) {
      const edge = riskEdges.find((e) => e.source === n.id);
      if (!edge) {
        structuralIssues.push({
          code: 'E_GRAPH_INVALID',
          message: `风控节点 ${n.id} 缺少 risk_rounds 条件边`,
          nodeId: n.id
        });
        continue;
      }
      const c = edge.condition as {
        kind: 'risk_rounds';
        maxRounds: number;
        order: string[];
        whenDone: string;
      };
      if (c.maxRounds !== settings.maxRiskRounds) {
        structuralIssues.push({
          code: 'E_VALIDATION',
          message: `edge ${edge.id} maxRounds 必须与 settings.maxRiskRounds 一致`,
          edgeId: edge.id
        });
      }
      const key = c.order.join('|');
      if (orderKey !== null && key !== orderKey) {
        structuralIssues.push({
          code: 'E_GRAPH_INVALID',
          message: '所有 risk_rounds 条件边必须使用相同的 order',
          edgeId: edge.id
        });
      }
      orderKey = key;
    }
  }
  if (structuralIssues.length > 0) return failIssues(structuralIssues);

  const startTargets = edges.filter((e) => e.source === '__start__');
  if (startTargets.length === 0) return fail('E_GRAPH_INVALID', '__start__ 没有指向任何节点');

  // 可达性：从 __start__ 出发，条件边的目标与 whenDone 都算可达。
  const outgoing = new Map<string, string[]>();
  for (const e of edges) {
    if (e.source === '__end__' || e.target === '__start__') continue;
    const list = outgoing.get(e.source) ?? [];
    list.push(e.target);
    outgoing.set(e.source, list);
    if (e.condition && e.condition.kind !== 'always') {
      list.push(e.condition.whenDone);
    }
  }
  const reached = new Set<string>();
  const queue: string[] = startTargets.map((e) => e.target);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === '__end__' || reached.has(cur)) continue;
    reached.add(cur);
    for (const next of outgoing.get(cur) ?? []) queue.push(next);
  }
  for (const n of nodes) {
    if (!reached.has(n.id)) {
      return fail('E_GRAPH_INVALID', `节点不可达: ${n.id}`, { nodeId: n.id });
    }
  }

  // 终端节点：除 __end__ 外没有出边，必须唯一且是 final。
  const sinks = nodes.filter(
    (n) => (outgoing.get(n.id) ?? []).filter((t) => t !== '__end__').length === 0
  );
  if (sinks.length !== 1 || sinks[0].type !== 'final') {
    return fail('E_GRAPH_INVALID', '必须以唯一的 final 节点作为终端', {
      nodeId: sinks.length > 1 ? sinks[1].id : sinks[0]?.id
    });
  }
  for (const e of edges.filter((x) => x.target === '__end__')) {
    if (nodeById.get(e.source)?.type !== 'final') {
      return fail('E_GRAPH_INVALID', '只有 final 可以指向 __end__', { edgeId: e.id });
    }
  }

  // P6：环检测覆盖静态边、条件边 target 与 whenDone，避免条件边绕过静态环检测。
  // 只有“纯条件回边”（辩论 bull↔bear、风控三节点环）允许成环。
  const cycleAdj = new Map<string, { to: string; edge: GraphEdgeSpec }[]>();
  const addCycleAdj = (from: string, to: string, edge: GraphEdgeSpec): void => {
    if (from === '__end__' || to === '__start__' || to === '__end__') return;
    const list = cycleAdj.get(from) ?? [];
    list.push({ to, edge });
    cycleAdj.set(from, list);
  };
  for (const e of edges) {
    addCycleAdj(e.source, e.target, e);
    if (e.condition && e.condition.kind !== 'always') {
      addCycleAdj(e.source, e.condition.whenDone, e);
    }
  }
  const color = new Map<string, 0 | 1 | 2>();
  const nodeStack: string[] = [];
  const edgeStack: GraphEdgeSpec[] = [];
  const illegalRef: { value: { edge: GraphEdgeSpec; cycle: string[] } | null } = { value: null };
  const visit = (id: string): void => {
    color.set(id, 1);
    nodeStack.push(id);
    for (const { to, edge } of cycleAdj.get(id) ?? []) {
      const state = color.get(to) ?? 0;
      if (state === 1) {
        const startIdx = Math.max(0, nodeStack.indexOf(to));
        const cycleNodes = nodeStack.slice(startIdx).concat(to);
        const cycleEdges = edgeStack.slice(startIdx).concat(edge);
        const staticEdge = cycleEdges.find((x) => !x.condition || x.condition.kind === 'always');
        if (staticEdge && illegalRef.value === null) {
          illegalRef.value = { edge: staticEdge, cycle: cycleNodes };
        }
      } else if (state === 0) {
        edgeStack.push(edge);
        visit(to);
        edgeStack.pop();
      }
    }
    nodeStack.pop();
    color.set(id, 2);
  };
  for (const n of nodes) {
    if ((color.get(n.id) ?? 0) === 0) visit(n.id);
  }
  if (illegalRef.value !== null) {
    return fail(
      'E_GRAPH_INVALID',
      `静态边或 whenDone 参与成环：${illegalRef.value.cycle.join(' → ')}（只有纯 debate_rounds / risk_rounds 条件回边允许成环）`,
      { edgeId: illegalRef.value.edge.id }
    );
  }

  // recursionLimit 必须覆盖辩论与风控轮次，再留运行余量（运行时还会再放大）。
  const minRecursion =
    nodes.length + 2 * settings.maxDebateRounds + 3 * settings.maxRiskRounds + 2;
  if (settings.recursionLimit < minRecursion) {
    return fail(
      'E_VALIDATION',
      `recursionLimit 需 >= 节点数 + 2×maxDebateRounds + 3×maxRiskRounds + 2（至少 ${minRecursion}）`
    );
  }

  const spec: GraphSpec = {
    specVersion: 1,
    id: raw.id,
    version: raw.version as number,
    name: raw.name,
    description: raw.description as string | undefined,
    createdAt: raw.createdAt as string,
    updatedAt: raw.updatedAt as string,
    nodes,
    edges,
    settings
  };
  return { ok: true, spec };
}

/** 运行绑定的 spec 摘要：对已验证/已持久化的 spec 做确定性 JSON 序列化后取 SHA-256。
 *  不 eval 任何图内字符串；摘要只用于绑定与比对，不参与执行。 */
export function digestGraphSpec(spec: GraphSpec): string {
  const payload = JSON.stringify({
    specVersion: spec.specVersion,
    id: spec.id,
    version: spec.version,
    name: spec.name,
    description: spec.description ?? '',
    nodes: spec.nodes,
    edges: spec.edges,
    settings: spec.settings
  });
  return createHash('sha256').update(payload).digest('hex');
}

/** 递归上限按图规模放大：节点数 ×（辩论轮数 + 1）+ 3×风控轮数 + 3 层余量，
 *  且不低于用户配置。LangGraph 的 recursionLimit 按 superstep 计。 */
export function computeRecursionLimit(spec: GraphSpec): number {
  const scaled =
    spec.nodes.length * (spec.settings.maxDebateRounds + 1) +
    3 * spec.settings.maxRiskRounds +
    3;
  return Math.min(200, Math.max(spec.settings.recursionLimit, scaled));
}

/** P3 默认图 v4：memory → evidence → bull↔bear → judge → planner → 三方风控 → final（审批挂起）。 */
export function defaultGraphSpec(now = new Date().toISOString()): GraphSpec {
  const riskOrder = ['risk_aggressive', 'risk_conservative', 'risk_neutral'];
  return {
    specVersion: 1,
    id: 'trend-analysis',
    version: 4,
    name: '世界趋势多智能体分析',
    description: 'P3：历史教训注入 → 综合取证 → 多空辩论 → 裁决 → 观察方案 → 三方风控 → 人工审批 → 最终结论',
    createdAt: now,
    updatedAt: now,
    nodes: [
      {
        id: 'memory',
        type: 'memory',
        label: '历史教训',
        position: { x: 40, y: 220 },
        config: { type: 'memory', lookbackDays: 90, maxLessons: 5 }
      },
      {
        id: 'evidence',
        type: 'evidence',
        label: '综合取证',
        position: { x: 280, y: 220 },
        config: { type: 'evidence', dimension: 'heat', topN: 10, windowDays: 7 }
      },
      {
        id: 'bull',
        type: 'bull',
        label: '多头研究员',
        position: { x: 520, y: 80 },
        joinMode: 'any',
        config: { type: 'bull', maxRounds: 2 }
      },
      {
        id: 'bear',
        type: 'bear',
        label: '空头研究员',
        position: { x: 520, y: 360 },
        joinMode: 'any',
        config: { type: 'bear', maxRounds: 2 }
      },
      {
        id: 'judge',
        type: 'judge',
        label: '裁决者',
        position: { x: 760, y: 220 },
        joinMode: 'all',
        config: { type: 'judge', requireDirection: true }
      },
      {
        id: 'planner',
        type: 'planner',
        label: '观察方案',
        position: { x: 1000, y: 220 },
        joinMode: 'all',
        config: { type: 'planner', maxTriggers: 4 }
      },
      {
        id: 'risk_aggressive',
        type: 'risk_aggressive',
        label: '激进风控',
        position: { x: 1240, y: 60 },
        joinMode: 'any',
        config: { type: 'risk_aggressive', maxRounds: 1 }
      },
      {
        id: 'risk_conservative',
        type: 'risk_conservative',
        label: '保守风控',
        position: { x: 1240, y: 220 },
        joinMode: 'any',
        config: { type: 'risk_conservative', maxRounds: 1 }
      },
      {
        id: 'risk_neutral',
        type: 'risk_neutral',
        label: '中性风控',
        position: { x: 1240, y: 380 },
        joinMode: 'any',
        config: { type: 'risk_neutral', maxRounds: 1 }
      },
      {
        id: 'final',
        type: 'final',
        label: '最终结论',
        position: { x: 1480, y: 220 },
        joinMode: 'all',
        config: { type: 'final', requireApproval: true }
      }
    ],
    edges: [
      { id: 'e-start-memory', source: '__start__', target: 'memory' },
      { id: 'e-memory-evidence', source: 'memory', target: 'evidence' },
      { id: 'e-evidence-bull', source: 'evidence', target: 'bull' },
      {
        id: 'e-bull-bear',
        source: 'bull',
        target: 'bear',
        condition: { kind: 'debate_rounds', maxRounds: 2, whenDone: 'judge' }
      },
      {
        id: 'e-bear-bull',
        source: 'bear',
        target: 'bull',
        condition: { kind: 'debate_rounds', maxRounds: 2, whenDone: 'judge' }
      },
      { id: 'e-judge-planner', source: 'judge', target: 'planner' },
      { id: 'e-planner-risk', source: 'planner', target: 'risk_aggressive' },
      {
        id: 'e-risk-agg-cons',
        source: 'risk_aggressive',
        target: 'risk_conservative',
        condition: { kind: 'risk_rounds', maxRounds: 1, order: riskOrder, whenDone: 'final' }
      },
      {
        id: 'e-risk-cons-neu',
        source: 'risk_conservative',
        target: 'risk_neutral',
        condition: { kind: 'risk_rounds', maxRounds: 1, order: riskOrder, whenDone: 'final' }
      },
      {
        id: 'e-risk-neu-agg',
        source: 'risk_neutral',
        target: 'risk_aggressive',
        condition: { kind: 'risk_rounds', maxRounds: 1, order: riskOrder, whenDone: 'final' }
      },
      { id: 'e-final-end', source: 'final', target: '__end__' }
    ],
    settings: {
      maxDebateRounds: 2,
      maxRiskRounds: 1,
      maxToolRounds: 0,
      recursionLimit: 40,
      nodeTimeoutMs: 90000,
      runTimeoutMs: 600000,
      maxCostUsd: 0.3,
      maxNodes: 32
    }
  };
}

/** M26 股票分析默认图 v1（独立 graph id，独立版本序列）。
 *  顺序按产品要求：历史记忆注入 → 行情取证 → 财报取证 → 公告取证 → 舆情取证
 *  → 涨因/跌因辩论 → 裁决 → 事实核查（数字闸门）→ 观察方案 → 三方风控 → 人工审批。
 *  世界趋势默认图（trend-analysis v4）不引用本函数，行为不变。 */
export function stockGraphSpec(now = new Date().toISOString()): GraphSpec {
  const riskOrder = ['risk_aggressive', 'risk_conservative', 'risk_neutral'];
  const evidenceNode = (
    id: string,
    label: string,
    dimension: 'market' | 'fundamentals' | 'disclosures' | 'news',
    x: number
  ): GraphNodeSpec => ({
    id,
    type: 'evidence',
    label,
    position: { x, y: 220 },
    config: { type: 'evidence', dimension, topN: 10, windowDays: 30 }
  });
  return {
    specVersion: 1,
    id: 'stock-analysis',
    version: 1,
    name: '股票 AI 分析',
    description: '行情/财报/公告/舆情取证 → 涨因跌因辩论 → 裁决 → 事实核查（数字闸门）→ 观察方案 → 三方风控 → 审批',
    createdAt: now,
    updatedAt: now,
    nodes: [
      {
        id: 'memory',
        type: 'memory',
        label: '历史教训',
        position: { x: 40, y: 220 },
        config: { type: 'memory', lookbackDays: 180, maxLessons: 5 }
      },
      evidenceNode('market', '行情取证', 'market', 260),
      evidenceNode('fundamentals', '财报取证', 'fundamentals', 460),
      evidenceNode('disclosures', '公告取证', 'disclosures', 660),
      evidenceNode('news', '舆情取证', 'news', 860),
      {
        id: 'bull',
        type: 'bull',
        label: '涨因研究员',
        position: { x: 1080, y: 80 },
        joinMode: 'any',
        config: { type: 'bull', maxRounds: 1 }
      },
      {
        id: 'bear',
        type: 'bear',
        label: '跌因研究员',
        position: { x: 1080, y: 360 },
        joinMode: 'any',
        config: { type: 'bear', maxRounds: 1 }
      },
      {
        id: 'judge',
        type: 'judge',
        label: '裁决者',
        position: { x: 1300, y: 220 },
        joinMode: 'any',
        config: { type: 'judge', requireDirection: true }
      },
      {
        id: 'fact_check',
        type: 'fact_check',
        label: '事实核查（数字闸门）',
        position: { x: 1520, y: 220 },
        joinMode: 'all',
        config: { type: 'fact_check', toleranceBps: 50 }
      },
      {
        id: 'planner',
        type: 'planner',
        label: '观察方案',
        position: { x: 1740, y: 220 },
        joinMode: 'all',
        config: { type: 'planner', maxTriggers: 4 }
      },
      {
        id: 'risk_aggressive',
        type: 'risk_aggressive',
        label: '激进风控',
        position: { x: 1960, y: 60 },
        joinMode: 'any',
        config: { type: 'risk_aggressive', maxRounds: 1 }
      },
      {
        id: 'risk_conservative',
        type: 'risk_conservative',
        label: '保守风控',
        position: { x: 1960, y: 220 },
        joinMode: 'any',
        config: { type: 'risk_conservative', maxRounds: 1 }
      },
      {
        id: 'risk_neutral',
        type: 'risk_neutral',
        label: '中性风控',
        position: { x: 1960, y: 380 },
        joinMode: 'any',
        config: { type: 'risk_neutral', maxRounds: 1 }
      },
      {
        id: 'final',
        type: 'final',
        label: '最终结论',
        position: { x: 2200, y: 220 },
        joinMode: 'all',
        config: { type: 'final', requireApproval: true }
      }
    ],
    edges: [
      { id: 'e-start-memory', source: '__start__', target: 'memory' },
      { id: 'e-memory-market', source: 'memory', target: 'market' },
      { id: 'e-market-fundamentals', source: 'market', target: 'fundamentals' },
      { id: 'e-fundamentals-disclosures', source: 'fundamentals', target: 'disclosures' },
      { id: 'e-disclosures-news', source: 'disclosures', target: 'news' },
      { id: 'e-news-bull', source: 'news', target: 'bull' },
      {
        id: 'e-bull-bear',
        source: 'bull',
        target: 'bear',
        condition: { kind: 'debate_rounds', maxRounds: 1, whenDone: 'judge' }
      },
      {
        id: 'e-bear-bull',
        source: 'bear',
        target: 'bull',
        condition: { kind: 'debate_rounds', maxRounds: 1, whenDone: 'judge' }
      },
      { id: 'e-judge-fact-check', source: 'judge', target: 'fact_check' },
      { id: 'e-fact-check-planner', source: 'fact_check', target: 'planner' },
      { id: 'e-planner-risk', source: 'planner', target: 'risk_aggressive' },
      {
        id: 'e-risk-agg-cons',
        source: 'risk_aggressive',
        target: 'risk_conservative',
        condition: { kind: 'risk_rounds', maxRounds: 1, order: riskOrder, whenDone: 'final' }
      },
      {
        id: 'e-risk-cons-neu',
        source: 'risk_conservative',
        target: 'risk_neutral',
        condition: { kind: 'risk_rounds', maxRounds: 1, order: riskOrder, whenDone: 'final' }
      },
      {
        id: 'e-risk-neu-agg',
        source: 'risk_neutral',
        target: 'risk_aggressive',
        condition: { kind: 'risk_rounds', maxRounds: 1, order: riskOrder, whenDone: 'final' }
      },
      { id: 'e-final-end', source: 'final', target: '__end__' }
    ],
    settings: {
      maxDebateRounds: 1,
      maxRiskRounds: 1,
      maxToolRounds: 0,
      recursionLimit: 40,
      nodeTimeoutMs: 90000,
      runTimeoutMs: 600000,
      maxCostUsd: 0.3,
      maxNodes: 32
    }
  };
}
