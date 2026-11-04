import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import {
  CheckpointCorruptError,
  SqlJsCheckpointSaver,
  inspectLatestCheckpoint
} from '../electron/main/agent/checkpoint.js';

const NOW = '2026-11-03T00:00:00.000Z';

function checkpoint(id: string, values: Record<string, unknown>): Checkpoint {
  return {
    v: 4,
    id,
    ts: NOW,
    channel_values: values,
    channel_versions: { v: 1 },
    versions_seen: {}
  };
}

function metadata(step: number): CheckpointMetadata {
  return { source: 'loop', step, writes: {}, parents: {} } as CheckpointMetadata;
}

describe('SqlJsCheckpointSaver', () => {
  let db: Database;
  let SQL: { Database: new () => Database };

  beforeAll(async () => {
    SQL = await initSqlJs();
    db = new SQL.Database();
    migrate(db);
  });

  afterAll(() => {
    db.close();
  });

  function freshSaver(opts: { flushEvery?: number; flushIntervalMs?: number; immediate?: boolean } = {}) {
    let persistCalls = 0;
    const saver = new SqlJsCheckpointSaver(db, {
      flushEvery: opts.flushEvery ?? 4,
      flushIntervalMs: opts.flushIntervalMs ?? 60_000,
      immediateFlush: opts.immediate ?? false,
      persist: () => {
        persistCalls += 1;
      }
    });
    return { saver, persist: () => persistCalls };
  }

  it('put/getTuple 往返：值可解码，writes 按 (task_path, task_id, idx) 排序', async () => {
    const { saver } = freshSaver();
    const runId = 'run-unit-a';
    const config = { configurable: { thread_id: runId } };
    const cp1 = checkpoint('c1', { alpha: { hello: 'world' }, beta: [1, 2, 3] });
    await saver.put(config, cp1, metadata(1));
    await saver.putWrites(
      { configurable: { thread_id: runId, checkpoint_id: 'c1' } },
      [['gamma', { n: 1 }]],
      'task-b',
      'task-path-b'
    );
    await saver.putWrites(
      { configurable: { thread_id: runId, checkpoint_id: 'c1' } },
      [
        ['alpha', 'a0'],
        ['alpha', 'a1']
      ],
      'task-a',
      'task-path-a'
    );

    const tuple = await saver.getTuple({ configurable: { thread_id: runId, checkpoint_id: 'c1' } });
    expect(tuple).toBeDefined();
    const values = tuple!.checkpoint.channel_values as Record<string, unknown>;
    expect(values.alpha).toEqual({ hello: 'world' });
    expect(values.beta).toEqual([1, 2, 3]);
    expect((tuple!.metadata as { step?: number } | undefined)?.step).toBe(1);
    const writes = tuple!.pendingWrites ?? [];
    // 任务路径 a 先于 b；同一任务内 idx 升序。
    expect(writes.map((w) => [w[0], w[1], w[2]])).toEqual([
      ['task-a', 'alpha', 'a0'],
      ['task-a', 'alpha', 'a1'],
      ['task-b', 'gamma', { n: 1 }]
    ]);
  });

  it('getTuple 默认返回最新 checkpoint，list 逆序且可限量', async () => {
    const { saver } = freshSaver();
    const runId = 'run-unit-b';
    await saver.put({ configurable: { thread_id: runId } }, checkpoint('c1', { n: 1 }), metadata(1));
    await saver.put({ configurable: { thread_id: runId } }, checkpoint('c2', { n: 2 }), metadata(2));
    await saver.put({ configurable: { thread_id: runId } }, checkpoint('c3', { n: 3 }), metadata(3));

    const latest = await saver.getTuple({ configurable: { thread_id: runId } });
    expect(latest!.checkpoint.id).toBe('c3');

    const listed: string[] = [];
    for await (const tuple of saver.list({ configurable: { thread_id: runId } }, { limit: 2 })) {
      listed.push(tuple.checkpoint.id);
    }
    expect(listed).toEqual(['c3', 'c2']);
  });

  it('特殊负索引 writes 覆盖写入，普通 idx 只写一次（与 MemorySaver 语义一致）', async () => {
    const { saver } = freshSaver();
    const runId = 'run-unit-c';
    const cfg = { configurable: { thread_id: runId, checkpoint_id: 'c1' } };
    await saver.put({ configurable: { thread_id: runId } }, checkpoint('c1', {}), metadata(1));
    await saver.putWrites(cfg, [['k', 'first']], 'task-x', 'p');
    await saver.putWrites(cfg, [['k', 'second']], 'task-x', 'p');
    // 负索引 __error__ = -1：再次写入必须覆盖。
    await saver.putWrites(cfg, [['__error__', 'e1']], 'task-x', 'p');
    await saver.putWrites(cfg, [['__error__', 'e2']], 'task-x', 'p');

    const writes = (await saver.getTuple(cfg))!.pendingWrites ?? [];
    const normal = writes.filter((w) => w[1] === 'k');
    const errored = writes.filter((w) => w[1] === '__error__');
    expect(normal).toHaveLength(1);
    expect(normal[0][2]).toBe('first');
    expect(errored).toHaveLength(1);
    expect(errored[0][2]).toBe('e2');
  });

  it('损坏 checkpoint：getTuple 抛可枚举错误，inspect 返回 corrupt', async () => {
    const { saver } = freshSaver();
    const runId = 'run-unit-corrupt';
    await saver.put({ configurable: { thread_id: runId } }, checkpoint('c1', { ok: true }), metadata(1));
    db.run(`UPDATE agent_run_checkpoint SET checkpoint_json='{not-json' WHERE run_id='${runId}'`);

    await expect(saver.getTuple({ configurable: { thread_id: runId } })).rejects.toBeInstanceOf(
      CheckpointCorruptError
    );
    const inspect = inspectLatestCheckpoint(db, runId);
    expect(inspect.ok).toBe(false);
    expect(inspect.reason).toBe('corrupt');
    expect(inspectLatestCheckpoint(db, 'run-unit-missing')).toMatchObject({
      ok: false,
      reason: 'missing'
    });
  });

  it('deleteThread 同时清理 checkpoint 与 writes', async () => {
    const { saver } = freshSaver();
    const runId = 'run-unit-delete';
    const cfg = { configurable: { thread_id: runId } };
    await saver.put(cfg, checkpoint('c1', { n: 1 }), metadata(1));
    await saver.putWrites(
      { configurable: { thread_id: runId, checkpoint_id: 'c1' } },
      [['n', 1]],
      't',
      'p'
    );
    await saver.deleteThread(runId);
    expect(await saver.getTuple(cfg)).toBeUndefined();
    expect(inspectLatestCheckpoint(db, runId).reason).toBe('missing');
    const left = db.exec(
      `SELECT COUNT(*) FROM agent_run_checkpoint_write WHERE run_id='${runId}'`
    )[0].values[0][0] as number;
    expect(left).toBe(0);
  });

  it('节流：每 flushEvery 个事件落盘一次，终态 forceFlush 强制落盘', async () => {
    const { saver, persist } = freshSaver({ flushEvery: 4 });
    const runId = 'run-unit-throttle';
    const cfg = { configurable: { thread_id: runId } };
    for (let i = 1; i <= 5; i += 1) {
      await saver.put(cfg, checkpoint(`c${i}`, { i }), metadata(i));
    }
    let stats = saver.stats();
    expect(stats.puts).toBe(5);
    expect(persist()).toBe(1); // 第 4 个事件触发一次合并落盘
    expect(stats.pendingEvents).toBe(1);

    saver.forceFlush();
    stats = saver.stats();
    expect(persist()).toBe(2);
    expect(stats.forcedExports).toBe(1);
    expect(stats.pendingEvents).toBe(0);
  });

  it('immediate 模式：每个写入事件都立即落盘（崩溃窗口为 0 事件）', async () => {
    const { saver, persist } = freshSaver({ immediate: true });
    const runId = 'run-unit-immediate';
    const cfg = { configurable: { thread_id: runId } };
    await saver.put(cfg, checkpoint('c1', { n: 1 }), metadata(1));
    await saver.putWrites(
      { configurable: { thread_id: runId, checkpoint_id: 'c1' } },
      [['n', 1]],
      't',
      'p'
    );
    expect(persist()).toBe(2);
    expect(saver.stats().pendingEvents).toBe(0);
  });
});

