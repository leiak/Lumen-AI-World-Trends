import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Command, isGraphInterrupt, isInterrupted } from '@langchain/langgraph';
import type { Database } from 'sql.js';
import type {
  AgentGraphDeleteRequest,
  AgentGraphDeleteResponse,
  AgentGraphGetRequest,
  AgentGraphGetResponse,
  AgentGraphSaveRequest,
  AgentGraphSaveResponse,
  AgentGraphVersionSummary,
  AgentIpcResponse,
  AgentRunDetail,
  AgentRunsListRequest,
  AgentPromptIssue,
  AgentPromptPackSnapshot,
  AgentPromptRole,
  AgentPromptsGetRequest,
  AgentPromptsGetResponse,
  AgentPromptsSaveRequest,
  AgentPromptsSaveResponse,
  AgentRunSummary,
  ApprovalContext,
  ApprovalResolution,
  CancelRunResponse,
  EventsPage,
  EventsPageRequest,
  FinalDecision,
  GraphNodeSpec,
  GraphSpec,
  GraphSpecIssue,
  JsonObject,
  ResumeCheckpointRequest,
  ResumeCheckpointResponse,
  ResumeRunRequest,
  ResumeRunResponse,
  RunEventEnvelope,
  RunOptions,
  RunUsage,
  StartRunRequest,
  StartRunResponse
} from '../../../shared/agent.js';
import { AGENT_PROMPT_ROLES } from '../../../shared/agent.js';
import { STOCK_GRAPH_ID } from '../../../shared/stock-agent.js';
import type { AiProvider, ChatMessage } from '../ai/provider.js';
import { DEFAULT_PROMPT_PACK, validatePromptText } from './prompt-policy.js';
import { RunEventBus } from './events.js';
import { compileAgentGraph, type CompiledAgentGraph, type GraphRunHooks } from './graph.js';
import {
  CheckpointCorruptError,
  SqlJsCheckpointSaver,
  inspectLatestCheckpoint,
  type CheckpointStats
} from './checkpoint.js';
import { createPersistScheduler, type PersistScheduler, type PersistSchedulerStats } from './persist.js';
import {
  AgentCanceledError,
  AgentRuntimeError,
  AgentTimeoutError,
  extractAgentError,
  isCanceled
} from './errors.js';
import {
  createAgentRepository,
  parseSuspendSnapshot,
  type AgentRepository,
  type RunSuspendSnapshot
} from './repository.js';
import type { AgentNodeDeps } from './nodes.js';
import { archiveDecisionBaseline } from './memory.js';
import { mergeDecisionPatch, reviewDecision } from './structured.js';
import { computeRecursionLimit, defaultGraphSpec, stockGraphSpec, validateGraphSpec } from './spec.js';

/** 默认整轮 20-30 次模型调用的上限；P0 四节点实际 4 次。 */
const MAX_MODEL_CALLS = 30;
/** 保守成本估算（USD/token），仅用于本地预算护栏，真实账单以平台为准。 */
const USD_PER_TOKEN = 0.000003;
const DEFAULT_GRAPH_ID = 'trend-analysis';
/** P5 token 事件聚合：攒够 ~80 字符落库一次，避免每 token 一行导致 DB 膨胀。 */
const TOKEN_FLUSH_CHARS = 80;
/** P5 单节点单次模型调用的 token 事件总字符上限；完整文本仍由 node.completed 的 output 保存。 */
const TOKEN_MAX_CHARS_PER_CALL = 8000;

interface NodeTokenContext {
  nodeId: string;
  attempt: number;
}

interface ActiveRun {
  canceled: boolean;
  cancelReason: 'user' | 'timeout' | 'replaced';
  finished: boolean;
  execution: Promise<void>;
}

/** 一次运行的执行上下文：interrupt 后保留它，resume 时复用同一个图与 checkpointer。 */
interface Execution {
  runId: string;
  spec: GraphSpec;
  graphDigest: string;
  subject: StartRunRequest['subject'];
  asOf: string;
  options: RunOptions;
  provider: AiProvider;
  isMock: boolean;
  /** P6：本 run 绑定到启动瞬间的 prompt 版本，后续编辑不影响本次执行。 */
  prompt: AgentPromptPackSnapshot;
  usage: RunUsage;
  startedAtMs: number;
  deadline: number;
  /** 当前活跃执行（resume 时会替换）。节点与模型调用都通过它感知取消。 */
  ctx: ActiveRun;
  bus: RunEventBus;
  graph: CompiledAgentGraph['graph'];
  nodeDeps: AgentNodeDeps;
  /** P7：本 run 的 checkpoint saver；P5 的 restart_resume 小图不落 checkpoint。 */
  checkpointSaver?: SqlJsCheckpointSaver;
  /** 最近一次 node.started，用于 interrupt 时把挂起节点标为 skipped。 */
  lastStarted: { nodeId: string; attempt: number; startedMs: number } | null;
  /** 按 `${nodeId}:${attempt}` 缓存本次尝试的真实 startedAt / endedAt，
   *  供 debate.turn / risk.turn 事件复用，避免与落库时间不一致。 */
  nodeTimes: Map<string, { startedAt: string; endedAt?: string }>;
}

export interface AgentRuntimeDeps {
  db: Database;
  provider: AiProvider;
  mockProvider: AiProvider;
  persist: () => void;
  send?: (envelope: RunEventEnvelope) => void;
  now?: () => string;
  newRunId?: () => string;
}

function ok<T>(data: T): AgentIpcResponse<T> {
  return { ok: true, data };
}

function error<T = never>(
  code: import('../../../shared/agent.js').AgentErrorCode,
  message: string,
  details?: unknown
): AgentIpcResponse<T> {
  return { ok: false, code, message, details };
}

