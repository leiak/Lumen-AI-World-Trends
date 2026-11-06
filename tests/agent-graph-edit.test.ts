import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { MockProvider, type AiProvider } from '../electron/main/ai/provider.js';
import { AgentRuntime } from '../electron/main/agent/runtime.js';
import { defaultGraphSpec } from '../electron/main/agent/spec.js';
import type {
  AgentGraphGetResponse,
  AgentGraphSaveResponse,
  AgentGraphVersionSummary,
  AgentIpcResponse,
  AgentRunDetail,
  GraphSpec,
  RunEventEnvelope,
  StartRunRequest
} from '../shared/agent.js';

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

function expectOk<T>(res: AgentIpcResponse<T>): T {
  if (!res.ok) throw new Error(`expected ok, got ${res.code}: ${res.message}`);
  return res.data;
}

type SaveIssues = { issues?: Array<{ code: string; message: string; nodeId?: string; edgeId?: string }> };

function makeRuntime(
  db: Database,
  opts?: { ids?: string[]; send?: (e: RunEventEnvelope) => void }
): AgentRuntime {
  let i = 0;
  const provider: AiProvider = new MockProvider();
  return new AgentRuntime({
    db,
    provider,
    mockProvider: new MockProvider(),
    persist: () => {},
    send: opts?.send,
    now: () => NOW,
    newRunId: () => {
      const fixed = opts?.ids?.[i];
      i += 1;
      return fixed ?? `run_edit_${i}`;
    }
  });
}

