import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { MockProvider } from '../electron/main/ai/provider.js';
import { AgentRuntime } from '../electron/main/agent/runtime.js';
import { defaultGraphSpec, validateGraphSpec } from '../electron/main/agent/spec.js';
import { edgeRouteLabel, type AgentIpcResponse, type GraphSpec, type RunEventEnvelope } from '../shared/agent.js';

const NOW = '2026-11-03T10:00:00.000Z';
const SUBJECT = { key: 'topic:China', label: 'China', kind: 'topic' as const };

let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs();
});

function newDb(): Database {
  const db = new SQL.Database();
  migrate(db);
  return db;
}

function clone(): GraphSpec {
  return JSON.parse(JSON.stringify(defaultGraphSpec(NOW))) as GraphSpec;
}

function expectOk<T>(res: AgentIpcResponse<T>): T {
  if (!res.ok) throw new Error(`expected ok, got ${res.code}: ${res.message}`);
  return res.data;
}

function makeRuntime(db: Database, send?: (e: RunEventEnvelope) => void): AgentRuntime {
  return new AgentRuntime({
    db,
    provider: new MockProvider(),
    mockProvider: new MockProvider(),
    persist: () => {},
    send,
    now: () => NOW
  });
}

describe('条件边校验：白名单、三方一致、环检测与定位', () => {
  it('默认图仍是合法的纯条件回边（debate/risk 环允许）', () => {
    const res = validateGraphSpec(defaultGraphSpec(NOW));
    expect(res.ok).toBe(true);
  });

  it('拒绝自由表达式与未知条件字段，issue 带 edgeId', () => {
    const expr = clone();
    const bullEdge = expr.edges.find((e) => e.source === 'bull')!;
    (bullEdge as unknown as Record<string, unknown>).condition = {
      kind: 'expr',
      expr: 'debate_rounds > 1',
      whenDone: 'judge'
    };
    const res = validateGraphSpec(expr);
    expect(!res.ok && res.code).toBe('E_GRAPH_INVALID');
    if (!res.ok) {
      expect(res.issues[0].edgeId).toBe('e-bull-bear');
      expect(res.issues[0].message).toContain('未知条件边类型');
    }

    const extraField = clone();
    const edge2 = extraField.edges.find((e) => e.source === 'bull')!;
    (edge2.condition as unknown as Record<string, unknown>).expr = 'rounds > 1';
    const res2 = validateGraphSpec(extraField);
    expect(!res2.ok && res2.code).toBe('E_VALIDATION');
    if (!res2.ok) {
      expect(res2.issues[0].edgeId).toBe('e-bull-bear');
      expect(res2.issues[0].message).toContain('未知字段');
    }
  });

  it('拒绝非法目标、非白名单源与不存在的 whenDone（均带 edgeId）', () => {
    const badTarget = clone();
    const bullEdge = badTarget.edges.find((e) => e.source === 'bull')!;
    bullEdge.target = 'evidence';
    const res = validateGraphSpec(badTarget);
    expect(!res.ok && res.code).toBe('E_GRAPH_INVALID');
    if (!res.ok) {
      expect(res.issues[0].edgeId).toBe('e-bull-bear');
      expect(res.issues[0].message).toContain('对立方');
    }

    const badSource = clone();
    const memEdge = badSource.edges.find((e) => e.source === 'memory')!;
    memEdge.condition = { kind: 'debate_rounds', maxRounds: 2, whenDone: 'judge' };
    const res2 = validateGraphSpec(badSource);
    expect(!res2.ok && res2.code).toBe('E_GRAPH_INVALID');
    if (!res2.ok) {
      expect(res2.issues[0].edgeId).toBe('e-memory-evidence');
      expect(res2.issues[0].message).toContain('只能来自 bull/bear');
    }

    const badDone = clone();
    const edge = badDone.edges.find((e) => e.source === 'bull')!;
    (edge.condition as { whenDone: string }).whenDone = 'ghost';
    const res3 = validateGraphSpec(badDone);
    expect(!res3.ok && res3.code).toBe('E_GRAPH_INVALID');
    if (!res3.ok) expect(res3.issues[0].edgeId).toBe('e-bull-bear');

    const riskDone = clone();
    const riskEdge = riskDone.edges.find((e) => e.condition?.kind === 'risk_rounds')!;
    (riskEdge.condition as { whenDone: string }).whenDone = 'judge';
    const res4 = validateGraphSpec(riskDone);
    expect(!res4.ok && res4.code).toBe('E_GRAPH_INVALID');
    if (!res4.ok) {
      expect(res4.issues[0].edgeId).toBe(riskEdge.id);
      expect(res4.issues[0].message).toContain('planner 或 final');
    }
  });

  it('拒绝重复条件边（指向同一对节点），带 edgeId', () => {
    const dup = clone();
    dup.edges.push({
      id: 'e-dup-bull-bear',
      source: 'bull',
      target: 'bear',
      condition: { kind: 'debate_rounds', maxRounds: 2, whenDone: 'judge' }
    });
    const res = validateGraphSpec(dup);
    expect(!res.ok && res.code).toBe('E_GRAPH_INVALID');
    if (!res.ok) {
      expect(res.issues.some((i) => i.edgeId === 'e-dup-bull-bear')).toBe(true);
      expect(res.issues.find((i) => i.edgeId === 'e-dup-bull-bear')?.message).toContain('重复边');
    }
  });

  it('轮数三方不一致一次收集多条：nodeId 与 edgeId 同时可定位', () => {
    const mismatch = clone();
    // settings 2，节点 1，条件边 1：node vs settings、edge vs settings 都应报出。
    for (const n of mismatch.nodes.filter((x) => x.type === 'bull' || x.type === 'bear')) {
      (n.config as { maxRounds: number }).maxRounds = 1;
    }
    for (const e of mismatch.edges) {
      if (e.condition?.kind === 'debate_rounds') e.condition.maxRounds = 1;
    }
    const res = validateGraphSpec(mismatch);
    expect(!res.ok && res.code).toBe('E_VALIDATION');
    if (!res.ok) {
      expect(res.issues.length).toBeGreaterThanOrEqual(4);
      const nodeIssues = res.issues.filter((i) => i.nodeId);
      const edgeIssues = res.issues.filter((i) => i.edgeId);
      expect(nodeIssues.map((i) => i.nodeId).sort()).toEqual(['bear', 'bull']);
      expect(edgeIssues.map((i) => i.edgeId).sort()).toEqual(['e-bear-bull', 'e-bull-bear']);
      expect(res.issues.every((i) => i.message.includes('maxRounds'))).toBe(true);
    }
  });

  it('静态边或 whenDone 参与成环一律拒绝（条件回边不能绕过环检测）', () => {
    const staticCycle = clone();
    staticCycle.edges.push({ id: 'e-cycle', source: 'judge', target: 'evidence' });
    const res = validateGraphSpec(staticCycle);
    expect(!res.ok && res.code).toBe('E_GRAPH_INVALID');

    const whenDoneCycle = clone();
    const riskEdge = whenDoneCycle.edges.find((e) => e.condition?.kind === 'risk_rounds')!;
    (riskEdge.condition as { whenDone: string }).whenDone = 'planner';
    const res2 = validateGraphSpec(whenDoneCycle);
    expect(!res2.ok && res2.code).toBe('E_GRAPH_INVALID');
    if (!res2.ok) {
      expect(res2.issues[0].edgeId).toBe('e-planner-risk');
      expect(res2.issues[0].message).toContain('成环');
    }
  });

  it('人类可读路由标签随条件字段解释一致', () => {
    const spec = defaultGraphSpec(NOW);
    const debate = spec.edges.find((e) => e.id === 'e-bull-bear')!;
    const risk = spec.edges.find((e) => e.id === 'e-risk-agg-cons')!;
    expect(edgeRouteLabel(debate)).toContain('辩论：第 2 轮后');
    expect(edgeRouteLabel(debate)).toContain('judge');
    expect(edgeRouteLabel(risk)).toContain('风控：第 1 轮后');
    expect(edgeRouteLabel(risk)).toContain('final');
    expect(edgeRouteLabel({ id: 'e', source: 'a', target: 'b' })).toBeNull();
  });
});

