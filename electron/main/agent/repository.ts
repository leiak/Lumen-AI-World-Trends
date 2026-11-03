import type { Database } from 'sql.js';
import type {
  AgentErrorCode,
  AgentGraphStatus,
  AgentGraphSummary,
  AgentGraphVersionSummary,
  AgentNodeResultView,
  AgentRunDetail,
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
import { digestGraphSpec } from './spec.js';

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
  return value as unknown as RunSuspendSnapshot;
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
  insertRun(rec: RunInsert): void;
  updateRunTerminal(rec: RunTerminal): void;
  /** 非终态迁移（interrupted）：保留 ended_at 为空，写入状态快照与已消耗用量。 */
  updateRunInterrupted(runId: string, state: unknown, usage: RunUsage): void;
  /** P5：写入/读取/清理审批挂起快照。 */
  setRunSuspend(runId: string, snapshotJson: string): void;
  getRunSuspend(runId: string): string | null;
  clearRunSuspend(runId: string): void;
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

    insertRun(rec) {
      const stmt = db.prepare(
        `INSERT INTO agent_run (
           run_id, graph_id, graph_version, graph_digest, thread_id, status,
           subject_key, subject_label, subject_kind, as_of, started_at,
           config_json, model, calls, prompt_chars, completion_chars, review_required
         ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`
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
        rec.model
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
           tokens_in = ?, tokens_out = ?, cost_usd = ?, suspend_json = NULL
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

      const approval: ApprovalContext | undefined =
        summary.status === 'interrupted'
          ? {
              nodeId: 'final',
              stage: 'final_approval',
              decision: state?.decision as FinalDecision | undefined,
              proposal: state?.proposal as ObservationPlan | undefined
            }
          : undefined;

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
        memory,
        graphName: graph?.name
      };
    },

    recoverPreviousProcessRuns(at) {
      let failed = 0;
      let recoverable = 0;
      const fail = db.prepare(
        `UPDATE agent_run SET status = 'failed', ended_at = ?, error_code = 'E_PROCESS_RESTART',
         error_message = '进程重启，残留运行已标记失败', suspend_json = NULL
         WHERE run_id = ?`
      );
      const failRun = (runId: string): void => {
        fail.run([at, runId]);
        failed += db.getRowsModified();
      };
      // queued/running：进程内执行已丢失，无法安全续跑。
      for (const row of rows(db, "SELECT run_id FROM agent_run WHERE status IN ('queued','running')")) {
        failRun(row.run_id as string);
      }
      // interrupted：只有快照完整且可解析时才保留为可恢复。
      for (const row of rows(db, "SELECT run_id, suspend_json FROM agent_run WHERE status = 'interrupted'")) {
        if (parseSuspendSnapshot(row.suspend_json)) {
          recoverable += 1;
        } else {
          failRun(row.run_id as string);
        }
      }
      fail.free();
      if (failed > 0) persist();
      return { recoverable, failed };
    },

    getMaxSeq(runId) {
      const row = one(db, 'SELECT MAX(seq) AS s FROM agent_run_event WHERE run_id = ?', [runId]);
      return num(row?.s, 0);
    }
  };
  return repo;
}