/** 不含 memory / planner / risk 的最小合法图，用于验证自定义图保存与跑通。 */
function minimalSpec(label = '自定义取证'): GraphSpec {
  const at = NOW;
  return {
    specVersion: 1,
    id: 'trend-analysis',
    version: 1,
    name: 'P4 自定义最小图',
    description: 'custom minimal',
    createdAt: at,
    updatedAt: at,
    nodes: [
      {
        id: 'evidence',
        type: 'evidence',
        label,
        position: { x: 0, y: 0 },
        config: { type: 'evidence', dimension: 'sentiment', topN: 8, windowDays: 5 }
      },
      {
        id: 'bull',
        type: 'bull',
        label: '看多',
        position: { x: 220, y: -80 },
        joinMode: 'any',
        config: { type: 'bull', maxRounds: 1 }
      },
      {
        id: 'bear',
        type: 'bear',
        label: '看空',
        position: { x: 220, y: 80 },
        joinMode: 'any',
        config: { type: 'bear', maxRounds: 1 }
      },
      {
        id: 'judge',
        type: 'judge',
        label: '裁决',
        position: { x: 440, y: 0 },
        joinMode: 'all',
        config: { type: 'judge', requireDirection: true }
      },
      {
        id: 'final',
        type: 'final',
        label: '最终结论',
        position: { x: 660, y: 0 },
        joinMode: 'all',
        config: { type: 'final', requireApproval: true }
      }
    ],
    edges: [
      { id: 'e-start-evidence', source: '__start__', target: 'evidence' },
      { id: 'e-evidence-bull', source: 'evidence', target: 'bull' },
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
      { id: 'e-judge-final', source: 'judge', target: 'final' },
      { id: 'e-final-end', source: 'final', target: '__end__' }
    ],
    settings: {
      maxDebateRounds: 1,
      maxRiskRounds: 1,
      maxToolRounds: 0,
      recursionLimit: 20,
      nodeTimeoutMs: 90000,
      runTimeoutMs: 600000,
      maxCostUsd: 0.3,
      maxNodes: 32
    }
  };
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function request(overrides?: Partial<StartRunRequest>): StartRunRequest {
  return {
    graphId: 'trend-analysis',
    subject: SUBJECT,
    asOf: NOW,
    options: { forceMock: true },
    ...overrides
  };
}

function issuesOf(res: AgentIpcResponse<unknown>): SaveIssues {
  return (res.ok ? {} : (res.details as SaveIssues | undefined)) ?? {};
}

describe('P4 图编辑：持久化与校验定位', () => {
  it('默认图 v4 可列出，active/published/digest 一致', () => {
    const db = newDb();
    const runtime = makeRuntime(db);
    runtime.ensureDefaultGraph(defaultGraphSpec(NOW));
    const list = expectOk(runtime.listGraphs());
    expect(list).toHaveLength(1);
    const v4 = list[0];
    expect(v4.version).toBe(4);
    expect(v4.isActive).toBe(true);
    expect(v4.status).toBe('published');
    expect(v4.digest).toMatch(/^[0-9a-f]{64}$/);

    const view = expectOk(runtime.getGraphView({ graphId: 'trend-analysis' }));
    expect(view.spec.version).toBe(4);
    expect(view.digest).toBe(v4.digest);
    expect(view.isActive).toBe(true);
  });

  it('非法图保存被拒，并定位到节点/边', () => {
    const db = newDb();
    const runtime = makeRuntime(db);
    runtime.ensureDefaultGraph(defaultGraphSpec(NOW));

    // 1) 未知节点类型
    const unknown = clone(minimalSpec());
    unknown.nodes.push({
      id: 'weird',
      type: 'unknown_type' as never,
      label: '未知',
      position: { x: 100, y: 100 },
      config: { type: 'unknown_type' } as never
    });
    const r1 = runtime.saveGraph({ spec: unknown });
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.code).toBe('E_NODE_TYPE_UNKNOWN');
      expect(issuesOf(r1).issues?.[0]?.nodeId).toBe('weird');
    }

    // 2) 缺 judge：删除 judge 节点/边，留下 bull/bear 无出边
    const noJudge = clone(minimalSpec());
    noJudge.nodes = noJudge.nodes.filter((n) => n.id !== 'judge');
    noJudge.edges = noJudge.edges.filter(
      (e) => e.source !== 'judge' && e.target !== 'judge' && e.id !== 'e-judge-final'
    );
    const r2 = runtime.saveGraph({ spec: noJudge });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('E_GRAPH_INVALID');

    // 3) 多余终端：新增第二个 final
    const extraFinal = clone(minimalSpec());
    extraFinal.nodes.push({
      id: 'final2',
      type: 'final',
      label: '第二个终端',
      position: { x: 800, y: 100 },
      joinMode: 'all',
      config: { type: 'final', requireApproval: true }
    });
    extraFinal.edges.push({ id: 'e-judge-final2', source: 'judge', target: 'final2' });
    const r3 = runtime.saveGraph({ spec: extraFinal });
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      expect(r3.code).toBe('E_GRAPH_INVALID');
      expect(issuesOf(r3).issues?.[0]?.nodeId).toBe('final2');
    }

    // 4) 非法参数字段
    const badField = clone(minimalSpec());
    const ev = badField.nodes.find((n) => n.id === 'evidence')!;
    (ev.config as unknown as Record<string, unknown>).evil = 'eval(...)';
    const r4 = runtime.saveGraph({ spec: badField });
    expect(r4.ok).toBe(false);
    if (!r4.ok) {
      expect(r4.code).toBe('E_VALIDATION');
      expect(issuesOf(r4).issues?.[0]?.nodeId).toBe('evidence');
    }

    // 5) 非法 whenDone
    const badDone = clone(minimalSpec());
    const edge = badDone.edges.find((e) => e.id === 'e-bull-bear')!;
    (edge.condition as unknown as { whenDone: string }).whenDone = 'nope';
    const r5 = runtime.saveGraph({ spec: badDone });
    expect(r5.ok).toBe(false);
    if (!r5.ok) {
      expect(r5.code).toBe('E_GRAPH_INVALID');
      expect(issuesOf(r5).issues?.[0]?.edgeId).toBe('e-bull-bear');
    }
  });

  it('合法自定义图可保存、可编译并实际跑通；run 绑定版本与摘要', async () => {
    const db = newDb();
    const runtime = makeRuntime(db, { ids: ['run_custom_1'] });
    runtime.ensureDefaultGraph(defaultGraphSpec(NOW));

    const saved = expectOk(runtime.saveGraph({ spec: minimalSpec() }));
    expect(saved.version).toBe(5);
    expect(saved.status).toBe('published');
    expect(saved.isActive).toBe(true);
    expect(saved.digest).toMatch(/^[0-9a-f]{64}$/);

    const started = expectOk(
      await runtime.startRun(request({ graphVersion: saved.version, expectedDigest: saved.digest }))
    );
    expect(started.graphVersion).toBe(5);
    expect(started.graphDigest).toBe(saved.digest);

    await runtime.waitForRun(started.runId);
    const paused = expectOk(runtime.getRun(started.runId));
    expect(paused.status).toBe('interrupted');
    expect(paused.graphVersion).toBe(5);
    expect(paused.graphDigest).toBe(saved.digest);
    expect(paused.graphName).toBe('P4 自定义最小图');

    expectOk(await runtime.resumeRun({ runId: started.runId, resolution: { type: 'approve' } }));
    await runtime.waitForRun(started.runId);

    const detail = expectOk(runtime.getRun(started.runId));
    expect(detail.status).toBe('completed');
    // evidence 1 + bull 1 + bear 1 + judge 1 + final 2（含 skipped）= 6
    expect(detail.nodes).toHaveLength(6);
    expect(detail.nodes.filter((n) => n.nodeId === 'judge')).toHaveLength(1);
  });

  it('改图不串味：旧 run 仍显示原图与原有节点结果；按摘要拒绝旧图启动', async () => {
    const db = newDb();
    const runtime = makeRuntime(db, { ids: ['run_hist_1'] });
    runtime.ensureDefaultGraph(defaultGraphSpec(NOW));

    const v5 = expectOk(runtime.saveGraph({ spec: minimalSpec('原图取证') }));
    const started = expectOk(await runtime.startRun(request({ graphVersion: v5.version })));
    await runtime.waitForRun(started.runId);
    const paused = expectOk(runtime.getRun(started.runId));
    expect(paused.nodes.find((n) => n.nodeId === 'evidence')?.status).toBe('succeeded');

    // 保存新版本 v6，改动 evidence label/topN
    const changed = clone(minimalSpec('新图取证'));
    const ev = changed.nodes.find((n) => n.id === 'evidence')!;
    (ev.config as { topN: number }).topN = 20;
    const v6 = expectOk(runtime.saveGraph({ spec: changed }));
    expect(v6.version).toBe(6);
    expect(v6.digest).not.toBe(v5.digest);

    const oldRun = expectOk(runtime.getRun(started.runId));
    expect(oldRun.graphVersion).toBe(5);
    expect(oldRun.graphDigest).toBe(v5.digest);
    const oldEvidenceResult = oldRun.nodes.find((n) => n.nodeId === 'evidence');
    expect(oldEvidenceResult?.status).toBe('succeeded');
    expect(oldEvidenceResult?.output).toBeTruthy();

    const oldView = expectOk(runtime.getGraphView({ graphId: 'trend-analysis', version: 5 }));
    const oldEvidence = oldView.spec.nodes.find((n) => n.id === 'evidence')!;
    expect(oldEvidence.label).toBe('原图取证');
    expect((oldEvidence.config as { topN: number }).topN).toBe(8);
    expect(oldView.digest).toBe(v5.digest);

    const newView = expectOk(runtime.getGraphView({ graphId: 'trend-analysis' }));
    expect(newView.spec.version).toBe(6);
    expect(newView.digest).toBe(v6.digest);

    // 编辑器持有 v5 摘要但未指定版本 → 解析到 active v6 后摘要不匹配，拒绝悄悄用旧图。
    const stale = await runtime.startRun(request({ expectedDigest: v5.digest }));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('E_VALIDATION');

    // 显式指定 v5 + 对应摘要仍可复现历史图（版本绑定以显式版本为准）。
    const explicit = expectOk(
      await runtime.startRun(request({ graphVersion: 5, expectedDigest: v5.digest }))
    );
    expect(explicit.graphVersion).toBe(5);
    await runtime.waitForRun(explicit.runId);
    expectOk(await runtime.resumeRun({ runId: explicit.runId, resolution: { type: 'approve' } }));
    await runtime.waitForRun(explicit.runId);

    const missing = await runtime.startRun(request({ graphVersion: 99 }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('E_GRAPH_NOT_FOUND');
  }, 20000);

  it('草稿不参与 active；被 run 使用的版本不可删除；恢复默认 v4 与默认图完全一致', async () => {
    const db = newDb();
    const runtime = makeRuntime(db, { ids: ['run_restore_1'] });
    runtime.ensureDefaultGraph(defaultGraphSpec(NOW));

    // 草稿：published=false，active 仍是 v4
    const draft = expectOk(runtime.saveGraph({ spec: minimalSpec('草稿'), publish: false }));
    expect(draft.version).toBe(5);
    expect(draft.status).toBe('draft');
    expect(draft.isActive).toBe(false);
    const activeBefore = expectOk(runtime.getGraphView({ graphId: 'trend-analysis' }));
    expect(activeBefore.spec.version).toBe(4);

    // 发布 v6（v5 草稿仍在列表）
    const v6 = expectOk(runtime.saveGraph({ spec: minimalSpec('发布版'), publish: true }));
    expect(v6.version).toBe(6);
    const listBefore = expectOk(runtime.listGraphs());
    const draftRow = listBefore.find((g) => g.version === 5) as AgentGraphVersionSummary;
    expect(draftRow.status).toBe('draft');

    // 跑 v6 后，v6 不允许删除
    const started = expectOk(await runtime.startRun(request({ graphVersion: 6 })));
    await runtime.waitForRun(started.runId);
    expectOk(await runtime.resumeRun({ runId: started.runId, resolution: { type: 'approve' } }));
    await runtime.waitForRun(started.runId);

    const delUsed = runtime.deleteGraph({ graphId: 'trend-analysis', version: 6 });
    expect(delUsed.ok).toBe(false);
    if (!delUsed.ok) expect(delUsed.code).toBe('E_GRAPH_INVALID');

    // 未使用的草稿 v5 可删除
    const delDraft = expectOk(runtime.deleteGraph({ graphId: 'trend-analysis', version: 5 }));
    expect(delDraft.deleted).toBe(true);

    // 恢复默认：v4 成为 active，节点/边/参数/recursionLimit 与默认图完全一致
    const restored = expectOk(runtime.restoreDefaultGraph('trend-analysis'));
    expect(restored.version).toBe(4);
    expect(restored.isActive).toBe(true);
    const canonical = defaultGraphSpec(NOW);
    expect(restored.spec.nodes).toEqual(canonical.nodes);
    expect(restored.spec.edges).toEqual(canonical.edges);
    expect(restored.spec.settings).toEqual(canonical.settings);
    expect(restored.spec.settings.recursionLimit).toBe(defaultGraphSpec(NOW).settings.recursionLimit);

    // 旧的 v6 运行详情仍显示 v6，未串味
    const detail: AgentRunDetail = expectOk(runtime.getRun(started.runId));
    expect(detail.graphVersion).toBe(6);
    expect(detail.graphDigest).toBe(v6.digest);
    expect(detail.graphName).toBe('P4 自定义最小图');

    // 恢复默认后列表仍保留历史版本，但只有 v4 active
    const listAfter = expectOk(runtime.listGraphs());
    expect(listAfter.find((g) => g.version === 4)?.isActive).toBe(true);
    expect(listAfter.find((g) => g.version === 6)?.isActive).toBe(false);
  }, 20000);
});
