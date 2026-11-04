import type { Database } from 'sql.js';
import type {
  AgentErrorCode,
  AgentGraphStatus,
  AgentGraphSummary,
  AgentGraphVersionSummary,
  AgentNodeResultView,
  AgentPromptPackSnapshot,
  AgentPromptPackView,
  AgentPromptRole,
  AgentRunDetail,
  AgentRunRecovery,
  AgentRunStatus,
  AgentRunSummary,
  AgentSubject,
  ApprovalContext,
  FinalDecision,
  GraphNodeSpec,
  GraphSpec,
  MemoryInjection,
  ObservationPlan,
  RunEventEnvelope,
  RunOptions,
  RunUsage,
  TrendRating
} from '../../../shared/agent.js';
import { PROMPT_MAX_RENDERED_CHARS, PROMPT_MAX_SYSTEM_CHARS, PROMPT_PLACEHOLDERS } from '../../../shared/agent.js';
import { inspectLatestCheckpoint } from './checkpoint.js';
import { digestGraphSpec } from './spec.js';
import {
  DEFAULT_PROMPT_TEMPLATES,
  defaultPromptDigest,
  digestPromptOverrides,
  normalizePromptOverrides
} from './prompt-policy.js';

type Row = Record<string, unknown>;
type SqlParam = string | number | null | Uint8Array;

function readJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rows(db: Database, sql: string, params: SqlParam[] = []): Row[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const out: Row[] = [];
  while (stmt.step()) out.push(stmt.getAsObject() as Row);
  stmt.free();
  return out;
}

function one(db: Database, sql: string, params: SqlParam[] = []): Row | null {
  const list = rows(db, sql, params);
  return list[0] ?? null;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function toSummary(r: Row): AgentRunSummary {
  return {
    runId: r.run_id as string,
    graphId: r.graph_id as string,
    graphVersion: num(r.graph_version, 1),
    graphDigest: str(r.graph_digest),
    promptVersion: num(r.prompt_version, 0),
    promptDigest: str(r.prompt_digest),
    status: r.status as AgentRunStatus,
    subject: {
      key: r.subject_key as string,
      label: r.subject_label as string,
      kind: r.subject_kind as AgentSubject['kind']
    },
    asOf: r.as_of as string,
    startedAt: r.started_at as string,
    endedAt: str(r.ended_at),
    rating: (str(r.rating) as TrendRating | undefined) ?? undefined,
    reviewRequired: num(r.review_required) === 1,
    errorCode: (str(r.error_code) as AgentErrorCode | undefined) ?? undefined
  };
}

function toNodeView(r: Row): AgentNodeResultView {
  return {
    nodeId: r.node_id as string,
    nodeType: r.node_type as AgentNodeResultView['nodeType'],
    attempt: num(r.attempt, 1),
    status: r.status as AgentNodeResultView['status'],
    startedAt: str(r.started_at),
    endedAt: str(r.ended_at),
    elapsedMs: typeof r.elapsed_ms === 'number' ? r.elapsed_ms : undefined,
    inputSummary: str(r.input_summary),
    output: readJson<Record<string, unknown> | undefined>(r.output_json, undefined),
    errorCode: (str(r.error_code) as AgentErrorCode | undefined) ?? undefined,
    errorMessage: str(r.error_message)
  };
}

export interface RunInsert {
  runId: string;
  graphId: string;
  graphVersion: number;
  graphDigest: string;
  threadId: string;
  subject: AgentSubject;
  asOf: string;
  startedAt: string;
  config: RunOptions;
  model: string;
  /** P6：运行绑定的 prompt 快照；缺省为内置默认版本 0。 */
  prompt?: AgentPromptPackSnapshot;
}

export interface RunTerminal {
  runId: string;
  status: AgentRunStatus;
  endedAt: string;
  state?: unknown;
  errorCode?: AgentErrorCode;
  errorMessage?: string;
  rating?: TrendRating;
  reviewRequired?: boolean;
  usage?: RunUsage;
}

export interface NodeStartRecord {
  runId: string;
  nodeId: string;
  nodeType: string;
  attempt: number;
  startedAt: string;
  inputSummary?: string;
}

export interface NodeFinishRecord {
  runId: string;
  nodeId: string;
  attempt: number;
  status: 'succeeded' | 'failed' | 'skipped';
  endedAt: string;
  elapsedMs: number;
  output?: unknown;
  errorCode?: AgentErrorCode;
  errorMessage?: string;
}

export interface AgentGraphRecord {
  spec: GraphSpec;
  status: AgentGraphStatus;
  isActive: boolean;
  digest: string;
}

/** P5：审批挂起快照。只保存“恢复 final 审批”所需的最小状态，
 *  不保存 LangGraph checkpoint，不含任何可执行代码。 */
export interface RunSuspendSnapshot {
  v: 1;
  graphId: string;
  graphVersion: number;
  graphDigest: string;
  subject: AgentSubject;
  asOf: string;
  options: RunOptions;
  isMock: boolean;
  /** 已落库的状态快照（不含 usage；usage 单独存）。 */
  state: Record<string, unknown>;
  approval: ApprovalContext;
  finalNodeId: string;
  /** interrupt 时 final 节点的尝试次数；恢复后下一次为 attempt + 1。 */
  attempt: number;
  usage: RunUsage;
  suspendedAt: string;
  /** P6：跨进程恢复时沿用原 prompt 快照，避免回放串味；旧快照缺省为版本 0。 */
  prompt?: AgentPromptPackSnapshot;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 严格校验挂起快照；任何损坏都返回 null，由调用方安全降级为 failed。 */
export function parseSuspendSnapshot(raw: unknown): RunSuspendSnapshot | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(value) || value.v !== 1) return null;
  if (typeof value.graphId !== 'string' || value.graphId.length === 0) return null;
  if (!Number.isInteger(value.graphVersion) || (value.graphVersion as number) < 1) return null;
  if (typeof value.graphDigest !== 'string' || value.graphDigest.length === 0) return null;
  if (!isPlainObject(value.subject)) return null;
  const subject = value.subject;
  if (
    typeof subject.key !== 'string' ||
    typeof subject.label !== 'string' ||
    (subject.kind !== 'topic' && subject.kind !== 'country' && subject.kind !== 'event')
  ) {
    return null;
  }
  if (typeof value.asOf !== 'string' || !Number.isFinite(Date.parse(value.asOf))) return null;
  if (!isPlainObject(value.options)) return null;
  if (typeof value.isMock !== 'boolean') return null;
  if (!isPlainObject(value.state)) return null;
  if (!isPlainObject(value.approval) || value.approval.stage !== 'final_approval') return null;
  if (typeof value.finalNodeId !== 'string' || value.finalNodeId.length === 0) return null;
  if (!Number.isInteger(value.attempt) || (value.attempt as number) < 1) return null;
  if (!isPlainObject(value.usage)) return null;
  if (typeof value.suspendedAt !== 'string') return null;
  if (value.prompt !== undefined) {
    if (!isPlainObject(value.prompt)) return null;
    const prompt = value.prompt;
    if (!Number.isInteger(prompt.version) || (prompt.version as number) < 0) return null;
    if (typeof prompt.digest !== 'string' || prompt.digest.length === 0) return null;
    if (!isPlainObject(prompt.prompts)) return null;
  }
  return value as unknown as RunSuspendSnapshot;
}

