import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAgentRun } from '../hooks/useAgentRun';
import { useGraphEditor } from '../hooks/useGraphEditor';
import { useI18n } from '../i18n/I18n';
import type { I18nKey } from '../i18n/dict';
import {
  RATING_LABELS,
  type AgentGraphGetResponse,
  type AgentGraphSaveResponse,
  type AgentRunStatus,
  type GraphSpecIssue,
  type MemoryListResponse,
  type MemorySettleResponse,
  type TrendRating
} from '../../shared/agent';
import AgentFlowCanvas from './agent/AgentFlowCanvas';
import GraphEditorPanel from './agent/GraphEditorPanel';
import PromptEditorPanel from './agent/PromptEditorPanel';

type InvokeResult = {
  ok?: boolean;
  data?: unknown;
  error?: string;
  code?: string;
  message?: string;
  details?: { issues?: GraphSpecIssue[] };
};

function statusKey(status: AgentRunStatus | 'idle'): I18nKey {
  return `agent.status.${status}` as I18nKey;
}

function ratingClass(rating?: TrendRating): string {
  return rating ? `rating-${rating}` : '';
}

export default function AgentTab() {
  const { t } = useI18n();
  const {
    state,
    graph,
    graphMeta,
    viewGraph,
    runs,
    runsLoading,
    start,
    cancel,
    resume,
    resumeCheckpoint,
    selectRun,
    refreshGraph,
    applySavedGraph
  } = useAgentRun();
  const editor = useGraphEditor();
  const [editing, setEditing] = useState(false);
  const [startBlocked, setStartBlocked] = useState(false);
  const [subject, setSubject] = useState('China');
  const [forceMock, setForceMock] = useState(false);
  const [selectedId, setSelectedId] = useState<string>('judge');
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const [showPrompts, setShowPrompts] = useState(false);
  const [editRating, setEditRating] = useState<TrendRating>('up');
  const [editThesis, setEditThesis] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [memory, setMemory] = useState<MemoryListResponse>();
  const [settling, setSettling] = useState(false);
  const [settleNote, setSettleNote] = useState('');
  const [resumingCheckpoint, setResumingCheckpoint] = useState(false);

  const active = state.status === 'running' || state.status === 'queued';
  const interrupted = state.status === 'interrupted';

  const onResumeCheckpoint = useCallback(async () => {
    setResumingCheckpoint(true);
    try {
      await resumeCheckpoint();
    } finally {
      setResumingCheckpoint(false);
    }
  }, [resumeCheckpoint]);

  const loadMemory = useCallback(async () => {
    const res = (await window.lumen.invoke('agent:memory:list')) as InvokeResult | undefined;
    if (res?.ok) setMemory(res.data as MemoryListResponse);
  }, []);

  useEffect(() => {
    void loadMemory();
  }, [loadMemory]);

  useEffect(() => {
    if (state.status === 'completed' || state.status === 'canceled' || state.status === 'failed') {
      void loadMemory();
    }
  }, [state.status, loadMemory]);

  const onSettle = async (): Promise<void> => {
    setSettling(true);
    try {
      const res = (await window.lumen.invoke('agent:memory:settle')) as InvokeResult | undefined;
      if (res?.ok) {
        const d = res.data as MemorySettleResponse;
        setSettleNote(
          t('agent.memory.settleResult', {
            scanned: d.scanned,
            settled: d.settled,
            insufficient: d.insufficient,
            skipped: d.skipped
          })
        );
        await loadMemory();
      } else {
        setSettleNote(res?.error ?? 'settle failed');
      }
    } finally {
      setSettling(false);
    }
  };

  useEffect(() => {
    if (!state.approval?.decision) return;
    setEditRating(state.approval.decision.rating);
    setEditThesis(state.approval.decision.thesis);
  }, [state.approval]);
  const selected = selectedId ? state.nodes[selectedId] : undefined;

  const nodeOutput = useMemo(() => {
    if (!selected) return undefined;
    if (selected.output) return JSON.stringify(selected.output, null, 2);
    return selected.preview;
  }, [selected]);

  const onStart = (): void => {
    if (editing && editor.state.dirty) {
      setStartBlocked(true);
      return;
    }
    setStartBlocked(false);
    const label = subject.trim() || 'China';
    const graphVersion = editing ? editor.state.baseVersion : graphMeta?.version;
    const expectedDigest = editing ? editor.state.baseDigest : graphMeta?.digest;
    void start({
      graphId: graph?.id ?? 'trend-analysis',
      ...(graphVersion ? { graphVersion } : {}),
      ...(expectedDigest ? { expectedDigest } : {}),
      subject: { key: `topic:${label}`, label, kind: 'topic' },
      asOf: new Date().toISOString(),
      options: { forceMock }
    });
  };

  const toggleEditing = (): void => {
    if (editing) {
      if (editor.state.dirty && !window.confirm(t('agent.editor.discardConfirm'))) return;
      setEditing(false);
      editor.load(graph ?? editor.state.draft!, graphMeta?.digest ?? '');
      return;
    }
    if (!graph) return;
    editor.load(graph, graphMeta?.digest ?? '');
    setStartBlocked(false);
    setEditing(true);
  };

  const reloadActiveGraph = async (): Promise<void> => {
    const res = (await window.lumen.invoke('agent:graphs:get', {
      graphId: 'trend-analysis'
    })) as InvokeResult | undefined;
    if (res?.ok) {
      const snapshot = res.data as AgentGraphGetResponse;
      applySavedGraph(snapshot.spec, snapshot.digest);
      editor.load(snapshot.spec, snapshot.digest);
    } else {
      await refreshGraph();
    }
  };

  const onSaveGraph = async (): Promise<void> => {
    const draft = editor.state.draft;
    if (!draft) return;
    editor.saveStart();
    const res = (await window.lumen.invoke('agent:graphs:save', {
      spec: draft,
      publish: true
    })) as InvokeResult | undefined;
    if (!res?.ok) {
      editor.saveFail(
        res?.details?.issues ?? [],
        `${res?.code ?? 'E_VALIDATION'}: ${res?.message ?? res?.error ?? 'save failed'}`
      );
      return;
    }
    const data = res.data as AgentGraphSaveResponse;
    editor.saveOk(data.spec, data.digest, new Date().toISOString());
    applySavedGraph(data.spec, data.digest);
    setStartBlocked(false);
  };

  const onDeleteVersion = async (): Promise<void> => {
    const draft = editor.state.draft;
    if (!draft) return;
    if (!window.confirm(t('agent.editor.deleteConfirm', { version: draft.version }))) return;
    const res = (await window.lumen.invoke('agent:graphs:delete', {
      graphId: draft.id,
      version: draft.version
    })) as InvokeResult | undefined;
    if (!res?.ok) {
      editor.saveFail(
        res?.details?.issues ?? [],
        `${res?.code ?? 'E_VALIDATION'}: ${res?.message ?? res?.error ?? 'delete failed'}`
      );
      return;
    }
    await reloadActiveGraph();
    setEditing(true);
  };

  const onRestoreDefault = async (): Promise<void> => {
    if (!window.confirm(t('agent.editor.restoreConfirm'))) return;
    const res = (await window.lumen.invoke('agent:graphs:restoreDefault')) as InvokeResult | undefined;
    if (!res?.ok) {
      editor.saveFail(
        res?.details?.issues ?? [],
        `${res?.code ?? 'E_VALIDATION'}: ${res?.message ?? res?.error ?? 'restore failed'}`
      );
      return;
    }
    const data = res.data as AgentGraphSaveResponse;
    editor.saveOk(data.spec, data.digest, new Date().toISOString());
    applySavedGraph(data.spec, data.digest);
    setEditing(true);
    setStartBlocked(false);
  };

  const nodeErrors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const issue of editor.state.issues) {
      if (issue.nodeId && !out[issue.nodeId]) out[issue.nodeId] = issue.message;
    }
    return out;
  }, [editor.state.issues]);

  const edgeErrors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const issue of editor.state.issues) {
      if (issue.edgeId && !out[issue.edgeId]) out[issue.edgeId] = issue.message;
    }
    return out;
  }, [editor.state.issues]);

  const canvasSpec = editing ? editor.state.draft : state.runId && viewGraph ? viewGraph.spec : graph;
  const canvasNodes = editing ? {} : state.nodes;

  return (
    <section>
      <div className="card">
        <h2>{t('agent.title')}</h2>
        <p className="muted">{t('agent.hint')}</p>
        <div className="agent-toolbar">
          <label className="agent-field">
            <span>{t('agent.subject')}</span>
            <input
              className="input"
              data-testid="agent-subject"
              value={subject}
              placeholder={t('agent.subjectPlaceholder')}
              onChange={(e) => setSubject(e.target.value)}
              disabled={active}
            />
          </label>
          <label className="agent-check">
            <input
              type="checkbox"
              data-testid="agent-force-mock"
              checked={forceMock}
              onChange={(e) => setForceMock(e.target.checked)}
              disabled={active}
            />
            {t('agent.forceMock')}
          </label>
          <button className="btn primary" data-testid="agent-start" onClick={onStart} disabled={active || interrupted || !graph}>
            {t('agent.start')}
          </button>
          <button className="btn" data-testid="agent-cancel" onClick={() => void cancel()} disabled={!active && !interrupted}>
            {t('agent.cancel')}
          </button>
          <button
            className={`btn${editing ? ' primary' : ''}`}
            data-testid="agent-edit-toggle"
            onClick={toggleEditing}
            disabled={active || interrupted}
          >
            {editing ? t('agent.editor.exit') : t('agent.editor.edit')}
          </button>
          <button
            className={`btn${showPrompts ? ' primary' : ''}`}
            data-testid="agent-prompt-toggle"
            onClick={() => setShowPrompts((v) => !v)}
          >
            {showPrompts ? t('agent.prompt.close') : t('agent.prompt.open')}
          </button>
          <span className={`agent-run-status status-${state.status}`} data-testid="agent-run-state" data-status={state.status}>
            {interrupted && state.recovery ? t('agent.status.recoverable') : t(statusKey(state.status))}
          </span>
          {graphMeta ? (
            <span className="muted">{t('agent.editor.version', { version: graphMeta.version })}</span>
          ) : null}
          {state.usage ? <span className="muted">{t('agent.usage', { calls: state.usage.calls })}</span> : null}
        </div>
        {startBlocked ? <p className="agent-error" data-testid="agent-start-blocked">{t('agent.editor.startBlocked')}</p> : null}
        {state.runId ? <p className="muted agent-run-id" data-testid="agent-run-id">{state.runId}</p> : null}
        {state.error ? <p className="agent-error" data-testid="agent-error">{t('agent.error', { msg: state.error })}</p> : null}
      </div>

      {interrupted && state.recovery ? (
        <div
          className="card agent-recovery-card"
          data-testid="agent-recovery"
          data-checkpoint-id={state.recovery.checkpointId}
          data-checkpoint-step={state.recovery.checkpointStep}
          data-checkpoint-usage={state.recovery.usage.calls}
        >
          <div className="agent-debate-head">
            <h3>{t('agent.recovery.title')}</h3>
            <span className="agent-review-flag">{t('agent.recovery.waiting')}</span>
          </div>
          <p className="muted">
            {t('agent.recovery.hint', {
              step: state.recovery.checkpointStep,
              calls: state.recovery.usage.calls
            })}
          </p>
          <div className="agent-approval-actions">
            <button
              className="btn primary"
              data-testid="agent-recovery-resume"
              onClick={() => void onResumeCheckpoint()}
              disabled={resumingCheckpoint}
            >
              {t('agent.recovery.resume')}
            </button>
            <button className="btn" data-testid="agent-recovery-cancel" onClick={() => void cancel()}>
              {t('agent.approval.reject')}
            </button>
          </div>
        </div>
      ) : null}

      {interrupted && state.approval ? (
        <div className="card agent-approval-card" data-testid="agent-approval">
          <div className="agent-debate-head">
            <h3>{t('agent.approval.title')}</h3>
            <span className="agent-review-flag">{t('agent.approval.waiting')}</span>
          </div>
          <p className="muted">{t('agent.approval.hint')}</p>
          {state.approval.decision ? (
            <p className="agent-approval-suggested">
              {t('agent.approval.suggested', {
                rating: RATING_LABELS[state.approval.decision.rating],
                confidence: `${(state.approval.decision.confidence * 100).toFixed(0)}%`
              })}
              <br />
              {state.approval.decision.thesis}
            </p>
          ) : null}
          <div className="agent-approval-actions">
            <button className="btn primary" data-testid="agent-approve" onClick={() => void resume({ type: 'approve' })}>
              {t('agent.approval.approve')}
            </button>
            <button
              className="btn"
              data-testid="agent-apply-edit"
              onClick={() =>
                void resume({
                  type: 'edit',
                  patch: {
                    rating: editRating,
                    ...(editThesis.trim() ? { thesis: editThesis.trim() } : {})
                  }
                })
              }
            >
              {t('agent.approval.applyEdit')}
            </button>
            <button
              className="btn danger"
              data-testid="agent-reject"
              onClick={() =>
                void resume({
                  type: 'reject',
                  ...(rejectReason.trim() ? { reason: rejectReason.trim() } : {})
                })
              }
            >
              {t('agent.approval.reject')}
            </button>
          </div>
          <div className="agent-approval-edit">
            <label className="agent-field">
              <span>{t('agent.approval.editRating')}</span>
              <select
                className="input"
                value={editRating}
                onChange={(e) => setEditRating(e.target.value as TrendRating)}
              >
                {(Object.keys(RATING_LABELS) as TrendRating[]).map((r) => (
                  <option key={r} value={r}>
                    {RATING_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
            <label className="agent-field agent-approval-thesis">
              <span>{t('agent.approval.editThesis')}</span>
              <textarea
                className="input"
                rows={3}
                value={editThesis}
                onChange={(e) => setEditThesis(e.target.value)}
              />
            </label>
            <label className="agent-field">
              <span>{t('agent.approval.rejectReason')}</span>
              <input
                className="input"
                value={rejectReason}
                placeholder={t('agent.approval.reasonPlaceholder')}
                onChange={(e) => setRejectReason(e.target.value)}
              />
            </label>
          </div>
        </div>
      ) : null}

      <div className="agent-workbench">
        <div className="card agent-flow-card">
          <div className="agent-debate-head">
            <h3>{t('agent.graph.title')}</h3>
            {state.runId && viewGraph ? (
              <span className="muted" data-testid="agent-graph-version" data-version={viewGraph.version} data-digest={viewGraph.digest}>
                {t('agent.editor.historyVersion', { version: viewGraph.version })}
                {' · '}
                {viewGraph.digest.slice(0, 10)}
              </span>
            ) : graphMeta ? (
              <span className="muted" data-testid="agent-graph-version" data-version={graphMeta.version} data-digest={graphMeta.digest}>
                {t('agent.editor.version', { version: graphMeta.version })}
                {' · '}
                {graphMeta.digest.slice(0, 10)}
              </span>
            ) : null}
          </div>
          <div className="agent-legend">
            <span className="legend-item"><i className="dot pending" />{t('agent.legend.pending')}</span>
            <span className="legend-item"><i className="dot running" />{t('agent.legend.running')}</span>
            <span className="legend-item"><i className="dot done" />{t('agent.legend.done')}</span>
            <span className="legend-item"><i className="dot error" />{t('agent.legend.error')}</span>
          </div>
          <AgentFlowCanvas
            spec={canvasSpec}
            nodes={canvasNodes}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              setSelectedEdgeId(undefined);
            }}
            selectedEdgeId={selectedEdgeId}
            onSelectEdge={(id) => {
              setSelectedEdgeId(id);
              setSelectedId('');
            }}
            edgeErrors={editing ? edgeErrors : undefined}
            routeEdgeId={state.lastRoute?.edgeId}
            editable={editing && !active && !interrupted}
            nodeErrors={editing ? nodeErrors : undefined}
            onNodePosition={(id, x, y) => editor.position(id, x, y)}
            onConnectEdge={(source, target) => editor.connect(source, target)}
            onDeleteNodes={(ids) => editor.removeNodes(ids)}
            onDeleteEdges={(ids) => editor.removeEdges(ids)}
            streams={state.streams}
          />
          <p className="muted">
            {editing ? t('agent.editor.connectHint') : t('agent.node.select')}
          </p>
        </div>

        <div className="card agent-node-panel" data-testid="agent-node-panel">
          {editing ? (
            <GraphEditorPanel
              draft={editor.state.draft}
              status={graphMeta?.status}
              activeVersion={graphMeta?.version}
              dirty={editor.state.dirty}
              saving={editor.state.saving}
              issues={editor.state.issues}
              notice={editor.state.notice}
              error={editor.state.error}
              savedAt={editor.state.savedAt}
              selectedNodeId={selectedId}
              selectedEdgeId={selectedEdgeId}
              nodeErrors={nodeErrors}
              onSelectNode={(id) => {
                setSelectedId(id);
                setSelectedEdgeId(undefined);
              }}
              onSelectEdge={(id) => {
                setSelectedEdgeId(id);
                setSelectedId('');
              }}
              onEdgeCondition={editor.setEdgeCondition}
              onEdgeTarget={editor.setEdgeTarget}
              onEdgeWhenDone={editor.setEdgeWhenDone}
              onLabel={editor.label}
              onJoinMode={editor.joinMode}
              onConfig={editor.config}
              onSetting={editor.setting}
              onAddNode={editor.addNode}
              onSave={() => void onSaveGraph()}
              onDeleteVersion={() => void onDeleteVersion()}
              onRestoreDefault={() => void onRestoreDefault()}
            />
          ) : (
            <>
              <h3 data-testid="agent-node-title">{selectedId || t('agent.node.output')}</h3>
              {selected ? (
                <>
                  <p className="muted">
                    {t('agent.node.elapsed')}: {typeof selected.elapsedMs === 'number' ? `${selected.elapsedMs}ms` : '—'}
                  </p>
                  {selected.error ? <p className="agent-error">{selected.error}</p> : null}
                  {selectedId && state.streams[selectedId] ? (
                    <pre className="agent-stream" data-testid="agent-node-stream-detail">{state.streams[selectedId]}</pre>
                  ) : null}
                  {nodeOutput ? (
                    <pre className="agent-output">{nodeOutput}</pre>
                  ) : (
                    <p className="muted">{t('agent.node.empty')}</p>
                  )}
                </>
              ) : (
                <p className="muted">{t('agent.node.empty')}</p>
              )}
            </>
          )}
        </div>
      </div>

      {showPrompts ? <PromptEditorPanel onClose={() => setShowPrompts(false)} /> : null}

      <div className="card agent-debate-card">
        <div className="agent-debate-head">
          <h3>{t('agent.debate.title')}</h3>
          {state.debate.maxRounds > 0 ? (
            <span className="muted">
              {t('agent.debate.progress', {
                spoken: state.debate.count,
                total: state.debate.maxRounds * 2,
                round: state.debate.currentRound
              })}
            </span>
          ) : (
            <span className="muted">{t('agent.debate.empty')}</span>
          )}
        </div>
        {state.debate.entries.length > 0 ? (
          <ol className="agent-debate-list" data-testid="agent-debate-list">
            {state.debate.entries.map((entry) => (
              <li
                key={`${entry.round}-${entry.stance}`}
                className={`agent-debate-item speaker-${entry.stance}`}
                data-testid="agent-debate-item"
                data-stance={entry.stance}
                data-round={entry.round}
              >
                <div className="agent-debate-item-head">
                  <span className="agent-debate-round">
                    {t('agent.debate.round', { round: entry.round })}
                  </span>
                  <span className={`agent-debate-speaker ${entry.stance}`}>
                    {t(entry.stance === 'bull' ? 'agent.debate.bull' : 'agent.debate.bear')}
                  </span>
                  <span className="muted">
                    {t('agent.debate.confidence', { value: (entry.confidence * 100).toFixed(0) })}
                  </span>
                </div>
                <p className="agent-debate-argument">{entry.argument}</p>
                {entry.rebuttals.length > 0 ? (
                  <ul className="agent-debate-rebuttals">
                    {entry.rebuttals.map((r, i) => (
                      <li key={`${r.target}-${i}`}>
                        {r.target}：{r.point}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">{t('agent.debate.empty')}</p>
        )}
      </div>

      <div className="card agent-debate-card">
        <div className="agent-debate-head">
          <h3>{t('agent.risk.title')}</h3>
          {state.risk.maxRounds > 0 ? (
            <span className="muted">
              {t('agent.risk.progress', {
                spoken: state.risk.count,
                total: state.risk.maxRounds * 3,
                round: state.risk.currentRound
              })}
            </span>
          ) : (
            <span className="muted">{t('agent.risk.empty')}</span>
          )}
        </div>
        {state.risk.entries.length > 0 ? (
          <ol className="agent-debate-list">
            {state.risk.entries.map((entry) => (
              <li key={`${entry.round}-${entry.stance}`} className={`agent-debate-item risk-${entry.stance}`}>
                <div className="agent-debate-item-head">
                  <span className="agent-debate-round">
                    {t('agent.risk.round', { round: entry.round })}
                  </span>
                  <span className={`agent-debate-speaker ${entry.stance}`}>
                    {t(`agent.risk.${entry.stance}` as I18nKey)}
                  </span>
                  <span className="muted">
                    {t('agent.debate.confidence', { value: (entry.confidence * 100).toFixed(0) })}
                  </span>
                </div>
                <p className="agent-debate-argument">{entry.challenge}</p>
                {entry.mitigations.length > 0 ? (
                  <div className="agent-risk-lines">
                    <strong>{t('agent.risk.mitigations')}</strong>
                    <ul>
                      {entry.mitigations.map((m, i) => (
                        <li key={`${m}-${i}`}>{m}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {entry.residualRisks.length > 0 ? (
                  <div className="agent-risk-lines">
                    <strong>{t('agent.risk.residual')}</strong>
                    <ul>
                      {entry.residualRisks.map((m, i) => (
                        <li key={`${m}-${i}`}>{m}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">{t('agent.risk.empty')}</p>
        )}
      </div>

      <div className="card">
        <h3>{t('agent.decision.title')}</h3>
        {state.decision || state.rating ? (
          <>
            <div className="agent-decision-head">
              <span className={`rating-badge ${ratingClass(state.rating)}`} data-testid="agent-rating" data-rating={state.rating ?? ''}>
                {state.rating ? RATING_LABELS[state.rating] : '—'}
              </span>
              {state.decision ? (
                <span className="muted">
                  {t('agent.decision.confidence')}: {(state.decision.confidence * 100).toFixed(0)}%
                </span>
              ) : null}
              {state.reviewRequired ? (
                <span className="agent-review-flag">{t('agent.decision.review')}</span>
              ) : null}
              {state.prompt ? (
                <span className="muted" data-testid="agent-run-prompt-version" data-version={state.prompt.version}>
                  {t('agent.prompt.runVersion', { version: state.prompt.version })}
                  {' · '}
                  {state.prompt.digest.slice(0, 10)}
                </span>
              ) : null}
            </div>
            {state.lastRoute ? (
              <p className="muted" data-testid="agent-route-taken" data-edge-id={state.lastRoute.edgeId ?? ''}>
                {t('agent.prompt.routeTaken', {
                  from: state.lastRoute.from,
                  to: state.lastRoute.to,
                  edge: state.lastRoute.edgeId ?? '—'
                })}
                {' · '}
                {state.lastRoute.condition}
              </p>
            ) : null}
            {state.decision ? (
              <div className="agent-decision-body">
                <div>
                  <h4>{t('agent.decision.thesis')}</h4>
                  <p>{state.decision.thesis}</p>
                </div>
                <div>
                  <h4>{t('agent.decision.risks')}</h4>
                  <ul>
                    {state.decision.keyRisks.length > 0 ? (
                      state.decision.keyRisks.map((r) => <li key={r}>{r}</li>)
                    ) : (
                      <li className="muted">—</li>
                    )}
                  </ul>
                </div>
                <div>
                  <h4>{t('agent.decision.nextCheck')}</h4>
                  <p className="muted">{state.decision.nextCheckAt}</p>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <p className="muted">{state.status === 'idle' ? t('agent.node.empty') : t('agent.status.running')}</p>
        )}
      </div>

      <div className="card">
        <div className="agent-debate-head">
          <h3>{t('agent.memory.title')}</h3>
          <button className="btn" data-testid="agent-memory-settle" onClick={() => void onSettle()} disabled={settling}>
            {settling ? t('agent.status.running') : t('agent.memory.settle')}
          </button>
        </div>
        <p className="muted">{t('agent.memory.hint')}</p>
        {memory ? (
          <>
            <div className="agent-memory-stats" data-testid="agent-memory-stats">
              <span className="muted">
                {t('agent.memory.stats', {
                  hits: memory.stats.hits,
                  misses: memory.stats.misses,
                  inconclusive: memory.stats.inconclusive,
                  rate: (memory.stats.hitRate * 100).toFixed(0)
                })}
              </span>
              <span className="muted">
                {t('agent.memory.pending')}: {memory.stats.pending}
              </span>
              <span className="muted">
                {t('agent.memory.settled')}: {memory.stats.settled}
              </span>
              <span className="muted">
                {t('agent.memory.insufficient')}: {memory.stats.insufficient}
              </span>
            </div>
            {settleNote ? <p className="muted" data-testid="agent-memory-settle-note">{settleNote}</p> : null}
            {memory.pending.length > 0 ? (
              <div className="agent-memory-section">
                <h4>{t('agent.memory.pending')}</h4>
                <ul className="agent-memory-list">
                  {memory.pending.map((d) => (
                    <li key={d.id} className="agent-memory-item">
                      <div className="agent-memory-item-head">
                        <span className="agent-memory-subject">{d.subjectLabel}</span>
                        <span className={`rating-badge ${ratingClass(d.rating)}`}>
                          {RATING_LABELS[d.rating]}
                        </span>
                        <span className="muted">
                          {t('agent.memory.resolveAfter')}: {d.resolveAfter.slice(0, 19).replace('T', ' ')}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {memory.settled.length > 0 ? (
              <div className="agent-memory-section">
                <h4>{t('agent.memory.settled')}</h4>
                <ul className="agent-memory-list">
                  {memory.settled.map((m) => (
                    <li key={m.id} className="agent-memory-item">
                      <div className="agent-memory-item-head">
                        <span className="agent-memory-subject">{m.subjectKey}</span>
                        <span className={`rating-badge ${ratingClass(m.rating)}`}>
                          {RATING_LABELS[m.rating]}
                        </span>
                        <span className={`agent-memory-verdict-${m.outcome.verdict}`}>
                          {t(`agent.memory.verdict.${m.outcome.verdict}` as I18nKey)}
                        </span>
                        <span className="muted">{m.resolvedAt.slice(0, 19).replace('T', ' ')}</span>
                      </div>
                      <p className="agent-memory-reflection">
                        {t('agent.memory.reflection')}：{m.reflection}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {memory.insufficient.length > 0 ? (
              <div className="agent-memory-section">
                <h4>{t('agent.memory.insufficient')}</h4>
                <ul className="agent-memory-list">
                  {memory.insufficient.map((d) => (
                    <li key={d.id} className="agent-memory-item">
                      <div className="agent-memory-item-head">
                        <span className="agent-memory-subject">{d.subjectLabel}</span>
                        <span className={`rating-badge ${ratingClass(d.rating)}`}>
                          {RATING_LABELS[d.rating]}
                        </span>
                        <span className="muted">
                          {d.resolvedAt ? d.resolvedAt.slice(0, 19).replace('T', ' ') : '—'}
                        </span>
                      </div>
                      <p className="agent-memory-reflection">{d.reflection ?? '—'}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {memory.pending.length === 0 && memory.settled.length === 0 && memory.insufficient.length === 0 ? (
              <p className="muted">{t('agent.memory.empty')}</p>
            ) : null}
          </>
        ) : null}
        <div className="agent-memory-section">
          <h4>{t('agent.memory.injected')}</h4>
          {state.memory && state.memory.lessons.length > 0 ? (
            <ul className="agent-memory-list">
              {state.memory.lessons.map((m) => (
                <li key={m.memoryId} className="agent-memory-item">
                  <div className="agent-memory-item-head">
                    <span className="agent-memory-subject">{m.subjectKey}</span>
                    <span className={`rating-badge ${ratingClass(m.rating)}`}>
                      {RATING_LABELS[m.rating]}
                    </span>
                    <span className="muted">{m.resolvedAt.slice(0, 19).replace('T', ' ')}</span>
                  </div>
                  <p className="agent-memory-reflection">{m.reflection}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t('agent.memory.noInjected')}</p>
          )}
        </div>
      </div>

      <div className="card">
        <h3>{t('agent.history.title')}</h3>
        <p className="muted">{t('agent.loadHint')}</p>
        {runsLoading ? <p className="muted">{t('agent.history.loading')}</p> : null}
        {!runsLoading && runs.length === 0 ? <p className="muted">{t('agent.history.empty')}</p> : null}
        {runs.length > 0 ? (
          <ul className="agent-runs" data-testid="agent-runs">
            {runs.map((run) => (
              <li key={run.runId}>
                <button
                  className={`agent-run-row${state.runId === run.runId ? ' active' : ''}`}
                  data-testid="agent-run-row"
                  data-run-id={run.runId}
                  data-status={run.status}
                  onClick={() => void selectRun(run.runId)}
                >
                  <span className="agent-run-subject">{run.subject.label}</span>
                  <span className={`agent-run-state status-${run.status}`}>{t(statusKey(run.status))}</span>
                  {run.rating ? (
                    <span className={`rating-badge ${ratingClass(run.rating)}`}>{RATING_LABELS[run.rating]}</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                  <span className="muted">v{run.graphVersion}</span>
                  {run.promptVersion !== undefined ? (
                    <span className="muted" data-testid="agent-run-prompt-version" data-version={run.promptVersion}>
                      pv{run.promptVersion}
                    </span>
                  ) : null}
                  {run.graphDigest ? <span className="muted">{run.graphDigest.slice(0, 8)}</span> : null}
                  <span className="muted">{run.startedAt.slice(0, 19).replace('T', ' ')}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