function previewOf(output: JsonObject): string {
  const text = JSON.stringify(output, null, 2);
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

function estimateCostUsd(usage: RunUsage): number {
  return Number((((usage.promptChars + usage.completionChars) / 3) * USD_PER_TOKEN).toFixed(6));
}

function isIso(v: unknown): v is string {
  return typeof v === 'string' && Number.isFinite(Date.parse(v));
}

export class AgentRuntime {
  private readonly repo: AgentRepository;
  private readonly active = new Map<string, ActiveRun>();
  /** 已 interrupt、等待审批的运行；仅进程内有效。重启后由 suspend_json 快照恢复。 */
  private readonly suspended = new Map<string, Execution>();
  private readonly now: () => string;
  private readonly newRunId: () => string;
  /** P7：合并落盘调度器；所有 repo/checkpoint 写入都走它，终态再强制 flush。 */
  private readonly persistScheduler: PersistScheduler;
  /** P7：每个 run 的 checkpoint saver 保留统计数据，供验收报告读取。 */
  private readonly checkpointSavers = new Map<string, SqlJsCheckpointSaver>();
  private readonly immediateCheckpointFlush: boolean;
  /** 节点执行上下文：并发节点各自持有，token 事件因此不会串台。 */
  private readonly nodeContext = new AsyncLocalStorage<NodeTokenContext>();

  constructor(private readonly deps: AgentRuntimeDeps) {
    const interval = Number(process.env.LUMEN_PERSIST_INTERVAL_MS);
    this.persistScheduler = createPersistScheduler(deps.persist, {
      minIntervalMs: Number.isFinite(interval) && interval > 0 ? interval : 1000
    });
    this.immediateCheckpointFlush = process.env.LUMEN_CHECKPOINT_FLUSH === 'immediate';
    this.repo = createAgentRepository(deps.db, () => this.persistScheduler.request());
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newRunId =
      deps.newRunId ??
      (() => `run_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${randomUUID().slice(0, 8)}`);
  }

  /** P7：真实验收用，报告一次 run 的 checkpoint 写入 / export 次数。 */
  checkpointStats(runId: string): {
    checkpoints: CheckpointStats;
    persist: PersistSchedulerStats;
  } | null {
    const saver = this.checkpointSavers.get(runId);
    if (!saver) return null;
    return { checkpoints: saver.stats(), persist: this.persistScheduler.stats() };
  }

  ensureDefaultGraph(spec: GraphSpec): boolean {
    return this.repo.ensureDefaultGraph(spec);
  }

  getGraph(graphId = DEFAULT_GRAPH_ID): AgentIpcResponse<GraphSpec> {
    const spec = this.repo.getGraph(graphId);
    if (!spec) return error('E_GRAPH_NOT_FOUND', `未找到图: ${graphId}`);
    return ok(spec);
  }

  listGraphs(): AgentIpcResponse<AgentGraphVersionSummary[]> {
    return ok(this.repo.listGraphs());
  }

  getGraphView(req: AgentGraphGetRequest): AgentIpcResponse<AgentGraphGetResponse> {
    if (!req || typeof req.graphId !== 'string' || req.graphId.trim().length === 0) {
      return error('E_VALIDATION', 'graphId 不能为空');
    }
    const rec = this.repo.getGraphRecord(req.graphId, req.version);
    if (!rec) {
      return error('E_GRAPH_NOT_FOUND', `未找到图: ${req.graphId}${req.version ? ` v${req.version}` : ''}`);
    }
    return ok({ spec: rec.spec, status: rec.status, isActive: rec.isActive, digest: rec.digest });
  }

  /** P4：保存前跑完整 spec 校验 + 编译 dry-run；失败回显可定位 issue。 */
  saveGraph(req: AgentGraphSaveRequest): AgentIpcResponse<AgentGraphSaveResponse> {
    if (!req || typeof req !== 'object' || !req.spec) {
      return error('E_VALIDATION', '缺少 spec');
    }
    const validated = validateGraphSpec(req.spec);
    if (!validated.ok) {
      return error(validated.code, validated.message, { issues: validated.issues });
    }
    const versions = this.repo.listGraphs().filter((g) => g.id === validated.spec.id);
    const nextVersion = versions.reduce((max, g) => Math.max(max, g.version), 0) + 1;
    const at = this.now();
    const spec: GraphSpec = {
      ...validated.spec,
      version: nextVersion,
      createdAt: at,
      updatedAt: at
    };
    const compileError = this.checkCompilable(spec);
    if (compileError) {
      const issue: GraphSpecIssue = {
        code: 'E_GRAPH_INVALID',
        message: `图编译失败: ${compileError}`
      };
      return error(issue.code, issue.message, { issues: [issue] });
    }
    const publish = req.publish !== false;
    const saved = this.repo.saveGraph(spec, publish);
    return ok({
      graphId: spec.id,
      version: spec.version,
      digest: saved.digest,
      status: saved.status,
      isActive: saved.isActive,
      spec
    });
  }

  deleteGraph(req: AgentGraphDeleteRequest): AgentIpcResponse<AgentGraphDeleteResponse> {
    if (!req || typeof req.graphId !== 'string' || !Number.isInteger(req.version) || req.version < 1) {
      return error('E_VALIDATION', 'graphId/version 非法');
    }
    const rec = this.repo.getGraphRecord(req.graphId, req.version);
    if (!rec) return error('E_GRAPH_NOT_FOUND', `未找到图: ${req.graphId} v${req.version}`);
    const used = this.repo.countRunsForGraphVersion(req.graphId, req.version);
    if (used > 0) {
      return error(
        'E_GRAPH_INVALID',
        `图版本 v${req.version} 已被 ${used} 次运行使用，不能删除（历史回放需要原图）`
      );
    }
    const total = this.repo.listGraphs().filter((g) => g.id === req.graphId).length;
    if (total <= 1) {
      return error('E_GRAPH_INVALID', '至少保留一个图版本；如需重置请使用“恢复默认图”');
    }
    if (rec.isActive) {
      const fallback = this.repo
        .listGraphs()
        .filter((g) => g.id === req.graphId && g.version !== req.version && g.status === 'published');
      if (fallback.length === 0) {
        return error('E_GRAPH_INVALID', '删除 active 版本后没有可用 published 版本');
      }
    }
    const { promotedVersion } = this.repo.deleteGraph(req.graphId, req.version);
    return ok({ graphId: req.graphId, version: req.version, deleted: true, promotedVersion });
  }

  restoreDefaultGraph(graphId: string = DEFAULT_GRAPH_ID): AgentIpcResponse<AgentGraphSaveResponse> {
    const scope = this.resolveGraphScope(graphId);
    if (!scope) {
      return error('E_VALIDATION', `未知图命名空间: ${String(graphId)}`);
    }
    const spec = scope === STOCK_GRAPH_ID ? stockGraphSpec(this.now()) : defaultGraphSpec(this.now());
    const validated = validateGraphSpec(spec);
    if (!validated.ok) {
      return error(validated.code, validated.message, { issues: validated.issues });
    }
    const saved = this.repo.restoreDefaultGraph(validated.spec);
    return ok({
      graphId: validated.spec.id,
      version: validated.spec.version,
      digest: saved.digest,
      status: saved.status,
      isActive: saved.isActive,
      spec: validated.spec
    });
  }

  /** 只做结构编译，不执行节点；图内字符串永远不会被 eval。 */
  private checkCompilable(spec: GraphSpec): string | null {
    const noop = (): void => undefined;
    const hooks: GraphRunHooks = {
      onNodeStarted: noop,
      onNodeCompleted: noop,
      onNodeFailed: noop,
      onDebateTurn: noop,
      onRiskTurn: noop,
      onRouteTaken: noop,
      checkCanceled: noop
    };
    try {
      compileAgentGraph(spec, {} as AgentNodeDeps, hooks, {
        nodeTimeoutMs: spec.settings.nodeTimeoutMs,
        skipTimeout: true
      });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  listRuns(req?: AgentRunsListRequest): AgentIpcResponse<AgentRunSummary[]> {
    return ok(this.repo.listRuns(req?.limit, req?.graphId));
  }

  getRun(runId: string): AgentIpcResponse<AgentRunDetail> {
    if (typeof runId !== 'string' || runId.length === 0) {
      return error('E_VALIDATION', 'runId 不能为空');
    }
    const detail = this.repo.getRunDetail(runId);
    if (!detail) return error('E_RUN_NOT_FOUND', `未找到运行: ${runId}`);
    return ok(detail);
  }

  getEvents(req: EventsPageRequest): AgentIpcResponse<EventsPage> {
    if (!req || typeof req.runId !== 'string' || req.runId.length === 0) {
      return error('E_VALIDATION', 'runId 不能为空');
    }
    const afterSeq = Number.isFinite(req.afterSeq) ? Math.max(0, Math.floor(req.afterSeq as number)) : 0;
    const detail = this.repo.getRunDetail(req.runId);
    if (!detail) return error('E_RUN_NOT_FOUND', `未找到运行: ${req.runId}`);
    const events = this.repo.listEvents(req.runId, afterSeq);
    const nextSeq = events.length > 0 ? events[events.length - 1].seq : afterSeq;
    return ok({ runId: req.runId, events, nextSeq });
  }

  /** 图/prompt 编辑器只允许在这两个独立命名空间内操作，避免跨页签串味。 */
  private resolveGraphScope(graphId: unknown): string | null {
    const id = graphId === undefined ? DEFAULT_GRAPH_ID : graphId;
    if (typeof id !== 'string' || id.trim().length === 0) return null;
    const normalized = id.trim();
    if (normalized !== DEFAULT_GRAPH_ID && normalized !== STOCK_GRAPH_ID) return null;
    return normalized;
  }

  /** P6：指定图命名空间当前生效的角色 prompt 包；缺省 trend-analysis（兼容旧调用）。 */
  getPrompts(req?: AgentPromptsGetRequest): AgentIpcResponse<AgentPromptsGetResponse> {
    const requested = (req as { graphId?: unknown } | undefined)?.graphId;
    const scope = this.resolveGraphScope(requested);
    if (!scope) return error('E_VALIDATION', `未知 prompt 命名空间: ${String(requested)}`);
    return ok({ pack: this.repo.getActivePromptPack(scope) });
  }

  /** P6：保存 prompt 编辑；所有角色错误一次收集，失败即不产生新版本。 */
  savePrompts(req: AgentPromptsSaveRequest): AgentIpcResponse<AgentPromptsSaveResponse> {
    const requested = (req as { graphId?: unknown } | undefined)?.graphId;
    const scope = this.resolveGraphScope(requested);
    if (!scope) return error('E_VALIDATION', `未知 prompt 命名空间: ${String(requested)}`);
    const raw = (req as { prompts?: unknown } | undefined)?.prompts;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return error('E_VALIDATION', 'prompts 必须是角色到文本的对象');
    }
    const allowed = new Set<string>(AGENT_PROMPT_ROLES);
    const issues: AgentPromptIssue[] = [];
    const incoming: Partial<Record<AgentPromptRole, string>> = {};
    for (const [role, value] of Object.entries(raw)) {
      if (!allowed.has(role)) {
        return error('E_VALIDATION', `未知 prompt 角色: ${role}`);
      }
      if (typeof value !== 'string') {
        return error('E_VALIDATION', `角色 ${role} 的 prompt 必须是字符串`);
      }
      issues.push(...validatePromptText(role as AgentPromptRole, value));
      incoming[role as AgentPromptRole] = value;
    }
    if (issues.length > 0) {
      return error('E_VALIDATION', 'prompt 校验失败', { issues });
    }
    const current = this.repo.getActivePromptPack(scope);
    const pack = this.repo.savePromptPack({ ...current.prompts, ...incoming }, scope);
    return ok({ pack });
  }

  /** P5：启动清理。带合法挂起快照的 interrupted 保留为可恢复；
   *  其余残留 run（queued/running/损坏快照）降级为 failed + E_PROCESS_RESTART。 */
  markInterruptedFromPreviousProcess(): { recoverable: number; failed: number } {
    const result = this.repo.recoverPreviousProcessRuns(this.now());
    // 启动恢复结论（interrupted/failed）必须立刻落盘，避免再次重启时状态回到 running。
    this.persistScheduler.flushNow();
    return result;
  }

  async startRun(req: StartRunRequest): Promise<AgentIpcResponse<StartRunResponse>> {
    const checked = this.validateStart(req);
    if ('error' in checked) return checked.error;
    const { subject, asOf, options } = checked;

    if (this.active.size > 0) {
      return error('E_RUN_ACTIVE', '已有运行进行中，请先取消或等待完成');
    }
    const record = this.repo.getGraphRecord(req.graphId, req.graphVersion);
    if (!record) {
      return error('E_GRAPH_NOT_FOUND', `未找到图: ${req.graphId}${req.graphVersion ? ` v${req.graphVersion}` : ''}`);
    }
    // P4：编辑器加载时的摘要必须与本次实际绑定的版本一致，避免“未保存改动 / 旧图”悄悄跑。
    if (req.expectedDigest && req.expectedDigest !== record.digest) {
      return error('E_VALIDATION', `图已变化（当前 v${record.spec.version}），请刷新后再运行`, {
        expectedDigest: req.expectedDigest,
        actualDigest: record.digest,
        graphVersion: record.spec.version
      });
    }
    const validated = validateGraphSpec(record.spec);
    if (!validated.ok) {
      return error(validated.code, validated.message, { issues: validated.issues });
    }
    const spec = validated.spec;
    const graphDigest = record.digest;
    // prompt 包严格按本次运行的图命名空间取 active，stock 与 trend 互不影响。
    const activePrompt = this.repo.getActivePromptPack(spec.id);
    const promptSnapshot: AgentPromptPackSnapshot = {
      version: activePrompt.version,
      digest: activePrompt.digest,
      prompts: activePrompt.prompts
    };

    const isMock = options.forceMock === true || this.deps.provider.name === 'mock';
    const provider = options.forceMock ? this.deps.mockProvider : this.deps.provider;
    const runId = this.newRunId();
    const startedAt = this.now();
    this.repo.insertRun({
      runId,
      graphId: spec.id,
      graphVersion: spec.version,
      graphDigest,
      threadId: runId,
      subject,
      asOf,
      startedAt,
      config: options,
      model: provider.name,
      prompt: promptSnapshot
    });

    const ctx: ActiveRun = {
      canceled: false,
      cancelReason: 'user',
      finished: false,
      execution: Promise.resolve()
    };
    const execution = this.buildExecution(
      ctx,
      runId,
      spec,
      graphDigest,
      subject,
      asOf,
      options,
      provider,
      isMock,
      promptSnapshot
    );
    this.active.set(runId, ctx);
    ctx.execution = this.drive(execution, { kind: 'start' }).finally(() => {
      ctx.finished = true;
      if (this.active.get(runId) === ctx) this.active.delete(runId);
    });

    return ok({
      runId,
      threadId: runId,
      status: 'running',
      startedAt,
      graphId: spec.id,
      graphVersion: spec.version,
      graphDigest
    });
  }

  /** 取消幂等：已终态直接返回；运行中置标记并等待执行器收敛。 */
  async cancelRun(runId: string, reason: 'user' | 'timeout' | 'replaced' = 'user'): Promise<AgentIpcResponse<CancelRunResponse>> {
    if (typeof runId !== 'string' || runId.length === 0) {
      return error('E_VALIDATION', 'runId 不能为空');
    }
    const detail = this.repo.getRunDetail(runId);
    if (!detail) return error('E_RUN_NOT_FOUND', `未找到运行: ${runId}`);
    if (detail.status === 'completed' || detail.status === 'failed' || detail.status === 'canceled') {
      return ok({ runId, status: detail.status, alreadyTerminal: true });
    }
    // 审批挂起中取消：直接终止，丢弃挂起快照与暂停的 checkpoint。
    if (detail.status === 'interrupted') {
      const suspended = this.suspended.get(runId);
      this.suspended.delete(runId);
      if (suspended) {
        this.terminateInterrupted(suspended, 'canceled', reason);
      } else {
        this.repo.updateRunTerminal({
          runId,
          status: 'canceled',
          endedAt: this.now(),
          state: detail.state
        });
        this.repo.deleteRunCheckpoints(runId);
        this.persistScheduler.flushNow();
      }
      return ok({ runId, status: 'canceled', alreadyTerminal: false });
    }
    const ctx = this.active.get(runId);
    if (ctx) {
      ctx.canceled = true;
      ctx.cancelReason = reason;
      await ctx.execution;
    }
    const after = this.repo.getRunDetail(runId);
    if (!after) return error('E_RUN_NOT_FOUND', `未找到运行: ${runId}`);
    return ok({
      runId,
      status: after.status as CancelRunResponse['status'],
      alreadyTerminal: false
    });
  }

  /** 审批中直接终止：落库为 canceled，并沿用同一 run 的事件序列。 */
  private terminateInterrupted(
    execution: Execution,
    status: 'canceled',
    reason: 'user' | 'timeout' | 'replaced' | 'rejected'
  ): void {
    this.finalizeUsage(execution.usage, execution.isMock);
    const detail = this.repo.getRunDetail(execution.runId);
    const bus = new RunEventBus({
      runId: execution.runId,
      startSeq: this.repo.getMaxSeq(execution.runId),
      write: (envelope) => this.repo.writeEvent(envelope),
      send: this.deps.send,
      now: this.now
    });
    const state = detail?.state
      ? { ...detail.state, usage: execution.usage }
      : { usage: execution.usage };
    this.repo.updateRunTerminal({
      runId: execution.runId,
      status,
      endedAt: this.now(),
      state,
      usage: execution.usage
    });
    bus.emit({ type: 'run.canceled', reason });
    this.repo.deleteRunCheckpoints(execution.runId);
    this.persistScheduler.flushNow();
  }

  /** 人工审批恢复：只在 interrupted 且进程内仍保留挂起图时可用。
   *  - approve/edit：真正续跑同一个 checkpointer，未完成节点不会重跑；
   *  - reject：直接进入 canceled，并落库 review 结论；
   *  - 重复 resume / 非 interrupted：E_RUN_TERMINAL；
   *  - 进程重启后挂起快照丢失：E_RUN_TERMINAL。 */
  async resumeRun(req: ResumeRunRequest): Promise<AgentIpcResponse<ResumeRunResponse>> {
    if (!req || typeof req.runId !== 'string' || req.runId.length === 0) {
      return error('E_VALIDATION', 'runId 不能为空');
    }
    const resolution = req.resolution;
    if (
      !resolution ||
      (resolution.type !== 'approve' && resolution.type !== 'edit' && resolution.type !== 'reject')
    ) {
      return error('E_VALIDATION', 'resolution.type 必须是 approve/edit/reject');
    }
    const runId = req.runId;
    const detail = this.repo.getRunDetail(runId);
    if (!detail) return error('E_RUN_NOT_FOUND', `未找到运行: ${runId}`);
    if (detail.status !== 'interrupted') {
      return error('E_RUN_TERMINAL', `运行状态为 ${detail.status}，不可恢复`);
    }
    // P7：等待人工审批的 interrupted 与等待断点续跑的 interrupted 必须走不同路径。
    if (!this.suspended.has(runId) && this.repo.getRunRecovery(runId)) {
      return error(
        'E_RESUME_NO_CHECKPOINT',
        '该运行没有待审批事项，应从 checkpoint 断点续跑（继续运行）'
      );
    }
    let execution = this.suspended.get(runId);
    /** 进程重启路径：没有内存中的执行器，用持久化快照重建 final-only 图。 */
    let restartInput:
      | {
          kind: 'restart_resume';
          resolution: ApprovalResolution;
          state: Record<string, unknown>;
        }
      | undefined;
    if (!execution) {
      const snap = parseSuspendSnapshot(this.repo.getRunSuspend(runId));
      if (!snap) {
        return error('E_RUN_TERMINAL', '挂起快照不存在或已损坏，请重新发起运行');
      }
      const graphRec = this.repo.getGraphRecord(snap.graphId, snap.graphVersion);
      if (!graphRec) {
        return error(
          'E_RESUME_STALE_GRAPH',
          `图版本不存在（${snap.graphId} v${snap.graphVersion}），无法恢复审批`
        );
      }
      if (graphRec.digest !== snap.graphDigest) {
        return error('E_RESUME_STALE_GRAPH', '图内容已变化，拒绝恢复旧的审批挂起；请重新发起运行', {
          expectedDigest: snap.graphDigest,
          actualDigest: graphRec.digest
        });
      }
      if (detail.graphDigest && detail.graphDigest !== snap.graphDigest) {
        return error('E_RESUME_STALE_GRAPH', '运行绑定的图摘要与挂起快照不一致，拒绝恢复');
      }
      execution = this.buildRestartExecution(runId, snap, graphRec.spec);
      restartInput = { kind: 'restart_resume', resolution, state: snap.state };
    }
    if (this.active.size > 0) {
      return error('E_RUN_ACTIVE', '已有运行进行中，请先等待完成');
    }

    const baseDecision: FinalDecision =
      detail.approval?.decision ??
      detail.decision ??
      reviewDecision(7, new Date(), 'approval_without_decision');

    if (resolution.type === 'edit') {
      if (!resolution.patch || typeof resolution.patch !== 'object' || Array.isArray(resolution.patch)) {
        return error('E_VALIDATION', 'edit.patch 必须是对象');
      }
      const merged = mergeDecisionPatch(baseDecision, resolution.patch);
      if (!merged) {
        return error(
          'E_VALIDATION',
          'edit.patch 含非法字段或取值（rating/confidence/horizonDays/thesis/keyRisks/nextCheckAt）'
        );
      }
    }

    if (resolution.type === 'reject') {
      this.suspended.delete(runId);
      const rejected = reviewDecision(
        baseDecision.horizonDays,
        new Date(),
        resolution.reason?.slice(0, 200) || 'approval_rejected'
      );
      this.finalizeUsage(execution.usage, execution.isMock);
      const bus = new RunEventBus({
        runId,
        startSeq: this.repo.getMaxSeq(runId),
        write: (envelope) => this.repo.writeEvent(envelope),
        send: this.deps.send,
        now: this.now
      });
      const state = {
        ...(detail.state ?? {}),
        decision: rejected,
        usage: execution.usage
      };
      this.repo.saveDecision(runId, execution.subject, execution.asOf, rejected);
      archiveDecisionBaseline(this.deps.db, this.deps.persist, {
        runId,
        subject: execution.subject,
        asOf: execution.asOf,
        decision: rejected
      });
      this.repo.updateRunTerminal({
        runId,
        status: 'canceled',
        endedAt: this.now(),
        state,
        rating: rejected.rating,
        reviewRequired: true,
        usage: execution.usage
      });
      bus.emit({ type: 'run.canceled', reason: 'rejected' });
      this.repo.deleteRunCheckpoints(runId);
      this.persistScheduler.flushNow();
      return ok({ runId, status: 'canceled', resumedAt: this.now() });
    }

    this.suspended.delete(runId);
    const ctx: ActiveRun = {
      canceled: false,
      cancelReason: 'user',
      finished: false,
      execution: Promise.resolve()
    };
    execution.ctx = ctx;
    // 审批等待时长不计入运行超时预算；恢复后重新计时。
    execution.deadline = Date.now() + (execution.options.timeoutMs ?? 600000);
    execution.nodeDeps.approval = resolution;
    execution.bus = new RunEventBus({
      runId,
      startSeq: this.repo.getMaxSeq(runId),
      write: (envelope) => this.repo.writeEvent(envelope),
      send: this.deps.send,
      now: this.now
    });
    // 审批结果已消费：立即清理持久化快照，避免重复 resume 复用同一份挂起。
    // 重启路径还必须先把库内状态改为 running，保证重复 resume 命中 E_RUN_TERMINAL。
    this.repo.clearRunSuspend(runId);
    if (restartInput) this.repo.updateRunResumed(runId);
    this.active.set(runId, ctx);
    const driveInput = restartInput ?? { kind: 'resume' as const, resolution };
    ctx.execution = this.drive(execution, driveInput).finally(() => {
      ctx.finished = true;
      if (this.active.get(runId) === ctx) this.active.delete(runId);
    });
    return ok({ runId, status: 'running', resumedAt: this.now() });
  }

  /**
   * P7：任意断点续跑。策略为“启动只标记可恢复，用户在 UI 手动继续”，理由：
   *  1) 真实模型调用会产生费用，静默自动续跑不可解释；
   *  2) 用户可能在崩溃后想先查看已完成节点与中间结论；
   *  3) 与 P5 审批挂起保持同一交互心智：interrupted 永远需要用户动作。
   */
  async resumeCheckpoint(
    req: ResumeCheckpointRequest
  ): Promise<AgentIpcResponse<ResumeCheckpointResponse>> {
    if (!req || typeof req.runId !== 'string' || req.runId.length === 0) {
      return error('E_VALIDATION', 'runId 不能为空');
    }
    const runId = req.runId;
    const detail = this.repo.getRunDetail(runId);
    if (!detail) return error('E_RUN_NOT_FOUND', `未找到运行: ${runId}`);
    if (detail.status !== 'interrupted') {
      return error('E_RUN_TERMINAL', `运行状态为 ${detail.status}，不可重复续跑`);
    }
    if (this.active.size > 0) {
      return error('E_RUN_ACTIVE', '已有运行进行中，请先等待完成');
    }
    const recovery = this.repo.getRunRecovery(runId);
    if (!recovery) {
      if (this.suspended.get(runId) || this.repo.getRunSuspend(runId)) {
        return error('E_RESUME_NO_CHECKPOINT', '该运行等待人工审批，请使用审批恢复');
      }
      this.repo.updateRunTerminal({
        runId,
        status: 'failed',
        endedAt: this.now(),
        errorCode: 'E_PROCESS_RESTART',
        errorMessage: '缺少断点恢复元数据，无法续跑'
      });
      this.persistScheduler.flushNow();
      return error('E_PROCESS_RESTART', '缺少断点恢复元数据，运行已安全降级为 failed');
    }

    // 图版本/prompt 版本变化都拒绝恢复，避免静默跑错。
    const graphRec = this.repo.getGraphRecord(recovery.graphId, recovery.graphVersion);
    if (
      !graphRec ||
      graphRec.digest !== recovery.graphDigest ||
      (detail.graphDigest && detail.graphDigest !== recovery.graphDigest)
    ) {
      return error('E_RESUME_STALE_GRAPH', '图版本或图摘要已变化，拒绝从旧 checkpoint 恢复', {
        expectedDigest: recovery.graphDigest,
        actualDigest: graphRec?.digest,
        graphId: recovery.graphId,
        graphVersion: recovery.graphVersion
      });
    }
    const prompt = detail.prompt ?? this.repo.getRunPromptSnapshot(runId);
    if (!prompt || prompt.digest !== recovery.promptDigest || prompt.version !== recovery.promptVersion) {
      return error('E_RESUME_STALE_PROMPT', 'run 绑定的 prompt 版本/摘要已变化，拒绝恢复', {
        expectedDigest: recovery.promptDigest,
        actualDigest: prompt?.digest,
        expectedVersion: recovery.promptVersion,
        actualVersion: prompt?.version
      });
    }

    const inspected = inspectLatestCheckpoint(this.deps.db, runId);
    if (!inspected.ok) {
      this.repo.updateRunTerminal({
        runId,
        status: 'failed',
        endedAt: this.now(),
        errorCode: 'E_PROCESS_RESTART',
        errorMessage: `checkpoint ${inspected.reason === 'missing' ? '缺失' : '损坏'}，已安全降级`
      });
      this.repo.deleteRunCheckpoints(runId);
      this.persistScheduler.flushNow();
      return error('E_PROCESS_RESTART', `checkpoint ${inspected.reason === 'missing' ? '缺失' : '损坏'}，运行已安全降级为 failed`);
    }
    // checkpoint 内嵌的 run 元数据也必须与 run 绑定一致，防止线程被换绑/篡改。
    if (
      (inspected.runMeta?.graphDigest && inspected.runMeta.graphDigest !== recovery.graphDigest) ||
      (inspected.runMeta?.promptDigest && inspected.runMeta.promptDigest !== recovery.promptDigest)
    ) {
      return error('E_RESUME_STALE_GRAPH', 'checkpoint 内嵌的图/prompt 摘要与 run 绑定不一致，拒绝恢复');
    }

    const storedUsage = this.repo.getRunUsage(runId);
    const usage: RunUsage =
      storedUsage.calls > 0 || storedUsage.promptChars > 0
        ? storedUsage
        : { ...recovery.usage };
    const attemptBases = this.repo.getNodeAttemptBases(runId);
    const options: RunOptions = detail.config ?? { forceMock: recovery.isMock };
    const provider = recovery.isMock ? this.deps.mockProvider : this.deps.provider;
    const ctx: ActiveRun = {
      canceled: false,
      cancelReason: 'user',
      finished: false,
      execution: Promise.resolve()
    };
    const execution = this.buildExecution(
      ctx,
      runId,
      graphRec.spec,
      recovery.graphDigest,
      detail.subject,
      detail.asOf,
      options,
      provider,
      recovery.isMock,
      prompt,
      {
        usage,
        attemptBases,
        startSeq: this.repo.getMaxSeq(runId)
      }
    );

    // 先改状态再驱动：并发/重复 resume 立即命中 E_RUN_TERMINAL。
    this.repo.updateRunResumed(runId);
    this.repo.clearRunRecovery(runId);
    this.active.set(runId, ctx);
    ctx.execution = this.drive(execution, { kind: 'resume_checkpoint' }).finally(() => {
      ctx.finished = true;
      if (this.active.get(runId) === ctx) this.active.delete(runId);
    });
    return ok({
      runId,
      status: 'running',
      resumedAt: this.now(),
      fromCheckpointId: inspected.checkpointId as string
    });
  }

  async waitForRun(runId: string): Promise<void> {
    const ctx = this.active.get(runId);
    if (ctx) await ctx.execution;
  }

  private validateStart(
    req: StartRunRequest
  ):
    | { error: AgentIpcResponse<StartRunResponse> }
    | {
        subject: StartRunRequest['subject'];
        asOf: string;
        options: Required<Pick<RunOptions, 'forceMock'>> & RunOptions;
      } {
    if (!req || typeof req !== 'object') return { error: error('E_VALIDATION', '请求体非法') };
    if (typeof req.graphId !== 'string' || req.graphId.length === 0) {
      return { error: error('E_VALIDATION', 'graphId 不能为空') };
    }
    const subject = req.subject;
    if (
      !subject ||
      typeof subject.key !== 'string' ||
      subject.key.length === 0 ||
      subject.key.length > 200 ||
      typeof subject.label !== 'string' ||
      subject.label.trim().length === 0 ||
      subject.label.length > 100 ||
      (subject.kind !== 'topic' &&
        subject.kind !== 'country' &&
        subject.kind !== 'event' &&
        subject.kind !== 'stock')
    ) {
      return { error: error('E_VALIDATION', 'subject 非法') };
    }
    // 图与主体命名空间隔离：股票图只能跑 stock 主体，stock 主体也只能跑股票图。
    if (req.graphId === STOCK_GRAPH_ID && subject.kind !== 'stock') {
      return { error: error('E_VALIDATION', 'stock-analysis 图只接受 kind=stock 的主体') };
    }
    if (subject.kind === 'stock' && req.graphId !== STOCK_GRAPH_ID) {
      return { error: error('E_VALIDATION', 'kind=stock 的主体只能在 stock-analysis 图上运行') };
    }
    if (!isIso(req.asOf)) return { error: error('E_VALIDATION', 'asOf 必须是 ISO 时间') };
    const nowMs = Date.parse(this.now());
    if (Date.parse(req.asOf) > nowMs + 60000) {
      return { error: error('E_VALIDATION', 'asOf 不得晚于当前时间') };
    }
    const raw = req.options ?? {};
    const timeoutMs = raw.timeoutMs ?? 600000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 10000 || timeoutMs > 3600000) {
      return { error: error('E_VALIDATION', 'timeoutMs 需在 10000-3600000') };
    }
    const maxCostUsd = raw.maxCostUsd ?? 0.3;
    if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0 || maxCostUsd > 5) {
      return { error: error('E_VALIDATION', 'maxCostUsd 需在 (0,5]') };
    }
    return {
      subject,
      asOf: req.asOf,
      options: { ...raw, timeoutMs, maxCostUsd, forceMock: raw.forceMock === true }
    };
  }

  private finalizeUsage(usage: RunUsage, isMock: boolean): void {
    usage.tokensIn = Math.round(usage.promptChars / 3);
    usage.tokensOut = Math.round(usage.completionChars / 3);
    usage.costUsd = isMock ? 0 : estimateCostUsd(usage);
  }

  /** 组装执行上下文并编译图；interrupt 后该上下文原样保留，resume 直接复用。 */
  private buildExecution(
    ctx: ActiveRun,
    runId: string,
    spec: GraphSpec,
    graphDigest: string,
    subject: StartRunRequest['subject'],
    asOf: string,
    options: RunOptions,
    provider: AiProvider,
    isMock: boolean,
    prompt: AgentPromptPackSnapshot,
    extra: {
      /** P7：续跑时从 DB 累加已消耗用量，预算不因重启重置。 */
      usage?: RunUsage;
      attemptBases?: Record<string, number>;
      startSeq?: number;
    } = {}
  ): Execution {
    const usage: RunUsage = extra.usage
      ? { ...extra.usage }
      : { calls: 0, promptChars: 0, completionChars: 0 };
    const execution = {
      runId,
      spec,
      graphDigest,
      subject,
      asOf,
      options,
      provider,
      isMock,
      prompt,
      usage,
      startedAtMs: Date.now(),
      deadline: Date.now() + (options.timeoutMs ?? 600000),
      ctx,
      lastStarted: null,
      nodeTimes: new Map()
    } as unknown as Execution;
    execution.bus = new RunEventBus({
      runId,
      startSeq: extra.startSeq,
      write: (envelope) => this.repo.writeEvent(envelope),
      send: this.deps.send,
      now: this.now
    });

    const checkCanceled = this.createCheckCanceled(execution);
    const nodeDeps: AgentNodeDeps = {
      db: this.deps.db,
      generate: this.createGenerate(execution),
      checkCanceled,
      asOf,
      prompts: execution.prompt.prompts
    };
    execution.nodeDeps = nodeDeps;

    // P7：thread_id 绑定 runId；节点完成/并行 writes 由 LangGraph 写入该 saver。
    const checkpointSaver = new SqlJsCheckpointSaver(
      this.deps.db,
      {
        persist: () => this.persistScheduler.flushNow(),
        immediateFlush: this.immediateCheckpointFlush
      },
      {
        graphId: spec.id,
        graphVersion: spec.version,
        graphDigest,
        promptVersion: prompt.version,
        promptDigest: prompt.digest,
        threadId: runId
      }
    );
    execution.checkpointSaver = checkpointSaver;
    this.checkpointSavers.set(runId, checkpointSaver);

    const { graph } = compileAgentGraph(spec, nodeDeps, this.createHooks(execution), {
      nodeTimeoutMs: spec.settings.nodeTimeoutMs,
      skipTimeout: isMock,
      checkpointer: checkpointSaver,
      attemptBases: extra.attemptBases
    });
    execution.graph = graph;
    return execution;
  }

  /** P5：进程重启后重建 final-only 图。只执行被中断的 final 节点，
   *  不重新编译/执行其余节点，也不 eval 图内容。 */
  private buildRestartExecution(runId: string, snap: RunSuspendSnapshot, spec: GraphSpec): Execution {
    const usage: RunUsage = {
      calls: snap.usage.calls ?? 0,
      promptChars: snap.usage.promptChars ?? 0,
      completionChars: snap.usage.completionChars ?? 0,
      tokensIn: snap.usage.tokensIn,
      tokensOut: snap.usage.tokensOut,
      costUsd: snap.usage.costUsd
    };
    const ctx: ActiveRun = {
      canceled: false,
      cancelReason: 'user',
      finished: false,
      execution: Promise.resolve()
    };
    const provider = snap.isMock ? this.deps.mockProvider : this.deps.provider;
    const execution = {
      runId,
      spec,
      graphDigest: snap.graphDigest,
      subject: snap.subject,
      asOf: snap.asOf,
      options: snap.options,
      provider,
      isMock: snap.isMock,
      prompt: snap.prompt ?? DEFAULT_PROMPT_PACK,
      usage,
      startedAtMs: Date.now(),
      // 审批等待时长不计入超时预算，恢复后重新计时。
      deadline: Date.now() + (snap.options.timeoutMs ?? 600000),
      ctx,
      lastStarted: null,
      nodeTimes: new Map()
    } as unknown as Execution;
    execution.bus = new RunEventBus({
      runId,
      startSeq: this.repo.getMaxSeq(runId),
      write: (envelope) => this.repo.writeEvent(envelope),
      send: this.deps.send,
      now: this.now
    });
    const checkCanceled = this.createCheckCanceled(execution);
    execution.nodeDeps = {
      db: this.deps.db,
      generate: this.createGenerate(execution),
      checkCanceled,
      asOf: snap.asOf,
      prompts: execution.prompt.prompts
    };

    const finalNode =
      spec.nodes.find((n) => n.id === snap.finalNodeId) ??
      spec.nodes.find((n) => n.type === 'final');
    if (!finalNode || finalNode.type !== 'final') {
      throw new AgentRuntimeError(
        'E_RESUME_STALE_GRAPH',
        `快照中的 final 节点 ${snap.finalNodeId} 不在绑定版本中，无法恢复`
      );
    }
    const miniSpec: GraphSpec = {
      ...spec,
      nodes: [finalNode],
      edges: [
        { id: '__restart_start_final', source: '__start__', target: finalNode.id },
        { id: '__restart_final_end', source: finalNode.id, target: '__end__' }
      ]
    };
    const { graph } = compileAgentGraph(miniSpec, execution.nodeDeps, this.createHooks(execution), {
      nodeTimeoutMs: spec.settings.nodeTimeoutMs,
      skipTimeout: snap.isMock,
      skipInterrupt: true,
      attemptBase: Math.max(1, snap.attempt)
    });
    execution.graph = graph;
    return execution;
  }

  private createCheckCanceled(execution: Execution): () => void {
    return (): void => {
      if (execution.ctx.canceled) throw new AgentCanceledError();
    };
  }

  /** 模型调用统一入口：预算/超时护栏、错误归一化、用量累计。 */
  private createGenerate(execution: Execution): (messages: ChatMessage[]) => Promise<string> {
    const { usage, isMock, provider, options } = execution;
    return async (messages: ChatMessage[]): Promise<string> => {
      if (execution.ctx.canceled) throw new AgentCanceledError();
      // Mock 路径不受预算与时长限制，保证无 Key 也能完整验收。
      if (!isMock) {
        if (usage.calls >= MAX_MODEL_CALLS) {
          throw new AgentRuntimeError(
            'E_PROVIDER',
            `模型调用次数超出预算（上限 ${MAX_MODEL_CALLS} 次）`
          );
        }
        if (Date.now() >= execution.deadline) throw new AgentTimeoutError('运行总时长超出预算');
      }
      usage.calls += 1;
      usage.promptChars += messages.reduce((n, m) => n + m.content.length, 0);
      // P5：token 流式只做增量推送；按 80 字符聚合落库，单次调用封顶 8000 字符。
      let buffered = '';
      let emittedChars = 0;
      const flush = (force: boolean): void => {
        const ctx = this.nodeContext.getStore();
        if (!ctx || buffered.length === 0) return;
        if (!force && buffered.length < TOKEN_FLUSH_CHARS) return;
        const room = TOKEN_MAX_CHARS_PER_CALL - emittedChars;
        if (room <= 0) {
          buffered = '';
          return;
        }
        const chunk = buffered.slice(0, room);
        buffered = buffered.slice(room);
        if (!chunk) return;
        emittedChars += chunk.length;
        execution.bus.emit({ type: 'node.token', nodeId: ctx.nodeId, delta: chunk, attempt: ctx.attempt });
      };
      const onDelta = (delta: string): void => {
        // 已取消/已超时的流不再写入事件，避免终态后继续追加。
        if (!delta || execution.ctx.canceled) return;
        buffered += delta;
        flush(false);
      };
      let text: string;
      try {
        if (provider.generateStream) {
          text = isMock
            ? await provider.generateStream(messages, onDelta)
            : await this.callStreamWithDeadline(provider, messages, onDelta, execution.deadline);
          flush(true);
        } else {
          text = isMock
            ? await provider.generate(messages)
            : await this.callWithDeadline(provider, messages, execution.deadline);
        }
      } catch (err) {
        if (err instanceof AgentTimeoutError) throw err;
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 429) {
          throw new AgentRuntimeError('E_PROVIDER_RATE_LIMIT', '模型服务限流，请稍后重试');
        }
        throw new AgentRuntimeError(
          'E_PROVIDER',
          `模型调用失败: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      usage.completionChars += text.length;
      if (!isMock && estimateCostUsd(usage) > (options.maxCostUsd ?? 0.3)) {
        throw new AgentRuntimeError(
          'E_PROVIDER',
          `运行成本估算超过上限 $${options.maxCostUsd ?? 0.3}`
        );
      }
      if (execution.ctx.canceled) throw new AgentCanceledError();
      return text;
    };
  }

  private createHooks(execution: Execution): GraphRunHooks {
    const runId = execution.runId;
    return {
      checkCanceled: this.createCheckCanceled(execution),
      withNodeContext: (node, attempt, fn) => this.nodeContext.run({ nodeId: node.id, attempt }, fn),
      onNodeStarted: (node: GraphNodeSpec, attempt, inputSummary) => {
        const startedAt = this.now();
        execution.nodeTimes.set(`${node.id}:${attempt}`, { startedAt });
        execution.lastStarted = { nodeId: node.id, attempt, startedMs: Date.now() };
        this.repo.startNode({
          runId,
          nodeId: node.id,
          nodeType: node.type,
          attempt,
          startedAt,
          inputSummary
        });
        execution.bus.emit({
          type: 'node.started',
          nodeId: node.id,
          nodeType: node.type,
          attempt
        });
      },
      onNodeCompleted: (node, output, elapsedMs, attempt) => {
        const endedAt = this.now();
        const times = execution.nodeTimes.get(`${node.id}:${attempt}`);
        if (times) times.endedAt = endedAt;
        execution.lastStarted = null;
        this.repo.finishNode({
          runId,
          nodeId: node.id,
          attempt,
          status: 'succeeded',
          endedAt,
          elapsedMs,
          output
        });
        execution.bus.emit({
          type: 'node.completed',
          nodeId: node.id,
          outputPreview: previewOf(output),
          outputRef: `node:${runId}:${node.id}:${attempt}`,
          elapsedMs
        });
        // P7：节点边界持久化用量，续跑时累加而不是从 0 开始。
        this.repo.updateRunUsage(runId, execution.usage);
      },
      onNodeFailed: (node, err, elapsedMs, attempt) => {
        const endedAt = this.now();
        const times = execution.nodeTimes.get(`${node.id}:${attempt}`);
        if (times) times.endedAt = endedAt;
        execution.lastStarted = null;
        const info = extractAgentError(err);
        this.repo.finishNode({
          runId,
          nodeId: node.id,
          attempt,
          status: 'failed',
          endedAt,
          elapsedMs,
          errorCode: info.code,
          errorMessage: info.message
        });
        execution.bus.emit({
          type: 'node.failed',
          nodeId: node.id,
          code: info.code,
          message: info.message,
          retryable: false
        });
        this.repo.updateRunUsage(runId, execution.usage);
      },
      onDebateTurn: (node, entry, count, maxRounds, attempt) => {
        const turnTimes = execution.nodeTimes.get(`${node.id}:${attempt}`);
        execution.bus.emit({
          type: 'debate.turn',
          nodeId: node.id,
          round: entry.round,
          speaker: entry.stance,
          argument: entry.argument,
          rebuttals: entry.rebuttals,
          evidenceRefs: entry.evidenceRefs,
          confidence: entry.confidence,
          count,
          maxRounds,
          ...(turnTimes?.startedAt ? { startedAt: turnTimes.startedAt } : {}),
          ...(turnTimes?.endedAt ? { endedAt: turnTimes.endedAt } : {})
        });
      },
      onRiskTurn: (node, entry, count, maxRounds, attempt) => {
        const turnTimes = execution.nodeTimes.get(`${node.id}:${attempt}`);
        execution.bus.emit({
          type: 'risk.turn',
          nodeId: node.id,
          round: entry.round,
          stance: entry.stance,
          challenge: entry.challenge,
          mitigations: entry.mitigations,
          residualRisks: entry.residualRisks,
          confidence: entry.confidence,
          count,
          maxRounds,
          ...(turnTimes?.startedAt ? { startedAt: turnTimes.startedAt } : {}),
          ...(turnTimes?.endedAt ? { endedAt: turnTimes.endedAt } : {})
        });
      },
      onRouteTaken: (from, to, condition, edgeId) => {
        execution.bus.emit({ type: 'route.taken', from, to, condition, edgeId });
      }
    };
  }

  /** 推进图：start 从零开始；resume 用 Command 续跑同一 thread，已完成节点不重跑；
   *  restart_resume（P5）用持久化状态直接驱动 final-only 图。 */
  private async drive(
    execution: Execution,
    input:
      | { kind: 'start' }
      | { kind: 'resume'; resolution: ApprovalResolution }
      | { kind: 'restart_resume'; resolution: ApprovalResolution; state: Record<string, unknown> }
      | { kind: 'resume_checkpoint' }
  ): Promise<void> {
    const { bus, runId, spec, subject, asOf, options, usage } = execution;
    if (input.kind === 'start') {
      bus.emit({
        type: 'run.started',
        graphId: spec.id,
        graphVersion: spec.version,
        subject,
        asOf
      });
    } else if (input.kind === 'resume_checkpoint') {
      bus.emit({ type: 'run.resumed', resolution: 'checkpoint' });
    } else {
      bus.emit({ type: 'run.resumed', resolution: input.resolution.type });
    }

    try {
      const invocation =
        input.kind === 'start'
          ? ({ runId, asOf, subject } as never)
          : input.kind === 'restart_resume'
            ? (input.state as never)
            : input.kind === 'resume_checkpoint'
              ? // P7：null 表示从最新 checkpoint 继续；已完成的节点与 pending writes 都从 saver 恢复。
                (null as never)
              : (new Command({ resume: input.resolution }) as never);
      const state = (await execution.graph.invoke(invocation, {
        configurable: { thread_id: runId },
        recursionLimit: computeRecursionLimit(spec)
      })) as import('./state.js').AgentState;
      // LangGraph 的 interrupt 不以异常返回，而是在 invoke 结果中带 __interrupt__。
      if (isInterrupted(state)) {
        await this.handleInterrupted(execution);
        return;
      }

      const baseDecision: FinalDecision =
        state.decision ?? reviewDecision(7, new Date(asOf), 'missing_judge_decision');
      this.finalizeUsage(usage, execution.isMock);
      const elapsedMs = Date.now() - execution.startedAtMs;

      this.repo.saveDecision(runId, subject, asOf, baseDecision);
      // P3：写入待结算记录并快照基准（review 不进入结算）。
      archiveDecisionBaseline(this.deps.db, this.deps.persist, {
        runId,
        subject,
        asOf,
        decision: baseDecision
      });
      this.repo.updateRunTerminal({
        runId,
        status: 'completed',
        endedAt: this.now(),
        state: { ...state, usage },
        rating: baseDecision.rating,
        reviewRequired: baseDecision.reviewRequired,
        usage
      });
      bus.emit({
        type: 'run.completed',
        rating: baseDecision.rating,
        reviewRequired: baseDecision.reviewRequired,
        elapsedMs,
        usage
      });
      this.suspended.delete(runId);
      // P7：终态后 checkpoint 不再需要，删除线程数据并立即落盘。
      this.repo.deleteRunCheckpoints(runId);
      this.persistScheduler.flushNow();
    } catch (err) {
      if (isGraphInterrupt(err)) {
        await this.handleInterrupted(execution);
        return;
      }
      // P7：checkpoint 反序列化失败时安全降级为 failed + E_PROCESS_RESTART，不崩溃。
      const info =
        err instanceof CheckpointCorruptError
          ? { code: 'E_PROCESS_RESTART' as const, message: `checkpoint 损坏，已安全降级：${err.message}` }
          : extractAgentError(err);
      if (execution.ctx.canceled || isCanceled(err)) {
        this.repo.updateRunTerminal({
          runId,
          status: 'canceled',
          endedAt: this.now(),
          usage
        });
        bus.emit({ type: 'run.canceled', reason: execution.ctx.cancelReason });
      } else {
        this.repo.updateRunTerminal({
          runId,
          status: 'failed',
          endedAt: this.now(),
          errorCode: info.code,
          errorMessage: info.message,
          usage
        });
        bus.emit({ type: 'run.failed', code: info.code, message: info.message });
      }
      this.suspended.delete(runId);
      this.repo.deleteRunCheckpoints(runId);
      this.persistScheduler.flushNow();
    }
  }

  /** 把挂起节点标记为 skipped，写入状态快照，并发出 run.interrupted 事件。 */
  private async handleInterrupted(execution: Execution): Promise<void> {
    const { graph, runId, usage } = execution;
    const started = execution.lastStarted;
    execution.lastStarted = null;
    let values: Record<string, unknown> = {};
    try {
      const snapshot = await graph.getState({ configurable: { thread_id: runId } });
      values = (snapshot?.values ?? {}) as Record<string, unknown>;
    } catch {
      values = {};
    }
    if (started) {
      this.repo.finishNode({
        runId,
        nodeId: started.nodeId,
        attempt: started.attempt,
        status: 'skipped',
        endedAt: this.now(),
        elapsedMs: Date.now() - started.startedMs
      });
    }
    this.finalizeUsage(usage, execution.isMock);
    const state = { ...values, usage };
    this.repo.updateRunInterrupted(runId, state, usage);
    const approval: ApprovalContext = {
      nodeId: started?.nodeId ?? 'final',
      stage: 'final_approval',
      decision: values.decision as FinalDecision | undefined,
      proposal: values.proposal as import('../../../shared/agent.js').ObservationPlan | undefined
    };
    // P5：持久化最小恢复快照，进程重启后可直接恢复 final 审批。
    const snapshot: RunSuspendSnapshot = {
      v: 1,
      graphId: execution.spec.id,
      graphVersion: execution.spec.version,
      graphDigest: execution.graphDigest,
      subject: execution.subject,
      asOf: execution.asOf,
      options: execution.options,
      isMock: execution.isMock,
      prompt: execution.prompt,
      state: values,
      approval,
      finalNodeId: approval.nodeId,
      attempt: Math.max(1, started?.attempt ?? 1),
      usage: execution.usage,
      suspendedAt: this.now()
    };
    try {
      this.repo.setRunSuspend(runId, JSON.stringify(snapshot));
    } catch (err) {
      // 快照写失败不应影响挂起本身；重启后会按 E_PROCESS_RESTART 安全降级。
      console.warn('[lumen] 写入挂起快照失败', err);
    }
    execution.bus.emit({
      type: 'run.interrupted',
      nodeId: approval.nodeId,
      reason: 'awaiting_approval',
      payload: approval as unknown as JsonObject
    });
    this.suspended.set(runId, execution);
    // P7：审批挂起也必须把 checkpoint 与 pending writes 立刻落盘，
    // 否则同进程 resume 依赖内存、跨进程只依赖 suspend_json，无法任意断点续跑。
    execution.checkpointSaver?.forceFlush();
    this.persistScheduler.flushNow();
  }

  /** P5：流式调用同样受总时长预算约束；超时后停止接收增量。 */
  private async callStreamWithDeadline(
    provider: AiProvider,
    messages: ChatMessage[],
    onDelta: (delta: string) => void,
    deadline: number
  ): Promise<string> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new AgentTimeoutError('运行总时长超出预算');
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    try {
      return await Promise.race([
        provider.generateStream!(messages, (delta) => {
          if (!timedOut) onDelta(delta);
        }),
        new Promise<string>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new AgentTimeoutError('运行总时长超出预算'));
          }, remaining);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async callWithDeadline(provider: AiProvider, messages: ChatMessage[], deadline: number): Promise<string> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new AgentTimeoutError('运行总时长超出预算');
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        provider.generate(messages),
        new Promise<string>((_resolve, reject) => {
          timer = setTimeout(() => reject(new AgentTimeoutError('运行总时长超出预算')), remaining);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export type { AgentRepository };