/** P7：严格校验断点恢复元数据；缺少任一关键字段都视为不可恢复。 */
export function parseRunRecovery(raw: unknown): AgentRunRecovery | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(value) || value.v !== 1 || value.kind !== 'checkpoint') return null;
  if (typeof value.checkpointId !== 'string' || value.checkpointId.length === 0) return null;
  if (!Number.isInteger(value.checkpointStep)) return null;
  if (typeof value.graphId !== 'string' || value.graphId.length === 0) return null;
  if (!Number.isInteger(value.graphVersion) || (value.graphVersion as number) < 1) return null;
  if (typeof value.graphDigest !== 'string' || value.graphDigest.length === 0) return null;
  if (!Number.isInteger(value.promptVersion) || (value.promptVersion as number) < 0) return null;
  if (typeof value.promptDigest !== 'string' || value.promptDigest.length === 0) return null;
  if (typeof value.threadId !== 'string' || value.threadId.length === 0) return null;
  if (typeof value.isMock !== 'boolean') return null;
  if (!isPlainObject(value.usage)) return null;
  if (typeof value.recoveredAt !== 'string' || !Number.isFinite(Date.parse(value.recoveredAt))) return null;
  return value as unknown as AgentRunRecovery;
}

export interface AgentRepository {
  ensureDefaultGraph(spec: GraphSpec): boolean;
  getGraph(graphId: string, version?: number): GraphSpec | null;
  /** P4：读取 active published（或指定版本）并附带摘要。 */
  getGraphRecord(graphId: string, version?: number): AgentGraphRecord | null;
  listGraphs(): AgentGraphVersionSummary[];
  saveGraph(spec: GraphSpec, publish: boolean): AgentGraphRecord;
  deleteGraph(graphId: string, version: number): { promotedVersion?: number };
  /** 恢复默认图：写入指定版本并设为 active，保留其他历史版本。 */
  restoreDefaultGraph(spec: GraphSpec): AgentGraphRecord;
  countRunsForGraphVersion(graphId: string, version: number): number;
  /** P6：当前生效的 prompt 版本包；无覆盖时为版本 0 的内置默认。 */
  getActivePromptPack(): AgentPromptPackView;
  /** P6：保存新的不可变 prompt 版本包；内容未变化时复用当前版本。 */
  savePromptPack(prompts: Partial<Record<AgentPromptRole, string>>): AgentPromptPackView;
  insertRun(rec: RunInsert): void;
  updateRunTerminal(rec: RunTerminal): void;
  /** 非终态迁移（interrupted）：保留 ended_at 为空，写入状态快照与已消耗用量。 */
  updateRunInterrupted(runId: string, state: unknown, usage: RunUsage): void;
  /** P7：节点完成即累加用量，保证续跑不重置预算。 */
  updateRunUsage(runId: string, usage: RunUsage): void;
  getRunUsage(runId: string): RunUsage;
  /** P5：写入/读取/清理审批挂起快照。 */
  setRunSuspend(runId: string, snapshotJson: string): void;
  getRunSuspend(runId: string): string | null;
  clearRunSuspend(runId: string): void;
  /** P7：断点续跑恢复元数据的读写。 */
  getRunRecovery(runId: string): AgentRunRecovery | null;
  clearRunRecovery(runId: string): void;
  /** P7：run 绑定的 prompt 快照（用于恢复时校验版本/摘要）。 */
  getRunPromptSnapshot(runId: string): AgentPromptPackSnapshot | null;
  /** P7：各节点已出现的最大 attempt，恢复时新尝试从 +1 开始。 */
  getNodeAttemptBases(runId: string): Record<string, number>;
  /** P7：终态/取消后清理该 run 的 checkpoint 线程数据。 */
  deleteRunCheckpoints(runId: string): void;
  /** P5：重启后把状态改为 running（保留 suspend，终态时清理）。 */
  updateRunResumed(runId: string): void;
  writeEvent(envelope: RunEventEnvelope): void;
  listEvents(runId: string, afterSeq?: number): RunEventEnvelope[];
  startNode(rec: NodeStartRecord): void;
  finishNode(rec: NodeFinishRecord): void;
  saveDecision(runId: string, subject: AgentSubject, asOf: string, decision: FinalDecision): void;
  listRuns(limit?: number): AgentRunSummary[];
  getRunDetail(runId: string): AgentRunDetail | null;
  /** P5：进程启动清理。有合法挂起快照的 interrupted 保留可恢复，其余标记失败。 */
  recoverPreviousProcessRuns(at: string): { recoverable: number; failed: number };
  getMaxSeq(runId: string): number;
}

