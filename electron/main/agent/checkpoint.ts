import { BaseCheckpointSaver, copyCheckpoint, type Checkpoint, type CheckpointMetadata, type CheckpointTuple } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { Database } from 'sql.js';

/**
 * P7：LangGraph checkpointer 的 sql.js 实现（thread_id = runId）。
 *
 * 设计要点：
 * 1. 每次 put/putWrites 只写内存 DB，按“每 N 个事件或每 M 毫秒”节流落盘；
 *    终态/审批挂起/启动恢复由调用方 forceFlush()。
 * 2. writes 必须带 task_path，并按 (task_path, task_id, idx) 排序返回，否则并行
 *    分支的 pending writes 在恢复时会被乱序应用（LangGraph 明确要求该顺序）。
 * 3. 所有值都经 serde 序列化为类型 + 文本；不存任何可执行内容。
 */

const WRITES_IDX_MAP: Record<string, number> = {
  __error__: -1,
  __scheduled__: -2,
  __interrupt__: -3,
  __resume__: -4
};

type SqlValue = string | number | null | Uint8Array;
type Row = Record<string, unknown>;

function rows(db: Database, sql: string, params: SqlValue[] = []): Row[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const out: Row[] = [];
  while (stmt.step()) out.push(stmt.getAsObject() as Row);
  stmt.free();
  return out;
}

function one(db: Database, sql: string, params: SqlValue[] = []): Row | null {
  const list = rows(db, sql, params);
  return list[0] ?? null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** code point 比较，与 LangGraph compareWritesSortKeys 的字符串规则一致。 */
function compareCodePoints(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done || y.done) return x.done ? (y.done ? 0 : -1) : 1;
    const cx = x.value.codePointAt(0) as number;
    const cy = y.value.codePointAt(0) as number;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

function compareWrites(
  a: { taskPath: string; taskId: string; idx: number },
  b: { taskPath: string; taskId: string; idx: number }
): number {
  const p = compareCodePoints(a.taskPath, b.taskPath);
  if (p !== 0) return p;
  const t = compareCodePoints(a.taskId, b.taskId);
  if (t !== 0) return t;
  return a.idx === b.idx ? 0 : a.idx < b.idx ? -1 : 1;
}

function encodeValue(type: string, payload: unknown): string {
  // JsonPlusSerializer.dumpsTyped 对 json 返回 Uint8Array（UTF-8 文本），
  // 对 bytes 返回 Uint8Array。必须分别转成文本 / base64，不能 JSON.stringify 整个字节数组。
  if (type === 'bytes') {
    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array();
    return Buffer.from(bytes).toString('base64');
  }
  if (payload instanceof Uint8Array) return new TextDecoder().decode(payload);
  return typeof payload === 'string' ? payload : JSON.stringify(payload);
}

export class CheckpointCorruptError extends Error {
  readonly code = 'E_CHECKPOINT_CORRUPT';
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointCorruptError';
  }
}

export interface CheckpointRunMeta {
  graphId: string;
  graphVersion: number;
  graphDigest: string;
  promptVersion: number;
  promptDigest: string;
  threadId: string;
}

export interface CheckpointStats {
  /** put 次数 = LangGraph superstep checkpoint 数。 */
  puts: number;
  /** putWrites 批次数（一次并行 superstep 可能有多批）。 */
  writeBatches: number;
  /** 写入的 pending write 行数。 */
  writeRows: number;
  /** 由 checkpoint 节流触发的落盘次数。 */
  exports: number;
  /** 因 forceFlush 触发的落盘次数。 */
  forcedExports: number;
  /** 尚未落盘的 checkpoint 事件数。 */
  pendingEvents: number;
}

export interface CheckpointSaverOptions {
  now?: () => string;
  persist: () => void;
  /** 每 N 个 checkpoint 事件至少落盘一次；默认 4。 */
  flushEvery?: number;
  /** 两次落盘的最长间隔；默认 2000ms。 */
  flushIntervalMs?: number;
  /** 测试/崩溃演练用：每个 put/putWrites 都立即落盘。 */
  immediateFlush?: boolean;
}

export class SqlJsCheckpointSaver extends BaseCheckpointSaver {
  private readonly flushEvery: number;
  private readonly flushIntervalMs: number;
  private readonly immediateFlush: boolean;
  private readonly now: () => string;
  private readonly persist: () => void;
  private readonly runMeta?: CheckpointRunMeta;
  private pendingEvents = 0;
  private lastFlushAt = Date.now();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly counters: CheckpointStats = {
    puts: 0,
    writeBatches: 0,
    writeRows: 0,
    exports: 0,
    forcedExports: 0,
    pendingEvents: 0
  };

  constructor(
    private readonly db: Database,
    opts: CheckpointSaverOptions,
    runMeta?: CheckpointRunMeta
  ) {
    super();
    this.persist = opts.persist;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.flushEvery = Math.max(1, opts.flushEvery ?? 4);
    this.flushIntervalMs = Math.max(1, opts.flushIntervalMs ?? 2000);
    this.immediateFlush = opts.immediateFlush ?? false;
    this.runMeta = runMeta;
  }

