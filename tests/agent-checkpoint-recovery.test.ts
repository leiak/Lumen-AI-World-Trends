import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import initSqlJs, { type Database } from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { openDatabase, saveDatabase } from '../electron/main/db/connection.js';
import { MockProvider, type AiProvider, type ChatMessage } from '../electron/main/ai/provider.js';
import { AgentRuntime } from '../electron/main/agent/runtime.js';
import { defaultGraphSpec } from '../electron/main/agent/spec.js';
import type { AgentIpcResponse, AgentRunDetail, StartRunRequest } from '../shared/agent.js';

const NOW = '2026-11-03T10:00:00.000Z';
const SUBJECT = { key: 'topic:China', label: 'China', kind: 'topic' as const };
const NEVER = new Promise<void>(() => {});

process.env.LUMEN_CHECKPOINT_FLUSH = 'immediate';

let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs();
});

afterAll(() => {
  delete process.env.LUMEN_CHECKPOINT_FLUSH;
});

function expectOk<T>(res: AgentIpcResponse<T>): T {
  if (!res.ok) throw new Error(`expected ok, got ${res.code}: ${res.message}`);
  return res.data;
}

function request(): StartRunRequest {
  return {
    graphId: 'trend-analysis',
    subject: SUBJECT,
    asOf: NOW,
    options: { forceMock: true }
  };
}

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 命中指定系统提示词时挂起，用于模拟"进程跑到一半被强杀"。 */
class BlockingProvider implements AiProvider {
  readonly name = 'mock-blocking';
  blocked = false;

  constructor(
    private readonly inner: MockProvider,
    private readonly blockOn: string | null
  ) {}

  async generate(messages: ChatMessage[]): Promise<string> {
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    if (this.blockOn && system.includes(this.blockOn)) {
      this.blocked = true;
      await NEVER;
    }
    return this.inner.generate(messages);
  }
}

function newRuntime(
  db: Database,
  persist: () => void,
  runId: string,
  opts: { blockOn?: string | null } = {}
): AgentRuntime {
  const provider = new BlockingProvider(new MockProvider(), opts.blockOn ?? null);
  return new AgentRuntime({
    db,
    provider,
    mockProvider: provider,
    persist,
    now: () => NOW,
    newRunId: () => runId
  });
}

function count(db: Database, sql: string): number {
  const res = db.exec(sql);
  return res[0] ? (res[0].values[0][0] as number) : 0;
}

function nodeRows(db: Database, runId: string, nodeId: string) {
  const stmt = db.prepare(
    'SELECT attempt, status FROM agent_node_result WHERE run_id = ? AND node_id = ? ORDER BY attempt'
  );
  stmt.bind([runId, nodeId]);
  const rows: Array<{ attempt: number; status: string }> = [];
  while (stmt.step()) rows.push(stmt.getAsObject() as unknown as { attempt: number; status: string });
  stmt.free();
  return rows;
}

function runUsage(db: Database, runId: string) {
  const row = db.exec(
    `SELECT calls, prompt_chars, completion_chars FROM agent_run WHERE run_id='${runId}'`
  )[0]?.values[0];
  return {
    calls: row ? (row[0] as number) : 0,
    promptChars: row ? (row[1] as number) : 0,
    completionChars: row ? (row[2] as number) : 0
  };
}

function nodeMaxAttempt(db: Database, runId: string, nodeId: string): number {
  const res = db.exec(
    `SELECT COALESCE(MAX(attempt), 0) FROM agent_node_result WHERE run_id='${runId}' AND node_id='${nodeId}'`
  );
  return res[0] ? (res[0].values[0][0] as number) : 0;
}