/** persist 由调用方注入（主进程用 saveDatabase，测试用空函数）。 */
export function createAgentRepository(db: Database, persist: () => void): AgentRepository {
  function promptPackViewFrom(row: Row | null | undefined): AgentPromptPackView {
    const base = {
      defaults: DEFAULT_PROMPT_TEMPLATES,
      limits: { maxSystemChars: PROMPT_MAX_SYSTEM_CHARS, maxRenderedChars: PROMPT_MAX_RENDERED_CHARS },
      placeholders: PROMPT_PLACEHOLDERS
    };
    if (!row) {
      return {
        version: 0,
        digest: defaultPromptDigest(),
        prompts: {},
        isDefault: true,
        createdAt: '',
        updatedAt: '',
        ...base
      };
    }
    const prompts = readJson<Partial<Record<AgentPromptRole, string>>>(row.prompts_json, {});
    return {
      version: num(row.version, 0),
      digest: str(row.digest) ?? defaultPromptDigest(),
      prompts,
      isDefault: Object.keys(prompts).length === 0,
      createdAt: str(row.created_at) ?? '',
      updatedAt: str(row.updated_at) ?? '',
      ...base
    };
  }

  function graphRecordFrom(r: Row): AgentGraphRecord {
    const spec = readJson<GraphSpec | null>(r.spec_json, null);
    if (!spec) throw new Error(`agent_graph 记录损坏: ${String(r.graph_id)} v${String(r.version)}`);
    return {
      spec,
      status: (str(r.status) as AgentGraphStatus | undefined) ?? 'published',
      isActive: num(r.is_active) === 1,
      digest: str(r.digest) ?? digestGraphSpec(spec)
    };
  }

  function insertGraph(spec: GraphSpec, status: AgentGraphStatus, active: boolean, digest: string): void {
    const stmt = db.prepare(
      `INSERT INTO agent_graph
         (graph_id, version, name, description, spec_json, is_active, status, digest, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(graph_id, version) DO UPDATE SET
         name = excluded.name, description = excluded.description, spec_json = excluded.spec_json,
         is_active = excluded.is_active, status = excluded.status, digest = excluded.digest,
         updated_at = excluded.updated_at`
    );
    stmt.run([
      spec.id,
      spec.version,
      spec.name,
      spec.description ?? null,
      JSON.stringify(spec),
      active ? 1 : 0,
      status,
      digest,
      spec.createdAt,
      spec.updatedAt
    ]);
    stmt.free();
  }

  const repo: AgentRepository = {
    ensureDefaultGraph(spec) {
      const exists = one(db, 'SELECT graph_id FROM agent_graph WHERE graph_id = ? AND version = ?', [
        spec.id,
        spec.version
      ]);
      if (exists) return false;
      const clear = db.prepare('UPDATE agent_graph SET is_active = 0 WHERE graph_id = ?');
      clear.run([spec.id]);
      clear.free();
      insertGraph(spec, 'published', true, digestGraphSpec(spec));
      persist();
      return true;
    },

    getGraph(graphId, version) {
      return repo.getGraphRecord(graphId, version)?.spec ?? null;
    },

    getGraphRecord(graphId, version) {
      const row = version
        ? one(db, 'SELECT * FROM agent_graph WHERE graph_id = ? AND version = ?', [graphId, version])
        : one(
            db,
            `SELECT * FROM agent_graph WHERE graph_id = ? AND is_active = 1
             ORDER BY version DESC LIMIT 1`,
            [graphId]
          ) ??
          one(db, 'SELECT * FROM agent_graph WHERE graph_id = ? ORDER BY version DESC LIMIT 1', [graphId]);
      return row ? graphRecordFrom(row) : null;
    },

    listGraphs() {
      return rows(db, 'SELECT * FROM agent_graph ORDER BY graph_id ASC, version DESC').map((r) => {
        const rec = graphRecordFrom(r);
        const out: AgentGraphVersionSummary = {
          id: rec.spec.id,
          version: rec.spec.version,
          name: rec.spec.name,
          description: rec.spec.description,
          updatedAt: rec.spec.updatedAt,
          createdAt: rec.spec.createdAt,
          status: rec.status,
          isActive: rec.isActive,
          digest: rec.digest
        };
        return out;
      });
    },

    saveGraph(spec, publish) {
      if (publish) {
        const stmt = db.prepare('UPDATE agent_graph SET is_active = 0 WHERE graph_id = ?');
        stmt.run([spec.id]);
        stmt.free();
      }
      const digest = digestGraphSpec(spec);
      insertGraph(spec, publish ? 'published' : 'draft', publish, digest);
      persist();
      return { spec, status: publish ? 'published' : 'draft', isActive: publish, digest };
    },

    deleteGraph(graphId, version) {
      const target = one(db, 'SELECT * FROM agent_graph WHERE graph_id = ? AND version = ?', [
        graphId,
        version
      ]);
      if (!target) throw new Error(`图版本不存在: ${graphId} v${version}`);
      const stmt = db.prepare('DELETE FROM agent_graph WHERE graph_id = ? AND version = ?');
      stmt.run([graphId, version]);
      stmt.free();
      let promotedVersion: number | undefined;
      if (num(target.is_active) === 1) {
        const next = one(
          db,
          `SELECT version FROM agent_graph WHERE graph_id = ? AND status = 'published'
           ORDER BY version DESC LIMIT 1`,
          [graphId]
        );
        if (next) {
          promotedVersion = num(next.version);
          const up = db.prepare('UPDATE agent_graph SET is_active = 1 WHERE graph_id = ? AND version = ?');
          up.run([graphId, promotedVersion]);
          up.free();
        }
      }
      persist();
      return { promotedVersion };
    },

    restoreDefaultGraph(spec) {
      const clear = db.prepare('UPDATE agent_graph SET is_active = 0 WHERE graph_id = ?');
      clear.run([spec.id]);
      clear.free();
      const digest = digestGraphSpec(spec);
      insertGraph(spec, 'published', true, digest);
      persist();
      return { spec, status: 'published', isActive: true, digest };
    },

    countRunsForGraphVersion(graphId, version) {
      const row = one(db, 'SELECT COUNT(*) AS n FROM agent_run WHERE graph_id = ? AND graph_version = ?', [
        graphId,
        version
      ]);
      return num(row?.n, 0);
    },

    getActivePromptPack() {
      const row = one(
        db,
        'SELECT * FROM agent_prompt_pack WHERE is_active = 1 ORDER BY version DESC LIMIT 1'
      );
      return promptPackViewFrom(row);
    },

    savePromptPack(prompts) {
      const normalized = normalizePromptOverrides(prompts);
      const digest = digestPromptOverrides(normalized);
      const current = one(
        db,
        'SELECT * FROM agent_prompt_pack WHERE is_active = 1 ORDER BY version DESC LIMIT 1'
      );
      if (current && (str(current.digest) ?? '') === digest) {
        return promptPackViewFrom(current);
      }
      const now = new Date().toISOString();
      db.exec('UPDATE agent_prompt_pack SET is_active = 0 WHERE is_active = 1');
      const stmt = db.prepare(
        `INSERT INTO agent_prompt_pack (digest, prompts_json, is_active, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)`
      );
      stmt.run([digest, JSON.stringify(normalized), now, now]);
      stmt.free();
      persist();
      const inserted = one(
        db,
        'SELECT * FROM agent_prompt_pack WHERE is_active = 1 ORDER BY version DESC LIMIT 1'
      );
      return promptPackViewFrom(inserted);
    },

    insertRun(rec) {
      const prompt = rec.prompt ?? { version: 0, digest: defaultPromptDigest(), prompts: {} };
      const stmt = db.prepare(
        `INSERT INTO agent_run (
           run_id, graph_id, graph_version, graph_digest, thread_id, status,
           subject_key, subject_label, subject_kind, as_of, started_at,
           config_json, model, calls, prompt_chars, completion_chars, review_required,
           prompt_version, prompt_digest, prompt_json
         ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?)`
      );
      stmt.run([
        rec.runId,
        rec.graphId,
        rec.graphVersion,
        rec.graphDigest,
        rec.threadId,
        rec.subject.key,
        rec.subject.label,
        rec.subject.kind,
        rec.asOf,
        rec.startedAt,
        JSON.stringify(rec.config),
        rec.model,
        prompt.version,
        prompt.digest,
        JSON.stringify(prompt.prompts)
      ]);
      stmt.free();
      persist();
    },

    updateRunTerminal(rec) {
      const usage = rec.usage;
      const stmt = db.prepare(
        `UPDATE agent_run SET
           status = ?, ended_at = ?, state_json = ?, error_code = ?, error_message = ?,
           rating = ?, review_required = ?, calls = ?, prompt_chars = ?, completion_chars = ?,
           tokens_in = ?, tokens_out = ?, cost_usd = ?, suspend_json = NULL, recovery_json = NULL
         WHERE run_id = ?`
      );
      stmt.run([
        rec.status,
        rec.endedAt,
        rec.state === undefined ? null : JSON.stringify(rec.state),
        rec.errorCode ?? null,
        rec.errorMessage ?? null,
        rec.rating ?? null,
        rec.reviewRequired ? 1 : 0,
        usage?.calls ?? 0,
        usage?.promptChars ?? 0,
        usage?.completionChars ?? 0,
        usage?.tokensIn ?? null,
        usage?.tokensOut ?? null,
        usage?.costUsd ?? null,
        rec.runId
      ]);
      stmt.free();
      persist();
    },

    updateRunInterrupted(runId, state, usage) {
      const stmt = db.prepare(
        `UPDATE agent_run SET
           status = 'interrupted', ended_at = NULL, state_json = ?,
           calls = ?, prompt_chars = ?, completion_chars = ?, tokens_in = ?, tokens_out = ?, cost_usd = ?
         WHERE run_id = ?`
      );
      stmt.run([
        JSON.stringify(state),
        usage.calls,
        usage.promptChars,
        usage.completionChars,
        usage.tokensIn ?? null,
        usage.tokensOut ?? null,
        usage.costUsd ?? null,
        runId
      ]);
      stmt.free();
      persist();
    },

    updateRunUsage(runId, usage) {
      const stmt = db.prepare(
        `UPDATE agent_run SET
           calls = ?, prompt_chars = ?, completion_chars = ?, tokens_in = ?, tokens_out = ?, cost_usd = ?
         WHERE run_id = ?`
      );
      stmt.run([
        usage.calls,
        usage.promptChars,
        usage.completionChars,
        usage.tokensIn ?? null,
        usage.tokensOut ?? null,
        usage.costUsd ?? null,
        runId
      ]);
      stmt.free();
      persist();
    },

    getRunUsage(runId) {
      const row = one(
        db,
        `SELECT calls, prompt_chars, completion_chars, tokens_in, tokens_out, cost_usd
           FROM agent_run WHERE run_id = ?`,
        [runId]
      );
      return {
        calls: num(row?.calls),
        promptChars: num(row?.prompt_chars),
        completionChars: num(row?.completion_chars),
        tokensIn: typeof row?.tokens_in === 'number' ? row.tokens_in : undefined,
        tokensOut: typeof row?.tokens_out === 'number' ? row.tokens_out : undefined,
        costUsd: typeof row?.cost_usd === 'number' ? row.cost_usd : undefined
      };
    },

    getRunRecovery(runId) {
      const row = one(db, 'SELECT recovery_json FROM agent_run WHERE run_id = ?', [runId]);
      return parseRunRecovery(row?.recovery_json);
    },

    clearRunRecovery(runId) {
      const stmt = db.prepare('UPDATE agent_run SET recovery_json = NULL WHERE run_id = ?');
      stmt.run([runId]);
      stmt.free();
    },

    getRunPromptSnapshot(runId) {
      const row = one(
        db,
        'SELECT prompt_version, prompt_digest, prompt_json FROM agent_run WHERE run_id = ?',
        [runId]
      );
      if (!row) return null;
      const prompts = readJson<Partial<Record<AgentPromptRole, string>>>(row.prompt_json, {});
      return {
        version: num(row.prompt_version, 0),
        digest: str(row.prompt_digest) ?? defaultPromptDigest(),
        prompts
      };
    },

    getNodeAttemptBases(runId) {
      const out: Record<string, number> = {};
      for (const row of rows(
        db,
        'SELECT node_id, MAX(attempt) AS m FROM agent_node_result WHERE run_id = ? GROUP BY node_id',
        [runId]
      )) {
        out[row.node_id as string] = num(row.m);
      }
      return out;
    },

    deleteRunCheckpoints(runId) {
      db.run('DELETE FROM agent_run_checkpoint_write WHERE run_id = ?', [runId]);
      db.run('DELETE FROM agent_run_checkpoint WHERE run_id = ?', [runId]);
    },

    setRunSuspend(runId, snapshotJson) {
      const stmt = db.prepare('UPDATE agent_run SET suspend_json = ? WHERE run_id = ?');
      stmt.run([snapshotJson, runId]);
      stmt.free();
      persist();
    },

    getRunSuspend(runId) {
      const row = one(db, 'SELECT suspend_json FROM agent_run WHERE run_id = ?', [runId]);
      return typeof row?.suspend_json === 'string' && row.suspend_json.length > 0
        ? row.suspend_json
        : null;
    },

    clearRunSuspend(runId) {
      const stmt = db.prepare('UPDATE agent_run SET suspend_json = NULL WHERE run_id = ?');
      stmt.run([runId]);
      const n = db.getRowsModified();
      stmt.free();
      if (n > 0) persist();
    },

    updateRunResumed(runId) {
      const stmt = db.prepare(
        `UPDATE agent_run SET status = 'running', ended_at = NULL, error_code = NULL, error_message = NULL
         WHERE run_id = ?`
      );
      stmt.run([runId]);
      stmt.free();
      persist();
    },

    writeEvent(envelope) {
      const nodeId = 'nodeId' in envelope.event && typeof envelope.event.nodeId === 'string'
        ? envelope.event.nodeId
        : null;
      const stmt = db.prepare(
        'INSERT OR REPLACE INTO agent_run_event (run_id, seq, ts, type, node_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)'
      );
      stmt.run([envelope.runId, envelope.seq, envelope.ts, envelope.event.type, nodeId, JSON.stringify(envelope)]);
      stmt.free();
      persist();
    },

    listEvents(runId, afterSeq = 0) {
      const list = rows(
        db,
        'SELECT payload_json FROM agent_run_event WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT 1000',
        [runId, afterSeq]
      );
      return list
        .map((r) => readJson<RunEventEnvelope | null>(r.payload_json, null))
        .filter((e): e is RunEventEnvelope => e !== null);
    },

    startNode(rec) {
      const stmt = db.prepare(
        `INSERT INTO agent_node_result (run_id, node_id, attempt, node_type, status, started_at, input_summary)
         VALUES (?, ?, ?, ?, 'running', ?, ?)
         ON CONFLICT(run_id, node_id, attempt) DO UPDATE SET
           status = 'running', started_at = excluded.started_at, input_summary = excluded.input_summary`
      );
      stmt.run([rec.runId, rec.nodeId, rec.attempt, rec.nodeType, rec.startedAt, rec.inputSummary ?? null]);
      stmt.free();
      persist();
    },

    finishNode(rec) {
      const stmt = db.prepare(
        `UPDATE agent_node_result SET
           status = ?, ended_at = ?, elapsed_ms = ?, output_json = ?, error_code = ?, error_message = ?
         WHERE run_id = ? AND node_id = ? AND attempt = ?`
      );
      stmt.run([
        rec.status,
        rec.endedAt,
        rec.elapsedMs,
        rec.output === undefined ? null : JSON.stringify(rec.output),
        rec.errorCode ?? null,
        rec.errorMessage ?? null,
        rec.runId,
        rec.nodeId,
        rec.attempt
      ]);
      stmt.free();
      persist();
    },

    saveDecision(runId, subject, asOf, decision) {
      const status = decision.rating === 'review' ? 'review' : 'pending';
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO agent_decision (
           id, run_id, subject_key, subject_label, as_of, rating, confidence, horizon_days,
           thesis, key_risks_json, status, resolve_after, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      stmt.run([
        `dec_${runId}`,
        runId,
        subject.key,
        subject.label,
        asOf,
        decision.rating,
        decision.confidence,
        decision.horizonDays,
        decision.thesis,
        JSON.stringify(decision.keyRisks),
        status,
        decision.nextCheckAt,
        new Date().toISOString()
      ]);
      stmt.free();
      persist();
    },

    listRuns(limit = 50) {
      const n = Math.min(Math.max(limit, 1), 200);
      return rows(db, 'SELECT * FROM agent_run ORDER BY started_at DESC LIMIT ?', [n]).map(toSummary);
    },

    getRunDetail(runId) {
      const row = one(db, 'SELECT * FROM agent_run WHERE run_id = ?', [runId]);
      if (!row) return null;
      const summary = toSummary(row);
      const nodeRows = rows(
        db,
        'SELECT * FROM agent_node_result WHERE run_id = ? ORDER BY started_at ASC, node_id ASC, attempt ASC',
        [runId]
      );
      const nodes = nodeRows.map(toNodeView);

      const graph = readJson<GraphSpec | null>(
        one(db, 'SELECT spec_json FROM agent_graph WHERE graph_id = ? AND version = ?', [
          summary.graphId,
          summary.graphVersion
        ])?.spec_json,
        null
      );
      if (graph) {
        const seen = new Set(nodes.map((n) => n.nodeId));
        for (const specNode of graph.nodes as GraphNodeSpec[]) {
          if (seen.has(specNode.id)) continue;
          nodes.push({
            nodeId: specNode.id,
            nodeType: specNode.type,
            attempt: 0,
            status: 'pending'
          });
        }
      }

      const decisionRow = one(db, 'SELECT * FROM agent_decision WHERE run_id = ? ORDER BY created_at DESC LIMIT 1', [
        runId
      ]);
      const state = readJson<Record<string, unknown> | undefined>(row.state_json, undefined);
      // state_json 里的 decision 保留完整字段（含 reviewReason）；agent_decision 用于结算与查询，
      // 缺少 state 时再从该表还原。
      const stateDecision = state?.decision as FinalDecision | undefined;
      const decision: FinalDecision | undefined = stateDecision
        ? stateDecision
        : decisionRow
          ? {
              rating: decisionRow.rating as TrendRating,
              confidence: num(decisionRow.confidence),
              horizonDays: num(decisionRow.horizon_days, 7),
              thesis: (decisionRow.thesis as string) ?? '',
              keyRisks: readJson<string[]>(decisionRow.key_risks_json, []),
              nextCheckAt: (decisionRow.resolve_after as string) ?? summary.startedAt,
              reviewRequired: summary.reviewRequired
            }
          : undefined;

      // P7：只有真的存在审批挂起快照时才展示审批；checkpoint 恢复的 interrupted
      // 不应被 UI 误判为等待审批。
      const suspend = parseSuspendSnapshot(row.suspend_json);
      const approval: ApprovalContext | undefined =
        summary.status === 'interrupted' && suspend
          ? {
              nodeId: 'final',
              stage: 'final_approval',
              decision: state?.decision as FinalDecision | undefined,
              proposal: state?.proposal as ObservationPlan | undefined
            }
          : undefined;
      const recovery = parseRunRecovery(row.recovery_json) ?? undefined;

      const memory =
        typeof state?.memoryContext === 'string'
          ? {
              context: state.memoryContext,
              lessons: (state.memoryUsed as MemoryInjection[] | undefined) ?? []
            }
          : undefined;

      return {
        ...summary,
        config: readJson<RunOptions | undefined>(row.config_json, undefined),
        state,
        nodes,
        decision,
        approval,
        recovery,
        memory,
        graphName: graph?.name,
        prompt: {
          version: num(row.prompt_version, 0),
          digest: str(row.prompt_digest) ?? defaultPromptDigest(),
          prompts: readJson<Partial<Record<AgentPromptRole, string>>>(row.prompt_json, {})
        }
      };
    },

    recoverPreviousProcessRuns(at) {
      let failed = 0;
      let recoverable = 0;
      let changed = false;
      // 第一轮把 running/queued 标记为 interrupted 后，第二轮会再次读到它们；
      // 用集合去重，保证每个 run 只计一次（否则启动恢复计数翻倍）。
      const handled = new Set<string>();
      const fail = db.prepare(
        `UPDATE agent_run SET status = 'failed', ended_at = ?, error_code = 'E_PROCESS_RESTART',
         error_message = '进程重启，无可恢复的 checkpoint，残留运行已标记失败',
         suspend_json = NULL, recovery_json = NULL
         WHERE run_id = ?`
      );
      const failRun = (runId: string): void => {
        fail.run([at, runId]);
        failed += db.getRowsModified();
        changed = true;
      };
      const markRecoverable = (
        runId: string,
        graphId: string,
        graphVersion: number,
        graphDigest: string,
        promptVersion: number,
        promptDigest: string,
        checkpointId: string,
        checkpointStep: number,
        isMock: boolean,
        usage: RunUsage
      ): void => {
        const recovery: AgentRunRecovery = {
          v: 1,
          kind: 'checkpoint',
          checkpointId,
          checkpointStep,
          graphId,
          graphVersion,
          graphDigest,
          promptVersion,
          promptDigest,
          threadId: runId,
          isMock,
          usage,
          recoveredAt: at
        };
        db.run(
          `UPDATE agent_run SET status = 'interrupted', ended_at = NULL, error_code = NULL,
             error_message = NULL, suspend_json = NULL, recovery_json = ?
           WHERE run_id = ?`,
          [JSON.stringify(recovery), runId]
        );
        recoverable += 1;
        handled.add(runId);
        changed = true;
      };

      // running/queued：有完整 checkpoint + run 绑定信息才标为可恢复，否则安全降级为 failed。
      for (const row of rows(
        db,
        `SELECT run_id, graph_id, graph_version, graph_digest, model, prompt_version, prompt_digest,
                prompt_json, calls, prompt_chars, completion_chars, tokens_in, tokens_out, cost_usd
           FROM agent_run WHERE status IN ('queued','running')`
      )) {
        const runId = row.run_id as string;
        const inspected = inspectLatestCheckpoint(db, runId);
        const promptJson = typeof row.prompt_json === 'string' && row.prompt_json.length > 0;
        const graphDigest = str(row.graph_digest);
        const promptDigest = str(row.prompt_digest);
        if (
          !inspected.ok ||
          !graphDigest ||
          !promptDigest ||
          !promptJson ||
          !Number.isInteger(row.graph_version) ||
          (row.graph_version as number) < 1
        ) {
          failRun(runId);
          continue;
        }
        markRecoverable(
          runId,
          row.graph_id as string,
          row.graph_version as number,
          graphDigest,
          num(row.prompt_version, 0),
          promptDigest,
          inspected.checkpointId as string,
          inspected.step ?? 0,
          str(row.model) === 'mock',
          {
            calls: num(row.calls),
            promptChars: num(row.prompt_chars),
            completionChars: num(row.completion_chars),
            tokensIn: typeof row.tokens_in === 'number' ? row.tokens_in : undefined,
            tokensOut: typeof row.tokens_out === 'number' ? row.tokens_out : undefined,
            costUsd: typeof row.cost_usd === 'number' ? row.cost_usd : undefined
          }
        );
      }

      // interrupted：审批快照优先；否则必须是完整的 checkpoint 恢复元数据且 checkpoint 仍可用。
      for (const row of rows(
        db,
        `SELECT run_id, suspend_json, recovery_json FROM agent_run WHERE status = 'interrupted'`
      )) {
        const interruptedRunId = row.run_id as string;
        if (handled.has(interruptedRunId)) continue;
        if (parseSuspendSnapshot(row.suspend_json)) {
          recoverable += 1;
          handled.add(interruptedRunId);
          continue;
        }
        const recovery = parseRunRecovery(row.recovery_json);
        if (recovery && inspectLatestCheckpoint(db, recovery.threadId).ok) {
          recoverable += 1;
          handled.add(interruptedRunId);
          continue;
        }
        failRun(interruptedRunId);
      }
      fail.free();
      if (changed) persist();
      return { recoverable, failed };
    },

    getMaxSeq(runId) {
      const row = one(db, 'SELECT MAX(seq) AS s FROM agent_run_event WHERE run_id = ?', [runId]);
      return num(row?.s, 0);
    }
  };
  return repo;
}