describe('自定义条件边：保存→编译→Mock 真实跑通', () => {
  it('自定义 edgeId 保存后运行，route.taken 指向该 edgeId', async () => {
    const db = newDb();
    const sent: RunEventEnvelope[] = [];
    const runtime = makeRuntime(db, (e) => sent.push(e));
    runtime.ensureDefaultGraph(defaultGraphSpec(NOW));

    const custom = clone();
    // 用户重建条件边：保留条件语义，换成自定义稳定 edgeId。
    for (const e of custom.edges) {
      if (e.id === 'e-bull-bear') e.id = 'e-custom-bull-bear';
      if (e.id === 'e-bear-bull') e.id = 'e-custom-bear-bull';
    }
    const saved = expectOk(runtime.saveGraph({ spec: custom, publish: true }));
    expect(saved.version).toBe(5);
    expect(saved.spec.edges.map((e) => e.id)).toContain('e-custom-bull-bear');

    const started = expectOk(
      await runtime.startRun({
        graphId: 'trend-analysis',
        subject: SUBJECT,
        asOf: NOW,
        options: { forceMock: true }
      })
    );
    await runtime.waitForRun(started.runId);

    const page = expectOk(runtime.getEvents({ runId: started.runId, afterSeq: 0 }));
    const routes = page.events.filter(
      (e): e is RunEventEnvelope & { event: Extract<RunEventEnvelope['event'], { type: 'route.taken' }> } =>
        e.event.type === 'route.taken'
    );
    const bullRoute = routes.find((e) => e.event.from === 'bull');
    const bearRoute = routes.find((e) => e.event.from === 'bear');
    expect(bullRoute?.event.edgeId).toBe('e-custom-bull-bear');
    expect(bearRoute?.event.edgeId).toBe('e-custom-bear-bull');
    expect(bullRoute?.event.condition).toContain('辩论：第 2 轮后');
    expect(bullRoute?.event.to).toBe('bear');

    // 运行进入审批挂起，说明自定义条件边真实驱动了辩论路由，而不只是保存通过。
    const detail = expectOk(runtime.getRun(started.runId));
    expect(detail.status).toBe('interrupted');
    expect(sent.map((e) => e.seq)).toEqual(page.events.map((e) => e.seq));
    db.close();
  });
});