/** 进程 A 跑到 planner 时挂起（已完成的 memory/evidence/bull/bear/judge 全部落库），导出库后视为强杀。 */
async function crashAtPlanner(file: string) {
  const dbA = await openDatabase(file);
  const provider = new BlockingProvider(new MockProvider(), '规划者');
  const runtimeA = new AgentRuntime({
    db: dbA,
    provider,
    mockProvider: provider,
    persist: () => saveDatabase(dbA, file),
    now: () => NOW,
    newRunId: () => 'run_crash'
  });
  runtimeA.ensureDefaultGraph(defaultGraphSpec(NOW));
  const started = expectOk(await runtimeA.startRun(request()));
  await waitFor(() => provider.blocked);
  await waitFor(
    () =>
      count(
        dbA,
        `SELECT COUNT(*) FROM agent_node_result WHERE run_id='${started.runId}' AND node_id='planner' AND status='running'`
      ) >= 1
  );
  const before = expectOk(runtimeA.getRun(started.runId));
  const beforeSeq = expectOk(runtimeA.getEvents({ runId: started.runId, afterSeq: 0 })).nextSeq;
  expect(before.status).toBe('running');
  // 运行中 decision 尚未写入 run 行；用节点结果证明 judge 已完成。
  expect(nodeRows(dbA, started.runId, 'judge').filter((r) => r.status === 'succeeded')).toHaveLength(1);
  const beforeUsage = runUsage(dbA, started.runId);
  // 记录强杀前每个已完成节点的最大 attempt（辩论节点可能在单次 run 内被多次调用）。
  const beforeMax = Object.fromEntries(
    ['memory', 'evidence', 'bull', 'bear', 'judge'].map((n) => [n, nodeMaxAttempt(dbA, started.runId, n)])
  );
  saveDatabase(dbA, file);
  return {
    dbA,
    runtimeA,
    started,
    before,
    beforeSeq,
    beforeUsage,
    beforeMax
  };
}