describe('并行分支 pending writes 断点恢复（真实 StateGraph）', () => {
  let db: Database;

  beforeAll(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    migrate(db);
  });

  afterAll(() => {
    db.close();
  });

  const State = Annotation.Root({
    a: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
    b: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
    c: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 })
  });

  const NEVER = new Promise<void>(() => {});
  const runs = { a: 0, b: 0, c: 0 };

  function buildGraph(saver: SqlJsCheckpointSaver, blockB: boolean) {
    const graph = new StateGraph(State)
      .addNode('na', () => {
        runs.a += 1;
        return { a: 1 };
      })
      .addNode('nb', async () => {
        runs.b += 1;
        if (blockB) await NEVER;
        return { b: 1 };
      })
      .addNode('nc', () => {
        runs.c += 1;
        return { c: 1 };
      })
      .addEdge(START, 'na')
      .addEdge(START, 'nb')
      .addEdge(START, 'nc')
      .addEdge('na', END)
      .addEdge('nb', END)
      .addEdge('nc', END);
    return graph.compile({ checkpointer: saver });
  }

  it('一个分支完成、另一个未完成时中断：恢复后不重跑已完成分支，也不丢未完成分支', async () => {
    const thread = 'parallel-run-1';
    const config = { configurable: { thread_id: thread } };
    const saverA = new SqlJsCheckpointSaver(db, { immediateFlush: true, persist: () => {} });
    const graphA = buildGraph(saverA, true);

    // 不 await：模拟进程在 b 分支挂起时被杀。输入必须非空，
    // LangGraph 才会写出第一份 source=input 的 checkpoint（无 checkpoint 无法续跑）。
    void graphA.invoke({ a: 0 }, config).catch(() => {});

    await waitFor(() => runs.a >= 1 && runs.c >= 1 && runs.b >= 1, 30_000);
    await waitFor(() => writeRowCount(db, thread) >= 2, 30_000);

    // “进程重启”：新的 saver 实例读取同一个 DB 中的 checkpoint/writes。
    const saverB = new SqlJsCheckpointSaver(db, { immediateFlush: true, persist: () => {} });
    const graphB = buildGraph(saverB, false);
    const result = (await graphB.invoke(null, config)) as { a: number; b: number; c: number };

    expect(result).toEqual({ a: 1, b: 1, c: 1 });
    // a / c 已完成分支绝不重跑；b 只在恢复时补跑一次。
    expect(runs.a).toBe(1);
    expect(runs.c).toBe(1);
    expect(runs.b).toBe(2);
  }, 60_000);
});

function writeRowCount(db: Database, runId: string): number {
  const res = db.exec(
    `SELECT COUNT(*) FROM agent_run_checkpoint_write WHERE run_id='${runId}'`
  );
  return res[0] ? (res[0].values[0][0] as number) : 0;
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}
