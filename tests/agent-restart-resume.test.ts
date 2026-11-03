import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import initSqlJs, { type Database } from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { openDatabase, saveDatabase } from '../electron/main/db/connection.js';
import { MockProvider } from '../electron/main/ai/provider.js';
import { AgentRuntime } from '../electron/main/agent/runtime.js';
import { defaultGraphSpec, digestGraphSpec } from '../electron/main/agent/spec.js';
import type {
  AgentIpcResponse,
  AgentRunDetail,
  GraphSpec,
  StartRunRequest
} from '../shared/agent.js';

const NOW = '2026-11-03T10:00:00.000Z';
const SUBJECT = { key: 'topic:China', label: 'China', kind: 'topic' as const };

let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs();
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

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function newRuntime(db: Database, persist: () => void, runId: string): AgentRuntime {
  return new AgentRuntime({
    db,
    provider: new MockProvider(),
    mockProvider: new MockProvider(),
    persist,
    now: () => NOW,
    newRunId: () => runId
  });
}

/** 用文件库模拟两个真实进程：A 启动→挂起→退出，B 重新打开同一个库→恢复。 */
describe('P5 跨进程重启恢复审批挂起', () => {
  it('进程 A 挂起 → 退出 → 进程 B resume：已完成节点不重跑，seq 跨重启单调，重复 resume 被拒', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-restart-'));
    const file = path.join(dir, 'lumen.db');
    let dbA: Database | null = null;
    let dbB: Database | null = null;
    try {
      dbA = await openDatabase(file);
      const runtimeA = newRuntime(dbA, () => saveDatabase(dbA!, file), 'run_restart');
      runtimeA.ensureDefaultGraph(defaultGraphSpec(NOW));
      const started = expectOk(await runtimeA.startRun(request()));
      await runtimeA.waitForRun(started.runId);

      const before = expectOk(runtimeA.getRun(started.runId));
      expect(before.status).toBe('interrupted');
      const nodeCount = before.nodes.length;
      expect(before.nodes.filter((n) => n.status === 'succeeded')).toHaveLength(nodeCount - 1);
      expect(before.nodes.filter((n) => n.nodeId === 'final')).toEqual([
        expect.objectContaining({ attempt: 1, status: 'skipped' })
      ]);
      const beforeSeq = expectOk(runtimeA.getEvents({ runId: started.runId, afterSeq: 0 })).nextSeq;
      expect(beforeSeq).toBeGreaterThan(0);
      const suspendRow = dbA.prepare('SELECT suspend_json FROM agent_run WHERE run_id = ?');
      suspendRow.bind([started.runId]);
      expect(suspendRow.step()).toBe(true);
      expect(String((suspendRow.getAsObject() as { suspend_json: string }).suspend_json)).toContain(
        '"v":1'
      );
      suspendRow.free();

      // 进程 A 退出（落盘并关闭），进程 B 重新打开同一个库。
      saveDatabase(dbA, file);
      dbA.close();
      dbA = null;
      dbB = await openDatabase(file);
      const runtimeB = newRuntime(dbB, () => saveDatabase(dbB!, file), 'run_restart_never_used');

      const recovery = runtimeB.markInterruptedFromPreviousProcess();
      expect(recovery).toEqual({ recoverable: 1, failed: 0 });
      const recovered = expectOk(runtimeB.getRun(started.runId));
      expect(recovered.status).toBe('interrupted');
      expect(recovered.approval?.stage).toBe('final_approval');

      const resumed = await runtimeB.resumeRun({
        runId: started.runId,
        resolution: { type: 'approve' }
      });
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) throw new Error('resume failed');
      expect(resumed.data.status).toBe('running');
      await runtimeB.waitForRun(started.runId);

      const after: AgentRunDetail = expectOk(runtimeB.getRun(started.runId));
      expect(after.status).toBe('completed');
      expect(after.decision?.rating).toBe('up');
      // 其余节点各 1 次成功；final 只有 skipped(1) + succeeded(2)，没有第二个 attempt。
      expect(after.nodes).toHaveLength(nodeCount + 1);
      expect(after.nodes.filter((n) => n.status === 'succeeded')).toHaveLength(nodeCount);
      expect(after.nodes.filter((n) => n.status === 'skipped')).toHaveLength(1);
      const finalAttempts = after.nodes
        .filter((n) => n.nodeId === 'final')
        .map((n) => ({ attempt: n.attempt, status: n.status }))
        .sort((a, b) => a.attempt - b.attempt);
      expect(finalAttempts).toEqual([
        { attempt: 1, status: 'skipped' },
        { attempt: 2, status: 'succeeded' }
      ]);
      // 已完成节点未重跑：除 final 外，所有节点的 attempt/endedAt 与挂起前一致。
      const beforeById = new Map(
        before.nodes
          .filter((n) => n.nodeId !== 'final')
          .map((n) => [`${n.nodeId}:${n.attempt}`, `${n.status}:${n.endedAt ?? ''}`])
      );
      for (const n of after.nodes.filter((x) => x.nodeId !== 'final')) {
        expect(beforeById.get(`${n.nodeId}:${n.attempt}`)).toBe(`${n.status}:${n.endedAt ?? ''}`);
      }

      const page = expectOk(runtimeB.getEvents({ runId: started.runId, afterSeq: 0 }));
      const seqs = page.events.map((e) => e.seq);
      expect(seqs[0]).toBe(1);
      for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1] + 1);
      expect(page.nextSeq).toBeGreaterThan(beforeSeq);
      const resumedEvent = page.events.find((e) => e.event.type === 'run.resumed');
      expect(resumedEvent?.seq).toBeGreaterThan(beforeSeq);

      // 重复 resume：已完成 → E_RUN_TERMINAL，且不产生第二次 final 执行。
      const again = await runtimeB.resumeRun({
        runId: started.runId,
        resolution: { type: 'approve' }
      });
      expect(!again.ok && again.code).toBe('E_RUN_TERMINAL');
      const finalRows = dbB.prepare(
        'SELECT COUNT(*) AS n FROM agent_node_result WHERE run_id = ? AND node_id = ?'
      );
      finalRows.bind([started.runId, 'final']);
      finalRows.step();
      expect((finalRows.getAsObject() as { n: number }).n).toBe(2);
      finalRows.free();
      const cleared = dbB.prepare('SELECT suspend_json FROM agent_run WHERE run_id = ?');
      cleared.bind([started.runId]);
      cleared.step();
      expect((cleared.getAsObject() as { suspend_json: string | null }).suspend_json).toBeNull();
      cleared.free();
    } finally {
      dbA?.close();
      dbB?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('图版本内容变化后拒绝恢复：E_RESUME_STALE_GRAPH，且不崩溃', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-restart-stale-'));
    const file = path.join(dir, 'lumen.db');
    let db: Database | null = null;
    try {
      db = await openDatabase(file);
      const runtimeA = newRuntime(db, () => saveDatabase(db!, file), 'run_stale_graph');
      runtimeA.ensureDefaultGraph(defaultGraphSpec(NOW));
      const started = expectOk(await runtimeA.startRun(request()));
      await runtimeA.waitForRun(started.runId);
      expect(expectOk(runtimeA.getRun(started.runId)).status).toBe('interrupted');

      // 模拟图内容被替换（同版本号，但 spec 与 digest 都变了）。
      const original = runtimeA.getGraph();
      if (!original.ok) throw new Error('graph missing');
      const changed: GraphSpec = { ...original.data, name: `${original.data.name}（已变更）` };
      const stmt = db.prepare('UPDATE agent_graph SET spec_json = ?, digest = ? WHERE graph_id = ? AND version = ?');
      stmt.run([
        JSON.stringify(changed),
        digestGraphSpec(changed),
        changed.id,
        changed.version
      ]);
      stmt.free();
      saveDatabase(db, file);
      db.close();
      db = null;

      db = await openDatabase(file);
      const runtimeB = newRuntime(db, () => saveDatabase(db!, file), 'run_stale_graph_2');
      expect(runtimeB.markInterruptedFromPreviousProcess()).toEqual({ recoverable: 1, failed: 0 });
      const res = await runtimeB.resumeRun({
        runId: started.runId,
        resolution: { type: 'approve' }
      });
      expect(!res.ok && res.code).toBe('E_RESUME_STALE_GRAPH');
      // 拒绝恢复后仍保持 interrupted，可人工取消；进程不崩溃。
      expect(expectOk(runtimeB.getRun(started.runId)).status).toBe('interrupted');
      expectOk(await runtimeB.cancelRun(started.runId, 'user'));
      expect(expectOk(runtimeB.getRun(started.runId)).status).toBe('canceled');
    } finally {
      db?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('快照缺失或损坏时安全降级为 failed + E_PROCESS_RESTART', async () => {
    const db = new SQL.Database();
    migrate(db);
    const insert = db.prepare(
      `INSERT INTO agent_run (run_id, graph_id, graph_version, thread_id, status, subject_key, subject_label, subject_kind, as_of, started_at, config_json, suspend_json)
       VALUES (?, 'trend-analysis', 4, ?, 'interrupted', 'topic:China', 'China', 'topic', ?, ?, '{}', ?)`
    );
    insert.run(['run_missing_snapshot', 'run_missing_snapshot', NOW, NOW, null]);
    insert.run(['run_corrupt_snapshot', 'run_corrupt_snapshot', NOW, NOW, '{not-json']);
    insert.free();

    const runtime = newRuntime(db, () => {}, 'run_never_used');
    expect(runtime.markInterruptedFromPreviousProcess()).toEqual({ recoverable: 0, failed: 2 });
    for (const id of ['run_missing_snapshot', 'run_corrupt_snapshot']) {
      const detail = expectOk(runtime.getRun(id));
      expect(detail.status).toBe('failed');
      expect(detail.errorCode).toBe('E_PROCESS_RESTART');
    }
    // 缺失快照的 interrupted 也不能再 resume。
    const res = await runtime.resumeRun({ runId: 'run_missing_snapshot', resolution: { type: 'approve' } });
    expect(!res.ok && res.code).toBe('E_RUN_TERMINAL');
    db.close();
  });

  it('重启后 reject：直接 canceled 并写入 review 结论，仍清理挂起快照', async () => {
    const db = new SQL.Database();
    migrate(db);
    const runtimeA = newRuntime(db, () => {}, 'run_reject_after_restart');
    runtimeA.ensureDefaultGraph(defaultGraphSpec(NOW));
    const started = expectOk(await runtimeA.startRun(request()));
    await runtimeA.waitForRun(started.runId);
    expect(expectOk(runtimeA.getRun(started.runId)).status).toBe('interrupted');

    const runtimeB = newRuntime(db, () => {}, 'run_reject_after_restart_2');
    expect(runtimeB.markInterruptedFromPreviousProcess()).toEqual({ recoverable: 1, failed: 0 });
    const res = await runtimeB.resumeRun({
      runId: started.runId,
      resolution: { type: 'reject', reason: '人工驳回' }
    });
    expect(res.ok && res.data.status).toBe('canceled');
    const detail = expectOk(runtimeB.getRun(started.runId));
    expect(detail.status).toBe('canceled');
    expect(detail.decision?.reviewRequired).toBe(true);
    const row = db.prepare('SELECT suspend_json FROM agent_run WHERE run_id = ?');
    row.bind([started.runId]);
    row.step();
    expect((row.getAsObject() as { suspend_json: string | null }).suspend_json).toBeNull();
    row.free();
    db.close();
  });
});