describe('P7 任意断点续跑（真实两进程：A 强杀 → B 恢复）', () => {
  it('从 checkpoint 恢复：已完成节点不重跑、用量累加、seq 连续、终态清 checkpoint', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cp-'));
    const file = path.join(dir, 'lumen.db');
    let dbA: Database | null = null;
    let dbB: Database | null = null;
    try {
      const crash = await crashAtPlanner(file);
      dbA = crash.dbA;
      const runId = crash.started.runId;
      const beforeSeq = crash.beforeSeq;
      const beforeCalls = crash.beforeUsage.calls;
      expect(beforeCalls).toBeGreaterThan(0);

      dbB = await openDatabase(file);
      const runtimeB = newRuntime(dbB, () => saveDatabase(dbB!, file), 'run_crash_2');

      expect(runtimeB.markInterruptedFromPreviousProcess()).toEqual({ recoverable: 1, failed: 0 });
      const recovered = expectOk(runtimeB.getRun(runId));
      expect(recovered.status).toBe('interrupted');
      // 与审批挂起互斥：checkpoint 恢复不展示审批卡。
      expect(recovered.approval).toBeUndefined();
      expect(recovered.recovery?.kind).toBe('checkpoint');
      expect(recovered.recovery?.checkpointId.length).toBeGreaterThan(0);
      expect(recovered.recovery?.checkpointStep).toBeGreaterThan(0);

      const resumed = await runtimeB.resumeCheckpoint({ runId });
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) throw new Error('resume failed');
      expect(resumed.data.status).toBe('running');
      expect(resumed.data.fromCheckpointId).toBe(recovered.recovery!.checkpointId);
      await runtimeB.waitForRun(runId);

      const afterResume: AgentRunDetail = expectOk(runtimeB.getRun(runId));
      // 任意断点续跑不会绕过 P5 的 final 审批闸门：续跑到 final 后再次挂起等待审批。
      expect(afterResume.status).toBe('interrupted');
      expect(afterResume.recovery).toBeUndefined();
      expect(afterResume.approval?.stage).toBe('final_approval');
      expect(afterResume.approval?.decision?.rating).toBe('up');

      // 走既有 P5 审批路径完成；两条恢复路径互不冲突。
      const approved = await runtimeB.resumeRun({
        runId,
        resolution: { type: 'approve' }
      });
      expect(approved.ok).toBe(true);
      await runtimeB.waitForRun(runId);

      const after: AgentRunDetail = expectOk(runtimeB.getRun(runId));
      expect(after.status).toBe('completed');
      expect(after.decision?.rating).toBe('up');
      expect(after.recovery).toBeUndefined();

      // 已完成节点绝不重跑：attempt 上限不变，且重启后没有新的 node.started。
      const beforeMax = crash.beforeMax;
      for (const nodeId of ['memory', 'evidence', 'bull', 'bear', 'judge']) {
        expect(nodeMaxAttempt(dbB!, runId, nodeId)).toBe(beforeMax[nodeId]);
      }
      // planner 在 A 中已 started 未完成，B 用 attempt 2 补跑。
      const plannerRows = nodeRows(dbB!, runId, 'planner');
      expect(plannerRows).toEqual([
        { attempt: 1, status: 'running' },
        { attempt: 2, status: 'succeeded' }
      ]);
      for (const nodeId of ['risk_aggressive', 'risk_conservative', 'risk_neutral']) {
        expect(nodeRows(dbB!, runId, nodeId).filter((r) => r.status === 'succeeded')).toHaveLength(1);
      }
      // final 在续跑中 attempt1 挂起后被标记 skipped、审批后 attempt2 完成（P5 既有语义）。
      expect(nodeRows(dbB!, runId, 'final')).toEqual([
        { attempt: 1, status: 'skipped' },
        { attempt: 2, status: 'succeeded' }
      ]);

      // 用量累加：恢复段新增 planner(1) + 风控三方(3) + final(1) = 5 次，不因重启归零。
      const afterUsage = runUsage(dbB!, runId);
      expect(afterUsage.calls - beforeCalls).toBe(5);
      expect(afterUsage.promptChars).toBeGreaterThan(crash.beforeUsage.promptChars);

      // seq 跨重启单调、连续；afterSeq=0 可完整补拉，resume 事件在旧 seq 之后。
      const page = expectOk(runtimeB.getEvents({ runId, afterSeq: 0 }));
      const seqs = page.events.map((e) => e.seq);
      expect(seqs[0]).toBe(1);
      for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBe(seqs[i - 1] + 1);
      expect(page.nextSeq).toBeGreaterThan(beforeSeq);
      const resumedEvent = page.events.find((e) => e.event.type === 'run.resumed');
      expect(resumedEvent?.seq).toBeGreaterThan(beforeSeq);
      expect(resumedEvent?.event.type === 'run.resumed' && resumedEvent.event.resolution).toBe(
        'checkpoint'
      );

      // 同一 (nodeId, attempt) 的 started 事件全局只出现一次；已完成节点在重启后无 started。
      const startedKeys = new Map<string, number>();
      for (const e of page.events) {
        if (e.event.type !== 'node.started') continue;
        const key = `${e.event.nodeId}#${e.event.attempt}`;
        startedKeys.set(key, (startedKeys.get(key) ?? 0) + 1);
      }
      for (const [key, n] of startedKeys) expect(`${key}:${n}`).toBe(`${key}:1`);
      const postRestart = page.events.filter((e) => e.seq > beforeSeq);
      for (const nodeId of ['memory', 'evidence', 'bull', 'bear', 'judge']) {
        expect(
          postRestart.filter((e) => e.event.type === 'node.started' && e.event.nodeId === nodeId)
        ).toHaveLength(0);
      }

      // 终态清理 checkpoint；重复 resume 被拒且不产生任何新的节点执行。
      expect(
        count(dbB!, `SELECT COUNT(*) FROM agent_run_checkpoint WHERE run_id='${runId}'`)
      ).toBe(0);
      const again = await runtimeB.resumeCheckpoint({ runId });
      expect(!again.ok && again.code).toBe('E_RUN_TERMINAL');
      expect(nodeRows(dbB!, runId, 'final')).toHaveLength(2);
    } finally {
      dbA?.close();
      dbB?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('P7 恢复错误路径与降级', () => {
  it('损坏 checkpoint：启动恢复降级 failed + E_PROCESS_RESTART，不崩溃', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cp-corrupt-'));
    const file = path.join(dir, 'lumen.db');
    let dbA: Database | null = null;
    let dbB: Database | null = null;
    try {
      const crash = await crashAtPlanner(file);
      dbA = crash.dbA;
      const runId = crash.started.runId;

      dbB = await openDatabase(file);
      dbB.run(
        `UPDATE agent_run_checkpoint SET checkpoint_json='{not-json' WHERE run_id='${runId}'`
      );
      saveDatabase(dbB, file);
      const runtimeB = newRuntime(dbB, () => saveDatabase(dbB!, file), 'run_corrupt_2');
      expect(runtimeB.markInterruptedFromPreviousProcess()).toEqual({ recoverable: 0, failed: 1 });
      const detail = expectOk(runtimeB.getRun(runId));
      expect(detail.status).toBe('failed');
      expect(detail.errorCode).toBe('E_PROCESS_RESTART');
    } finally {
      dbA?.close();
      dbB?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('已标记可恢复后 checkpoint 被破坏：resume 返回 E_PROCESS_RESTART 并置 failed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cp-corrupt2-'));
    const file = path.join(dir, 'lumen.db');
    let dbA: Database | null = null;
    let dbB: Database | null = null;
    try {
      const crash = await crashAtPlanner(file);
      dbA = crash.dbA;
      const runId = crash.started.runId;
      dbB = await openDatabase(file);
      const runtimeB = newRuntime(dbB, () => saveDatabase(dbB!, file), 'run_corrupt3_2');
      expect(runtimeB.markInterruptedFromPreviousProcess()).toEqual({ recoverable: 1, failed: 0 });
      expect(expectOk(runtimeB.getRun(runId)).status).toBe('interrupted');

      dbB.run(
        `UPDATE agent_run_checkpoint SET checkpoint_json='{not-json' WHERE run_id='${runId}'`
      );
      const res = await runtimeB.resumeCheckpoint({ runId });
      expect(!res.ok && res.code).toBe('E_PROCESS_RESTART');
      const detail = expectOk(runtimeB.getRun(runId));
      expect(detail.status).toBe('failed');
      expect(detail.errorCode).toBe('E_PROCESS_RESTART');
    } finally {
      dbA?.close();
      dbB?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('图版本/digest 变化：E_RESUME_STALE_GRAPH，保持 interrupted 可人工取消', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cp-graph-'));
    const file = path.join(dir, 'lumen.db');
    let dbA: Database | null = null;
    let dbB: Database | null = null;
    try {
      const crash = await crashAtPlanner(file);
      dbA = crash.dbA;
      const runId = crash.started.runId;
      dbB = await openDatabase(file);
      const runtimeB = newRuntime(dbB, () => saveDatabase(dbB!, file), 'run_graph_2');
      expect(runtimeB.markInterruptedFromPreviousProcess()).toEqual({ recoverable: 1, failed: 0 });
      dbB.run(
        `UPDATE agent_graph SET digest='changed-graph-digest' WHERE graph_id='trend-analysis' AND version=4`
      );
      const res = await runtimeB.resumeCheckpoint({ runId });
      expect(!res.ok && res.code).toBe('E_RESUME_STALE_GRAPH');
      expect(expectOk(runtimeB.getRun(runId)).status).toBe('interrupted');
      expectOk(await runtimeB.cancelRun(runId, 'user'));
      expect(expectOk(runtimeB.getRun(runId)).status).toBe('canceled');
    } finally {
      dbA?.close();
      dbB?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('prompt 版本变化：E_RESUME_STALE_PROMPT', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cp-prompt-'));
    const file = path.join(dir, 'lumen.db');
    let dbA: Database | null = null;
    let dbB: Database | null = null;
    try {
      const crash = await crashAtPlanner(file);
      dbA = crash.dbA;
      const runId = crash.started.runId;
      dbB = await openDatabase(file);
      const runtimeB = newRuntime(dbB, () => saveDatabase(dbB!, file), 'run_prompt_2');
      expect(runtimeB.markInterruptedFromPreviousProcess()).toEqual({ recoverable: 1, failed: 0 });
      dbB.run(`UPDATE agent_run SET prompt_digest='changed-prompt-digest' WHERE run_id='${runId}'`);
      const res = await runtimeB.resumeCheckpoint({ runId });
      expect(!res.ok && res.code).toBe('E_RESUME_STALE_PROMPT');
      expect(expectOk(runtimeB.getRun(runId)).status).toBe('interrupted');
      expectOk(await runtimeB.cancelRun(runId, 'user'));
    } finally {
      dbA?.close();
      dbB?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('审批挂起 run 走 checkpoint resume：E_RESUME_NO_CHECKPOINT，P5 审批路径仍可用', async () => {
    const db = new SQL.Database();
    migrate(db);
    const runtime = newRuntime(db, () => {}, 'run_approval_only');
    runtime.ensureDefaultGraph(defaultGraphSpec(NOW));
    const started = expectOk(await runtime.startRun(request()));
    await runtime.waitForRun(started.runId);
    expect(expectOk(runtime.getRun(started.runId)).status).toBe('interrupted');
    const res = await runtime.resumeCheckpoint({ runId: started.runId });
    expect(!res.ok && res.code).toBe('E_RESUME_NO_CHECKPOINT');
    // P5 审批路径未被破坏。
    const approved = await runtime.resumeRun({
      runId: started.runId,
      resolution: { type: 'approve' }
    });
    expect(approved.ok).toBe(true);
    await runtime.waitForRun(started.runId);
    expect(expectOk(runtime.getRun(started.runId)).status).toBe('completed');
    db.close();
  }, 60_000);
});

describe('P7 checkpoint 写入节流（默认策略，非 immediate）', () => {
  it('一次完整 run（跑到审批挂起）的 checkpoint 写次数与 export 次数', async () => {
    const saved = process.env.LUMEN_CHECKPOINT_FLUSH;
    delete process.env.LUMEN_CHECKPOINT_FLUSH;
    const db = new SQL.Database();
    migrate(db);
    try {
      const runtime = newRuntime(db, () => {}, 'run_throttle');
      runtime.ensureDefaultGraph(defaultGraphSpec(NOW));
      const started = expectOk(await runtime.startRun(request()));
      await runtime.waitForRun(started.runId);
      expect(expectOk(runtime.getRun(started.runId)).status).toBe('interrupted');
      const stats = runtime.checkpointStats(started.runId);
      expect(stats).not.toBeNull();
      if (!stats) throw new Error('missing stats');
      // 中断边界强制落盘，pending 归零。
      expect(stats.checkpoints.pendingEvents).toBe(0);
      expect(stats.checkpoints.forcedExports).toBeGreaterThanOrEqual(1);
      expect(stats.checkpoints.puts).toBeGreaterThan(0);
      expect(stats.checkpoints.writeBatches).toBeGreaterThan(0);
      // 合并落盘：export 次数必须远小于写入事件数（节流生效）。
      const exportTotal = stats.checkpoints.exports + stats.checkpoints.forcedExports;
      expect(exportTotal).toBeLessThan(
        stats.checkpoints.puts + stats.checkpoints.writeBatches
      );
      expect(stats.persist.flushes).toBeLessThan(stats.persist.requests);
      // 验收报告用真实数值（不写入文件，仅测试日志）。
      console.log(
        `[P7 throttle] puts=${stats.checkpoints.puts} writeBatches=${stats.checkpoints.writeBatches} ` +
          `writeRows=${stats.checkpoints.writeRows} exports=${stats.checkpoints.exports} ` +
          `forcedExports=${stats.checkpoints.forcedExports} persist=${JSON.stringify(stats.persist)}`
      );
    } finally {
      if (saved !== undefined) process.env.LUMEN_CHECKPOINT_FLUSH = saved;
      db.close();
    }
  }, 60_000);
});