  stats(): CheckpointStats {
    return { ...this.counters, pendingEvents: this.pendingEvents };
  }

  private markEvent(): void {
    this.pendingEvents += 1;
    this.counters.pendingEvents = this.pendingEvents;
    if (this.immediateFlush) {
      this.flush();
      return;
    }
    const elapsed = Date.now() - this.lastFlushAt;
    if (this.pendingEvents >= this.flushEvery || elapsed >= this.flushIntervalMs) {
      this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, Math.max(0, this.flushIntervalMs - elapsed));
      (this.timer as unknown as { unref?: () => void }).unref?.();
    }
  }

  private flush(force = false): void {
    const hadPending = this.pendingEvents > 0;
    if (!hadPending && !force) return;
    this.pendingEvents = 0;
    this.counters.pendingEvents = 0;
    this.lastFlushAt = Date.now();
    if (force) this.counters.forcedExports += 1;
    else this.counters.exports += 1;
    this.persist();
  }

  /** 终态/中断/续跑前调用：把当前所有 checkpoint 与 writes 立即落盘。 */
  forceFlush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flush(true);
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions?: Record<string, number | string>
  ): Promise<RunnableConfig> {
    const threadId = str(config.configurable?.thread_id);
    if (!threadId) throw new Error('checkpoint put 缺少 thread_id');
    const ns = str(config.configurable?.checkpoint_ns) ?? '';
    const parentId = str(config.configurable?.checkpoint_id) ?? null;
    const copied = copyCheckpoint(checkpoint);
    const [cpType, cpPayload] = await this.serde.dumpsTyped(copied);
    const [mdType, mdPayload] = await this.serde.dumpsTyped(metadata);
    const step = typeof metadata.step === 'number' ? metadata.step : null;
    const at = this.now();
    this.db.run(
      `INSERT OR REPLACE INTO agent_run_checkpoint
        (run_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, serde_type, checkpoint_json,
         metadata_type, metadata_json, run_meta_json, step, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        threadId,
        ns,
        checkpoint.id,
        parentId,
        cpType,
        encodeValue(cpType, cpPayload),
        mdType,
        encodeValue(mdType, mdPayload),
        JSON.stringify(this.runMeta ?? null),
        step,
        at
      ]
    );
    this.counters.puts += 1;
    this.markEvent();
    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: ns,
        checkpoint_id: checkpoint.id
      }
    } as RunnableConfig;
  }

  async putWrites(
    config: RunnableConfig,
    writes: Array<[string, unknown]>,
    taskId: string,
    taskPath?: string
  ): Promise<void> {
    const threadId = str(config.configurable?.thread_id);
    if (!threadId) throw new Error('checkpoint putWrites 缺少 thread_id');
    const ns = str(config.configurable?.checkpoint_ns) ?? '';
    const checkpointId = str(config.configurable?.checkpoint_id);
    if (!checkpointId) throw new Error('checkpoint putWrites 缺少 checkpoint_id');
    const path = taskPath ?? '';
    for (let i = 0; i < writes.length; i += 1) {
      const [channel, value] = writes[i];
      const mapped = WRITES_IDX_MAP[channel] ?? i;
      const [type, payload] = await this.serde.dumpsTyped(value);
      // 普通写入同一 idx 重复保存视为已保存（与 MemorySaver 一致）；
      // 特殊负索引允许覆盖（错误/interrupt 等）。
      this.db.run(
        mapped >= 0
          ? `INSERT OR IGNORE INTO agent_run_checkpoint_write
              (run_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, serde_type, value_json, task_path)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          : `INSERT OR REPLACE INTO agent_run_checkpoint_write
              (run_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, serde_type, value_json, task_path)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [threadId, ns, checkpointId, taskId, mapped, channel, type, encodeValue(type, payload), path]
      );
      this.counters.writeRows += 1;
    }
    this.counters.writeBatches += 1;
    this.markEvent();
  }

  private async decode(type: string, text: string): Promise<unknown> {
    if (type === 'bytes') {
      return this.serde.loadsTyped(type, new Uint8Array(Buffer.from(text, 'base64')));
    }
    return this.serde.loadsTyped(type, text);
  }

  private async toTuple(row: Row): Promise<CheckpointTuple> {
    const threadId = row.run_id as string;
    const ns = row.checkpoint_ns as string;
    const checkpointId = row.checkpoint_id as string;
    let checkpoint: Checkpoint;
    let metadata: CheckpointMetadata;
    try {
      checkpoint = (await this.decode(row.serde_type as string, row.checkpoint_json as string)) as Checkpoint;
      metadata = (await this.decode(
        row.metadata_type as string,
        row.metadata_json as string
      )) as CheckpointMetadata;
    } catch (err) {
      throw new CheckpointCorruptError(
        `checkpoint ${checkpointId} 无法反序列化: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (
      !checkpoint ||
      typeof checkpoint !== 'object' ||
      typeof checkpoint.id !== 'string' ||
      typeof checkpoint.channel_values !== 'object' ||
      checkpoint.channel_values === null
    ) {
      throw new CheckpointCorruptError(`checkpoint ${checkpointId} 结构非法`);
    }
    const writeRows = rows(
      this.db,
      `SELECT task_id, idx, channel, serde_type, value_json, task_path
         FROM agent_run_checkpoint_write
        WHERE run_id=? AND checkpoint_ns=? AND checkpoint_id=?`,
      [threadId, ns, checkpointId]
    );
    const pending = writeRows
      .map((w) => ({
        taskPath: str(w.task_path) ?? '',
        taskId: w.task_id as string,
        idx: num(w.idx) ?? 0,
        channel: w.channel as string,
        serdeType: w.serde_type as string,
        value: w.value_json as string
      }))
      .sort(compareWrites);
    const pendingWrites: Array<[string, string, unknown]> = [];
    for (const w of pending) {
      pendingWrites.push([w.taskId, w.channel, await this.decode(w.serdeType, w.value)]);
    }
    const tuple: CheckpointTuple = {
      config: {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: ns,
          checkpoint_id: checkpointId
        }
      } as RunnableConfig,
      checkpoint,
      metadata,
      pendingWrites
    };
    if (row.parent_checkpoint_id) {
      tuple.parentConfig = {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: ns,
          checkpoint_id: row.parent_checkpoint_id as string
        }
      } as RunnableConfig;
    }
    return tuple;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = str(config.configurable?.thread_id);
    if (!threadId) return undefined;
    const ns = str(config.configurable?.checkpoint_ns) ?? '';
    const checkpointId = str(config.configurable?.checkpoint_id);
    const row = checkpointId
      ? one(
          this.db,
          `SELECT * FROM agent_run_checkpoint WHERE run_id=? AND checkpoint_ns=? AND checkpoint_id=?`,
          [threadId, ns, checkpointId]
        )
      : one(
          this.db,
          `SELECT * FROM agent_run_checkpoint WHERE run_id=? AND checkpoint_ns=?
            ORDER BY checkpoint_id DESC LIMIT 1`,
          [threadId, ns]
        );
    if (!row) return undefined;
    return this.toTuple(row);
  }

  async *list(
    config: RunnableConfig,
    options: { limit?: number; before?: RunnableConfig; filter?: Record<string, unknown> } = {}
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = str(config.configurable?.thread_id);
    const ns = str(config.configurable?.checkpoint_ns) ?? '';
    const beforeId = str(options.before?.configurable?.checkpoint_id);
    const limit = options.limit;
    const conds: string[] = [];
    const params: SqlValue[] = [];
    if (threadId) {
      conds.push('run_id=?');
      params.push(threadId);
    }
    conds.push('checkpoint_ns=?');
    params.push(ns);
    if (beforeId) {
      conds.push('checkpoint_id<?');
      params.push(beforeId);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const list = rows(
      this.db,
      `SELECT * FROM agent_run_checkpoint ${where} ORDER BY checkpoint_id DESC${
        typeof limit === 'number' ? ' LIMIT ?' : ''
      }`,
      typeof limit === 'number' ? [...params, Math.max(0, limit)] : params
    );
    for (const row of list) {
      const tuple = await this.toTuple(row);
      if (options.filter && tuple.metadata) {
        const matched = Object.entries(options.filter).every(
          ([k, v]) => (tuple.metadata as Record<string, unknown>)[k] === v
        );
        if (!matched) continue;
      }
      yield tuple;
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    this.db.run(`DELETE FROM agent_run_checkpoint_write WHERE run_id=?`, [threadId]);
    this.db.run(`DELETE FROM agent_run_checkpoint WHERE run_id=?`, [threadId]);
    this.persist();
  }
}

export interface CheckpointInspection {
  ok: boolean;
  reason?: 'missing' | 'corrupt';
  checkpointId?: string;
  step?: number;
  runMeta?: CheckpointRunMeta;
}

/** 同步检查最新 checkpoint 是否结构完整，供启动恢复使用（不反序列化整棵状态）。 */
export function inspectLatestCheckpoint(db: Database, runId: string): CheckpointInspection {
  const row = one(
    db,
    `SELECT checkpoint_id, checkpoint_json, run_meta_json, step
       FROM agent_run_checkpoint
      WHERE run_id=? AND checkpoint_ns=''
      ORDER BY checkpoint_id DESC LIMIT 1`,
    [runId]
  );
  if (!row) return { ok: false, reason: 'missing' };
  let checkpoint: unknown;
  try {
    checkpoint = JSON.parse(row.checkpoint_json as string);
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
  if (
    typeof checkpoint !== 'object' ||
    checkpoint === null ||
    typeof (checkpoint as { id?: unknown }).id !== 'string' ||
    typeof (checkpoint as { channel_values?: unknown }).channel_values !== 'object' ||
    (checkpoint as { channel_values?: unknown }).channel_values === null
  ) {
    return { ok: false, reason: 'corrupt' };
  }
  let runMeta: CheckpointRunMeta | undefined;
  try {
    runMeta = JSON.parse(row.run_meta_json as string) as CheckpointRunMeta;
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
  return {
    ok: true,
    checkpointId: row.checkpoint_id as string,
    step: num(row.step),
    runMeta
  };
}
