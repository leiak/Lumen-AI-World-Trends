import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import initSqlJs, { type Database } from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { openDatabase, saveDatabase } from '../electron/main/db/connection.js';
import { MockProvider, type AiProvider, type ChatMessage } from '../electron/main/ai/provider.js';
import { AgentRuntime } from '../electron/main/agent/runtime.js';
import { createAgentRepository } from '../electron/main/agent/repository.js';
import { defaultGraphSpec } from '../electron/main/agent/spec.js';
import { settleDueMemory } from '../electron/main/agent/memory.js';
import { compileAgentGraph } from '../electron/main/agent/graph.js';
import { extractAgentError } from '../electron/main/agent/errors.js';
import type {
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

function makeRuntime(
  db: Database,
  provider: AiProvider,
  opts?: { persist?: () => void; send?: (e: RunEventEnvelope) => void; ids?: string[]; now?: () => string }
): AgentRuntime {
  let i = 0;
  return new AgentRuntime({
    db,
    provider,
    mockProvider: new MockProvider(),
    persist: opts?.persist ?? (() => {}),
    send: opts?.send,
    now: opts?.now ?? (() => NOW),
    newRunId: () => {
      const fixed = opts?.ids?.[i];
      i += 1;
      return fixed ?? `run_test_${i}`;
    }
  });
}

/** 每次取时间 +1s，便于断言“发言时间来自该节点尝试、结束不早于开始”。 */
function tickingClock(startIso = NOW): () => string {
  let t = new Date(startIso).getTime();
  return () => new Date((t += 1000)).toISOString();
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

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('agent runtime', () => {
  it('Mock 完整链路：辩论→裁决→风控→planner→审批挂起→resume→final，未重跑已完成节点', async () => {
    const db = newDb();
    const sent: RunEventEnvelope[] = [];
    const runtime = makeRuntime(db, new MockProvider(), { send: (e) => sent.push(e) });
    runtime.ensureDefaultGraph(defaultGraphSpec(NOW));

    const started = expectOk(await runtime.startRun(request()));
    await runtime.waitForRun(started.runId);

    const paused = expectOk(runtime.getRun(started.runId));
    expect(paused.status).toBe('interrupted');
    expect(paused.approval?.stage).toBe('final_approval');
    expect(paused.approval?.decision?.rating).toBe('up');
    const pausedPage = expectOk(runtime.getEvents({ runId: started.runId, afterSeq: 0 }));
    expect(pausedPage.events.some((e) => e.event.type === 'run.interrupted')).toBe(true);
    // final 首次尝试被标为 skipped，等待审批。
    const finalSkipped = paused.nodes.filter((n) => n.nodeId === 'final');
    expect(finalSkipped).toHaveLength(1);
    expect(finalSkipped[0].status).toBe('skipped');
    expect(finalSkipped[0].attempt).toBe(1);

    const resumed = expectOk(
      await runtime.resumeRun({ runId: started.runId, resolution: { type: 'approve' } })
    );
    expect(resumed.status).toBe('running');
    await runtime.waitForRun(started.runId);

    const detail = expectOk(runtime.getRun(started.runId));
    expect(detail.status).toBe('completed');
    // memory 1 + evidence 1 + bull 2 + bear 2 + judge 1 + planner 1 + risk 3 + final 2（含 skipped）= 13 行。
    expect(detail.nodes).toHaveLength(13);
    expect(detail.nodes.filter((n) => n.status === 'succeeded')).toHaveLength(12);
    expect(detail.nodes.filter((n) => n.status === 'skipped')).toHaveLength(1);
    expect(detail.nodes.every((n) => typeof n.elapsedMs === 'number')).toBe(true);
    const memoryNode = detail.nodes.find((n) => n.nodeId === 'memory');
    expect(memoryNode?.status).toBe('succeeded');
    expect(typeof memoryNode?.output?.context).toBe('string');
    expect(memoryNode?.output?.lessonCount).toBe(0);
    expect(detail.decision?.rating).toBe('up');
    expect(detail.decision?.reviewRequired).toBe(false);
    expect(detail.rating).toBe('up');

    const page = expectOk(runtime.getEvents({ runId: started.runId, afterSeq: 0 }));
    expect(page.events.length).toBeGreaterThan(0);
    const seqs = page.events.map((e) => e.seq);
    expect(seqs[0]).toBe(1);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1] + 1);
    expect(page.nextSeq).toBe(seqs[seqs.length - 1]);
    expect(page.events.some((e) => e.event.type === 'run.resumed')).toBe(true);
    expect(page.events.some((e) => e.event.type === 'run.completed')).toBe(true);

    // resume 后只重跑 final：其他节点的 node.started 次数不变。
    const countStarted = (events: RunEventEnvelope[], id: string) =>
      events.filter((e) => e.event.type === 'node.started' && e.event.nodeId === id).length;
    for (const id of ['evidence', 'bull', 'bear', 'judge', 'planner', 'risk_aggressive', 'risk_conservative', 'risk_neutral']) {
      expect(countStarted(page.events, id)).toBe(countStarted(pausedPage.events, id));
    }
    expect(countStarted(page.events, 'final')).toBe(2);

    // afterSeq 跨 interrupt/resume 仍然单调补拉。
    const tail = expectOk(runtime.getEvents({ runId: started.runId, afterSeq: pausedPage.nextSeq }));
    expect(tail.events.every((e) => e.seq > pausedPage.nextSeq)).toBe(true);
    expect(tail.nextSeq).toBe(page.nextSeq);
    expect(sent.map((e) => e.seq)).toEqual(seqs);
    db.close();
  });

  it('Mock 2 轮辩论：交替 4 次、judge 拿到完整历史、按计数终止且 afterSeq 补拉正确', async () => {
    const db = newDb();
    const prompts: ChatMessage[][] = [];
    const recording: AiProvider = {
      name: 'mock',
      async generate(messages: ChatMessage[]) {
        prompts.push(messages);
        return new MockProvider().generate(messages);
      }
    };
    const runtime = makeRuntime(db, recording, { now: tickingClock() });
    runtime.ensureDefaultGraph(defaultGraphSpec(NOW));

    const started = expectOk(await runtime.startRun(request({ options: { forceMock: false } })));
    await runtime.waitForRun(started.runId);

    const page = expectOk(runtime.getEvents({ runId: started.runId, afterSeq: 0 }));
    const debate = page.events.filter((e) => e.event.type === 'debate.turn');
    expect(debate).toHaveLength(4);
    expect(debate.map((e) => (e.event.type === 'debate.turn' ? e.event.speaker : ''))).toEqual([
      'bull',
      'bear',
      'bull',
      'bear'
    ]);
    expect(debate.map((e) => (e.event.type === 'debate.turn' ? e.event.round : 0))).toEqual([1, 1, 2, 2]);
    expect(debate.map((e) => (e.event.type === 'debate.turn' ? e.event.count : 0))).toEqual([1, 2, 3, 4]);

    const risk = page.events.filter((e) => e.event.type === 'risk.turn');
    expect(risk).toHaveLength(3);
    expect(risk.map((e) => (e.event.type === 'risk.turn' ? e.event.stance : ''))).toEqual([
      'aggressive',
      'conservative',
      'neutral'
    ]);
    expect(risk.map((e) => (e.event.type === 'risk.turn' ? e.event.count : 0))).toEqual([1, 2, 3]);
    expect(risk.every((e) => e.event.type === 'risk.turn' && e.event.round === 1)).toBe(true);

    // P8：运行中的发言事件即带该节点尝试的真实开始/结束时间（与落库同源）。
    const turnEvents = [...debate, ...risk].map((e) => {
      if (e.event.type !== 'debate.turn' && e.event.type !== 'risk.turn') throw new Error('unexpected event');
      return e.event;
    });
    for (const turn of turnEvents) {
      expect(typeof turn.startedAt).toBe('string');
      expect(typeof turn.endedAt).toBe('string');
      expect(new Date(turn.endedAt!).getTime()).toBeGreaterThanOrEqual(new Date(turn.startedAt!).getTime());
    }

    const routes = page.events.filter((e) => e.event.type === 'route.taken');
    expect(routes).toHaveLength(7);
    expect(routes.map((e) => (e.event.type === 'route.taken' ? e.event.to : ''))).toEqual([
      'bear',
      'bull',
      'bear',
      'judge',
      'risk_conservative',
      'risk_neutral',
      'final'
    ]);
    // P6：condition 改为人类可读标签，并携带 edgeId 以便画布定位。
    expect(
      routes
        .slice(0, 4)
        .every(
          (e) =>
            e.event.type === 'route.taken' &&
            e.event.condition.includes('辩论：第 2 轮后') &&
            typeof e.event.edgeId === 'string' &&
            e.event.edgeId.length > 0
        )
    ).toBe(true);
    expect(
      routes
        .slice(4)
        .every(
          (e) =>
            e.event.type === 'route.taken' &&
            e.event.condition.includes('风控：第 1 轮后') &&
            typeof e.event.edgeId === 'string' &&
            e.event.edgeId.length > 0
        )
    ).toBe(true);

    const judgePrompt = prompts.find((m) => (m[0]?.content ?? '').includes('裁决者'));
    expect(judgePrompt).toBeTruthy();
    const judgeUser = judgePrompt!.find((m) => m.role === 'user')?.content ?? '';
    expect(judgeUser).toContain('共 4 次发言');
    expect(judgeUser).toContain('第1轮 多头');
    expect(judgeUser).toContain('第2轮 空头');

    const riskPrompt = prompts.find((m) => (m[0]?.content ?? '').includes('保守风控'));
    expect(riskPrompt).toBeTruthy();
    const riskUser = riskPrompt!.find((m) => m.role === 'user')?.content ?? '';
    expect(riskUser).toContain('已发言 1 次 / 共 3 次');
    expect(riskUser).toContain('激进（第1轮）');

    // afterSeq：从第 2 条辩论发言之后补拉，之前的事件不再返回。
    const after = debate[1].seq;
    const tail = expectOk(runtime.getEvents({ runId: started.runId, afterSeq: after }));
    expect(tail.events.every((e) => e.seq > after)).toBe(true);
    expect(tail.events.filter((e) => e.event.type === 'debate.turn')).toHaveLength(2);
    expect(tail.nextSeq).toBe(page.nextSeq);

    expectOk(await runtime.resumeRun({ runId: started.runId, resolution: { type: 'approve' } }));
    await runtime.waitForRun(started.runId);
    const detail = expectOk(runtime.getRun(started.runId));
    expect(detail.status).toBe('completed');
    const bullResults = detail.nodes.filter((n) => n.nodeId === 'bull');
    const bearResults = detail.nodes.filter((n) => n.nodeId === 'bear');
    expect(bullResults).toHaveLength(2);
    expect(bearResults).toHaveLength(2);
    expect((bullResults[0].output as { argument: string }).argument).toContain('[Mock 第1轮]');
    expect((bullResults[1].output as { argument: string }).argument).toContain('[Mock 第2轮]');

    // P8：历史回放（getRun 读 state_json）同样能拿到时间，且与运行中事件一致。
    const turnEntry = { entries: [] as Array<{ startedAt?: string; endedAt?: string }> };
    const debateState = detail.state?.debate as typeof turnEntry | undefined;
    const riskState = detail.state?.risk as typeof turnEntry | undefined;
    expect(debateState?.entries).toHaveLength(4);
    expect(riskState?.entries).toHaveLength(3);
    for (const entry of [...(debateState?.entries ?? []), ...(riskState?.entries ?? [])]) {
      expect(typeof entry.startedAt).toBe('string');
      expect(typeof entry.endedAt).toBe('string');
    }
    expect(debateState?.entries[0].startedAt).toBe(
      debate[0].event.type === 'debate.turn' ? debate[0].event.startedAt : undefined
    );
    db.close();
  });

  it('无限循环图触发 recursionLimit，返回 E_RECURSION_LIMIT 而不是抛栈', async () => {
    const db = newDb();
    const base = defaultGraphSpec(NOW);
    // P2 收紧 whenDone 后，任何图结构环都会在校验期被拒；这里绕过校验直接编译，
    // 只验证运行时对 LangGraph GraphRecursionError 的错误码映射。
    const loopSpec: GraphSpec = {
      ...base,
      id: 'loop-graph',
      version: 3,
      nodes: base.nodes.filter((n) => n.type === 'bull' || n.type === 'bear'),
      edges: [
        { id: 'l-start-bull', source: '__start__', target: 'bull' },
        { id: 'l-bull-bear', source: 'bull', target: 'bear' },
        { id: 'l-bear-bull', source: 'bear', target: 'bull' }
      ]
    };
    const deps = {
      db,
      generate: () => Promise.resolve('{}'),
      checkCanceled: () => undefined,
      asOf: NOW
    };
    const hooks = {
      onNodeStarted: () => undefined,
      onNodeCompleted: () => undefined,
      onNodeFailed: () => undefined,
      onDebateTurn: () => undefined,
      onRiskTurn: () => undefined,
      onRouteTaken: () => undefined,
      checkCanceled: () => undefined
    };
    const { graph } = compileAgentGraph(loopSpec, deps, hooks, {
      nodeTimeoutMs: loopSpec.settings.nodeTimeoutMs,
      skipTimeout: true
    });
    let caught: string | null = null;
    try {
      await graph.invoke(
        { runId: 'run_loop', asOf: NOW, subject: SUBJECT } as never,
        { configurable: { thread_id: 'run_loop' }, recursionLimit: 3 }
      );
    } catch (err) {
      caught = extractAgentError(err).code;
    }
    expect(caught).toBe('E_RECURSION_LIMIT');
    db.close();
  });

  it('三种审批结果：批准 completed / 修改覆盖 rating / 拒绝落 review 且 canceled', async () => {
    const db = newDb();
    const mock = new MockProvider();
    const runtime = makeRuntime(db, mock);
    runtime.ensureDefaultGraph(defaultGraphSpec(NOW));

    // approve
    const a = expectOk(await runtime.startRun(request()));
    await runtime.waitForRun(a.runId);
    expect(expectOk(runtime.getRun(a.runId)).status).toBe('interrupted');
    expectOk(await runtime.resumeRun({ runId: a.runId, resolution: { type: 'approve' } }));
    await runtime.waitForRun(a.runId);
    const doneA = expectOk(runtime.getRun(a.runId));
    expect(doneA.status).toBe('completed');
    expect(doneA.decision?.rating).toBe('up');

    // edit → strong_down + 自定义理由
    const b = expectOk(await runtime.startRun(request()));
    await runtime.waitForRun(b.runId);
    const pausedB = expectOk(runtime.getRun(b.runId));
    const baseB = pausedB.approval?.decision;
    expectOk(
      await runtime.resumeRun({
        runId: b.runId,
        resolution: {
          type: 'edit',
          patch: {
            rating: 'strong_down',
            thesis: '人工修改：数据不足以支持上行，转为强烈下行观察。',
            keyRisks: baseB?.keyRisks ?? []
          }
        }
      })
    );
    await runtime.waitForRun(b.runId);
    const doneB = expectOk(runtime.getRun(b.runId));
    expect(doneB.status).toBe('completed');
    expect(doneB.decision?.rating).toBe('strong_down');
    expect(doneB.decision?.thesis).toBe('人工修改：数据不足以支持上行，转为强烈下行观察。');

    // reject → canceled + review 落库
    const c = expectOk(await runtime.startRun(request()));
    await runtime.waitForRun(c.runId);
    expectOk(await runtime.resumeRun({ runId: c.runId, resolution: { type: 'reject', reason: '证据不足' } }));
    const doneC = expectOk(runtime.getRun(c.runId));
    expect(doneC.status).toBe('canceled');
    expect(doneC.decision?.rating).toBe('review');
    expect(doneC.decision?.reviewReason).toContain('证据不足');
    const eventsC = expectOk(runtime.getEvents({ runId: c.runId, afterSeq: 0 }));
    expect(eventsC.events[eventsC.events.length - 1].event.type).toBe('run.canceled');
    db.close();
  });

  it('错误路径：重复 resume / 非 interrupted resume / 审批中 cancel / 非法补丁', async () => {
    const db = newDb();
    const runtime = makeRuntime(db, new MockProvider(), { ids: ['run_a', 'run_b'] });
    runtime.ensureDefaultGraph(defaultGraphSpec(NOW));

    // 对 running 的 resume：E_RUN_TERMINAL
    const a = expectOk(await runtime.startRun(request()));
    const premature = await runtime.resumeRun({ runId: a.runId, resolution: { type: 'approve' } });
    expect(!premature.ok && premature.code).toBe('E_RUN_TERMINAL');
    await runtime.waitForRun(a.runId);

    // 重复 resume：恢复后 run 已不是 interrupted，第二次固定返回 E_RUN_TERMINAL。
    const first = await runtime.resumeRun({ runId: a.runId, resolution: { type: 'approve' } });
    expect(first.ok).toBe(true);
    const second = await runtime.resumeRun({ runId: a.runId, resolution: { type: 'approve' } });
    expect(!second.ok && second.code).toBe('E_RUN_TERMINAL');
    await runtime.waitForRun(a.runId);

    // 审批中 cancel：直接进入 canceled（挂起快照丢弃）
    const b = expectOk(await runtime.startRun(request({ options: { forceMock: false } })));
    await runtime.waitForRun(b.runId);
    expect(expectOk(runtime.getRun(b.runId)).status).toBe('interrupted');
    expectOk(await runtime.cancelRun(b.runId, 'user'));
    const canceled = expectOk(runtime.getRun(b.runId));
    expect(canceled.status).toBe('canceled');
    const afterCancelResume = await runtime.resumeRun({ runId: b.runId, resolution: { type: 'approve' } });
    expect(!afterCancelResume.ok && afterCancelResume.code).toBe('E_RUN_TERMINAL');

    // 对 completed 的 resume：E_RUN_TERMINAL
    const c = expectOk(await runtime.startRun(request()));
    await runtime.waitForRun(c.runId);
    expectOk(await runtime.resumeRun({ runId: c.runId, resolution: { type: 'approve' } }));
    await runtime.waitForRun(c.runId);
    const doneC = await runtime.resumeRun({ runId: c.runId, resolution: { type: 'approve' } });
    expect(!doneC.ok && doneC.code).toBe('E_RUN_TERMINAL');

    // 对 failed 的 resume：E_RUN_TERMINAL
    const failing: AiProvider = {
      name: 'failing',
      async generate() {
        throw new Error('boom');
      }
    };
    const failRuntime = makeRuntime(db, failing);
    failRuntime.ensureDefaultGraph(defaultGraphSpec(NOW));
    const f = expectOk(await failRuntime.startRun(request({ options: { forceMock: false } })));
    await failRuntime.waitForRun(f.runId);
    expect(expectOk(failRuntime.getRun(f.runId)).status).toBe('failed');
    const failResume = await failRuntime.resumeRun({
      runId: f.runId,
      resolution: { type: 'approve' }
    });
    expect(!failResume.ok && failResume.code).toBe('E_RUN_TERMINAL');

    // 非法补丁：未知键 / 越界评级 → E_VALIDATION
    const d = expectOk(await runtime.startRun(request()));
    await runtime.waitForRun(d.runId);
    const bad1 = await runtime.resumeRun({ runId: d.runId, resolution: { type: 'edit', patch: { rating: 'moon' } } });
    expect(!bad1.ok && bad1.code).toBe('E_VALIDATION');
    const bad2 = await runtime.resumeRun({ runId: d.runId, resolution: { type: 'edit', patch: { sneaky: true } } });
    expect(!bad2.ok && bad2.code).toBe('E_VALIDATION');
    expect(expectOk(runtime.getRun(d.runId)).status).toBe('interrupted');
    expectOk(await runtime.cancelRun(d.runId, 'user'));
    db.close();
  });

  it('裁决 JSON 解析两次失败时回退 review，而不是 neutral', async () => {
    const db = newDb();
    const mock = new MockProvider();
    const broken: AiProvider = {
      name: 'broken-judge',
      async generate(messages: ChatMessage[]) {
        const system = messages.find((m) => m.role === 'system')?.content ?? '';
        if (system.includes('裁决者')) return '无法给出结构化结论，请人工判断。';
        return mock.generate(messages);
      }
    };
    const runtime = makeRuntime(db, broken);
    runtime.ensureDefaultGraph(defaultGraphSpec(NOW));

    const started = expectOk(await runtime.startRun(request({ options: { forceMock: false } })));
    await runtime.waitForRun(started.runId);
    // final 之前必须有审批挂起；批准后 final 仍保持 review（不得洗成方向性评级）。
    expect(expectOk(runtime.getRun(started.runId)).status).toBe('interrupted');
    expectOk(await runtime.resumeRun({ runId: started.runId, resolution: { type: 'approve' } }));
    await runtime.waitForRun(started.runId);
    const detail: AgentRunDetail = expectOk(runtime.getRun(started.runId));

    expect(detail.status).toBe('completed');
    expect(detail.decision?.rating).toBe('review');
    expect(detail.decision?.rating).not.toBe('neutral');
    expect(detail.decision?.reviewRequired).toBe(true);
    expect(detail.rating).toBe('review');
    expect(detail.reviewRequired).toBe(true);
    const judge = detail.nodes.find((n) => n.nodeId === 'judge');
    expect((judge?.output as { rating?: string } | undefined)?.rating).toBe('review');
    db.close();
  });

  it('cancel 幂等：运行中取消使当前节点 failed + E_CANCELED，重复取消返回已终态', async () => {
    const db = newDb();
    const mock = new MockProvider();
    const slow: AiProvider = {
      name: 'slow-provider',
      async generate(messages: ChatMessage[]) {
        await new Promise((r) => setTimeout(r, 150));
        return mock.generate(messages);
      }
    };
    const runtime = makeRuntime(db, slow);
    runtime.ensureDefaultGraph(defaultGraphSpec(NOW));

    const started = expectOk(await runtime.startRun(request({ options: { forceMock: false } })));
    await waitFor(() => {
      const page = runtime.getEvents({ runId: started.runId, afterSeq: 0 });
      return page.ok && page.data.events.some((e) => e.event.type === 'node.started' && e.event.nodeId === 'evidence');
    });

    const canceled = expectOk(await runtime.cancelRun(started.runId, 'user'));
    expect(canceled.status).toBe('canceled');

    const detail = expectOk(runtime.getRun(started.runId));
    expect(detail.status).toBe('canceled');
    const evidence = detail.nodes.find((n) => n.nodeId === 'evidence');
    expect(evidence?.status).toBe('failed');
    expect(evidence?.errorCode).toBe('E_CANCELED');

    const page = expectOk(runtime.getEvents({ runId: started.runId, afterSeq: 0 }));
    expect(page.events.some((e) => e.event.type === 'node.failed' && e.event.code === 'E_CANCELED')).toBe(true);
    expect(page.events[page.events.length - 1].event.type).toBe('run.canceled');

    const again = expectOk(await runtime.cancelRun(started.runId, 'user'));
    expect(again.alreadyTerminal).toBe(true);
    expect(again.status).toBe('canceled');
    db.close();
  });

  it('落盘重开后仍能列出历史 run 并回看节点输出', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-agent-'));
    const file = path.join(dir, 'lumen.db');
    const db = newDb();
    const runtime = makeRuntime(db, new MockProvider(), { persist: () => saveDatabase(db, file) });
    runtime.ensureDefaultGraph(defaultGraphSpec(NOW));
    const started = expectOk(await runtime.startRun(request()));
    await runtime.waitForRun(started.runId);
    // P2：final 前有审批挂起，必须先批准才能进入 completed。
    expect(expectOk(runtime.getRun(started.runId)).status).toBe('interrupted');
    expectOk(await runtime.resumeRun({ runId: started.runId, resolution: { type: 'approve' } }));
    await runtime.waitForRun(started.runId);
    expect(expectOk(runtime.getRun(started.runId)).status).toBe('completed');
    db.close();

    const reopened = await openDatabase(file);
    const repo = createAgentRepository(reopened, () => {});
    const runs = repo.listRuns();
    expect(runs.length).toBe(1);
    expect(runs[0].runId).toBe(started.runId);
    const detail = repo.getRunDetail(started.runId);
    expect(detail?.status).toBe('completed');
    expect(detail?.nodes.filter((n) => n.status === 'succeeded')).toHaveLength(12);
    expect(detail?.nodes.filter((n) => n.status === 'skipped')).toHaveLength(1);
    expect(detail?.decision?.rating).toBe('up');
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('进程重启后残留 running run 标记为 E_PROCESS_RESTART', async () => {
    const db = newDb();
    const runtime = makeRuntime(db, new MockProvider());
    runtime.ensureDefaultGraph(defaultGraphSpec(NOW));
    const stmt = db.prepare(
      `INSERT INTO agent_run (run_id, graph_id, graph_version, thread_id, status, subject_key, subject_label, subject_kind, as_of, started_at, config_json)
       VALUES ('run_stale', 'trend-analysis', 1, 'run_stale', 'running', 'topic:China', 'China', 'topic', ?, ?, '{}')`
    );
    stmt.run([NOW, NOW]);
    stmt.free();

    // P5：返回值改为可恢复/失败计数；无快照的 running 仍然直接失败。
    expect(runtime.markInterruptedFromPreviousProcess()).toEqual({ recoverable: 0, failed: 1 });
    const detail = expectOk(runtime.getRun('run_stale'));
    expect(detail.status).toBe('failed');
    expect(detail.errorCode).toBe('E_PROCESS_RESTART');
    db.close();
  });

  it('重复启动与非法请求返回可枚举错误码', async () => {
    const db = newDb();
    const slow: AiProvider = {
      name: 'slow-provider',
      async generate() {
        await new Promise((r) => setTimeout(r, 120));
        return '{}';
      }
    };
    const runtime = makeRuntime(db, slow, { ids: ['run_a', 'run_b'] });
    runtime.ensureDefaultGraph(defaultGraphSpec(NOW));
    const first = expectOk(await runtime.startRun(request({ options: { forceMock: false } })));
    const second = await runtime.startRun(request({ options: { forceMock: false } }));
    expect(!second.ok && second.code).toBe('E_RUN_ACTIVE');

    const badFuture = await runtime.startRun(request({ asOf: '2026-11-04T00:00:00.000Z' }));
    expect(!badFuture.ok && badFuture.code).toBe('E_VALIDATION');

    const missing = runtime.getRun('run_missing');
    expect(!missing.ok && missing.code).toBe('E_RUN_NOT_FOUND');

    const resume = await runtime.resumeRun({ runId: first.runId, resolution: { type: 'approve' } });
    expect(!resume.ok && resume.code).toBe('E_RUN_TERMINAL');
    expectOk(await runtime.cancelRun(first.runId, 'user'));
    db.close();
  });

  it('memory 注入：只消费 asOf 之前的教训，并写入待结算决策', async () => {
    const db = newDb();
    const seen: ChatMessage[] = [];
    const recording: AiProvider = {
      name: 'recording',
      async generate(messages) {
        seen.push(...messages);
        return new MockProvider().generate(messages);
      }
    };
    const outcome = JSON.stringify({
      windowStart: '2026-09-18T10:00:00.000Z',
      windowEnd: '2026-09-25T10:00:00.000Z',
      articleCount: 7,
      hotRank: 2,
      momentum: -1,
      articleDelta: 0,
      hotRankDelta: 0,
      momentumDelta: 0,
      verdict: 'miss',
      hit: false,
      reason: '看多但热度排名未上升'
    });
    const stmt = db.prepare(
      `INSERT INTO agent_memory
        (id, decision_id, subject_key, as_of, resolved_at, rating, horizon_days, outcome_json, reflection, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run([
      'mem_old',
      'dec_old',
      'topic:China',
      '2026-09-25T10:00:00.000Z',
      '2026-10-01T10:00:00.000Z',
      'up',
      7,
      outcome,
      '历史教训：China 在 2026-10 的看多判断落空，应更重视动量反转。',
      '2026-10-01T10:00:00.000Z'
    ]);
    stmt.run([
      'mem_future',
      'dec_future',
      'topic:China',
      '2026-11-20T10:00:00.000Z',
      '2026-12-01T10:00:00.000Z',
      'up',
      7,
      outcome,
      '未来窗口的教训不可注入历史分析。',
      '2026-12-01T10:00:00.000Z'
    ]);
    stmt.free();

    // 为 Mock 结算准备实体样本：基准窗口内 4 篇文章（asOf 前 2 天）。
    const entStmt = db.prepare(
      `INSERT INTO entity (id, name, name_en, type, lang) VALUES ('e_china', 'China', NULL, 'topic', 'zh')`
    );
    entStmt.run();
    entStmt.free();
    const artStmt = db.prepare(
      `INSERT INTO article_entity (article_id, entity_id, crawled_at) VALUES (?, 'e_china', ?)`
    );
    for (let i = 0; i < 4; i++) {
      artStmt.run([`base_${i}`, '2026-11-01T00:00:00.000Z']);
    }
    artStmt.free();

    const runtime = makeRuntime(db, recording);
    runtime.ensureDefaultGraph(defaultGraphSpec(NOW));
    const started = expectOk(await runtime.startRun(request({ options: { forceMock: false } })));
    await runtime.waitForRun(started.runId);
    expect(expectOk(runtime.getRun(started.runId)).status).toBe('interrupted');

    const paused = expectOk(runtime.getRun(started.runId));
    expect(paused.memory?.lessons).toHaveLength(1);
    expect(paused.memory?.lessons[0].memoryId).toBe('mem_old');
    const joined = seen.map((m) => m.content).join('\n');
    expect(joined).toContain('历史教训');
    expect(joined).toContain('2026-10 的看多判断落空');
    expect(joined).not.toContain('未来窗口的教训');

    expectOk(await runtime.resumeRun({ runId: started.runId, resolution: { type: 'approve' } }));
    await runtime.waitForRun(started.runId);

    const decStmt = db.prepare(
      `SELECT status, baseline_json, resolve_after FROM agent_decision WHERE run_id = ?`
    );
    decStmt.bind([started.runId]);
    expect(decStmt.step()).toBe(true);
    const dec = decStmt.getAsObject() as {
      status: string;
      baseline_json: string | null;
      resolve_after: string | null;
    };
    decStmt.free();
    expect(dec.status).toBe('pending');
    expect(dec.baseline_json).toBeTruthy();
    expect(dec.resolve_after && dec.resolve_after > NOW).toBe(true);

    // 无 Key 的 Mock 链路也能结算至少一条记录：补足结算窗口样本后扫描到期记录。
    const resolveAfter = dec.resolve_after as string;
    const outcomeAt = new Date(Date.parse(resolveAfter) - 86400000).toISOString();
    const outStmt = db.prepare(
      `INSERT INTO article_entity (article_id, entity_id, crawled_at) VALUES (?, 'e_china', ?)`
    );
    for (let i = 0; i < 4; i++) outStmt.run([`out_${i}`, outcomeAt]);
    outStmt.free();
    const settled = settleDueMemory(db, () => {}, {
      now: new Date(Date.parse(resolveAfter) + 3600000).toISOString()
    });
    expect(settled.scanned).toBe(1);
    expect(settled.settled).toBe(1);
    const memCount = db.exec(`SELECT COUNT(*) FROM agent_memory`)[0].values[0][0];
    // 2 条种子教训 + 本次新结算 1 条。
    expect(Number(memCount)).toBe(3);
    db.close();
  });
});
