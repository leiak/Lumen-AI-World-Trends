import type {
  AgentGraphStatus,
  AgentNodeType,
  GraphNodeSpec,
  GraphSpec,
  GraphSpecIssue,
  RunSettings
} from '../../../shared/agent';
import { useI18n } from '../../i18n/I18n';

export interface GraphEditorPanelProps {
  draft?: GraphSpec;
  status?: AgentGraphStatus;
  activeVersion?: number;
  dirty: boolean;
  saving: boolean;
  issues: GraphSpecIssue[];
  notice?: string;
  error?: string;
  savedAt?: string;
  selectedNodeId?: string;
  nodeErrors: Record<string, string>;
  onSelectNode: (nodeId: string) => void;
  onLabel: (nodeId: string, value: string) => void;
  onJoinMode: (nodeId: string, value: 'all' | 'any' | undefined) => void;
  onConfig: (nodeId: string, field: string, value: string | number) => void;
  onSetting: (field: string, value: number) => void;
  onAddNode: (type: AgentNodeType) => void;
  onSave: () => void;
  onDeleteVersion: () => void;
  onRestoreDefault: () => void;
}

const NODE_TYPES: AgentNodeType[] = [
  'memory',
  'evidence',
  'bull',
  'bear',
  'judge',
  'planner',
  'risk_aggressive',
  'risk_conservative',
  'risk_neutral',
  'final'
];

function NumberField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="agent-editor-field">
      <span>{props.label}</span>
      <input
        type="number"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={Number.isFinite(props.value) ? props.value : 0}
        onChange={(e) => {
          const next = e.target.value === '' ? 0 : Number(e.target.value);
          props.onChange(Number.isFinite(next) ? next : 0);
        }}
      />
    </label>
  );
}

function NodeInspector(props: {
  node: GraphNodeSpec;
  issue?: string;
  onLabel: (value: string) => void;
  onJoinMode: (value: 'all' | 'any' | undefined) => void;
  onConfig: (field: string, value: string | number) => void;
}) {
  const { t } = useI18n();
  const { node } = props;
  const cfg = node.config as unknown as Record<string, unknown>;
  const typeKey = `agent.editor.type.${node.type}` as
    | 'agent.editor.type.memory'
    | 'agent.editor.type.evidence'
    | 'agent.editor.type.bull'
    | 'agent.editor.type.bear'
    | 'agent.editor.type.judge'
    | 'agent.editor.type.planner'
    | 'agent.editor.type.risk_aggressive'
    | 'agent.editor.type.risk_conservative'
    | 'agent.editor.type.risk_neutral'
    | 'agent.editor.type.final';

  return (
    <div className="agent-editor-inspector" data-testid="agent-editor-inspector">
      <h4>{t('agent.editor.inspector')}</h4>
      {props.issue && <div className="agent-editor-node-error">{props.issue}</div>}
      <div className="agent-editor-meta">
        <span>{t('agent.editor.nodeId')}: {node.id}</span>
        <span>{t('agent.editor.nodeType')}: {t(typeKey)}</span>
      </div>
      <label className="agent-editor-field">
        <span>{t('agent.editor.label')}</span>
        <input value={node.label} maxLength={60} onChange={(e) => props.onLabel(e.target.value)} />
      </label>
      {(node.type === 'bull' || node.type === 'bear') && (
        <label className="agent-editor-field">
          <span>{t('agent.editor.joinMode')}</span>
          <select
            value={node.joinMode ?? 'any'}
            onChange={(e) => props.onJoinMode(e.target.value as 'all' | 'any')}
          >
            <option value="all">all</option>
            <option value="any">any</option>
          </select>
        </label>
      )}
      {node.type === 'memory' && (
        <>
          <NumberField
            label={t('agent.editor.field.lookbackDays')}
            value={cfg.lookbackDays as number}
            min={1}
            max={365}
            onChange={(v) => props.onConfig('lookbackDays', v)}
          />
          <NumberField
            label={t('agent.editor.field.maxLessons')}
            value={cfg.maxLessons as number}
            min={1}
            max={10}
            onChange={(v) => props.onConfig('maxLessons', v)}
          />
        </>
      )}
      {node.type === 'evidence' && (
        <>
          <label className="agent-editor-field">
            <span>{t('agent.editor.field.dimension')}</span>
            <select
              value={cfg.dimension as string}
              onChange={(e) => props.onConfig('dimension', e.target.value)}
            >
              {'heat sentiment geopolitics structure'.split(' ').map((d) => (
                <option key={d} value={d}>
                  {t(`agent.editor.dimension.${d}` as 'agent.editor.dimension.heat')}
                </option>
              ))}
            </select>
          </label>
          <NumberField
            label={t('agent.editor.field.topN')}
            value={cfg.topN as number}
            min={1}
            max={50}
            onChange={(v) => props.onConfig('topN', v)}
          />
          <NumberField
            label={t('agent.editor.field.windowDays')}
            value={cfg.windowDays as number}
            min={1}
            max={90}
            onChange={(v) => props.onConfig('windowDays', v)}
          />
        </>
      )}
      {(node.type === 'bull' ||
        node.type === 'bear' ||
        node.type === 'risk_aggressive' ||
        node.type === 'risk_conservative' ||
        node.type === 'risk_neutral') && (
        <NumberField
          label={t('agent.editor.field.maxRounds')}
          value={cfg.maxRounds as number}
          min={1}
          max={3}
          onChange={(v) => props.onConfig('maxRounds', v)}
        />
      )}
      {node.type === 'planner' && (
        <NumberField
          label={t('agent.editor.field.maxTriggers')}
          value={cfg.maxTriggers as number}
          min={1}
          max={6}
          onChange={(v) => props.onConfig('maxTriggers', v)}
        />
      )}
      {(node.type === 'judge' || node.type === 'final') && (
        <div className="agent-editor-readonly">{t('agent.editor.readonlyPrompt')}</div>
      )}
    </div>
  );
}

export default function GraphEditorPanel(props: GraphEditorPanelProps) {
  const { t } = useI18n();
  const draft = props.draft;
  if (!draft) {
    return <div className="agent-editor-panel">{t('common.loading')}</div>;
  }
  const selected = draft.nodes.find((n) => n.id === props.selectedNodeId);
  const setting = <K extends keyof RunSettings>(k: K) => draft.settings[k];

  return (
    <div className="agent-editor-panel" data-testid="agent-editor-panel">
      <div className="agent-editor-head">
        <h3>{t('agent.editor.title')}</h3>
        <span className={`agent-editor-badge ${props.dirty ? 'dirty' : 'clean'}`} data-testid="agent-editor-status" data-dirty={props.dirty ? '1' : '0'}>
          {props.saving
            ? t('agent.editor.saving')
            : props.dirty
              ? t('agent.editor.dirty')
              : t('agent.editor.clean')}
        </span>
      </div>
      <div className="agent-editor-sub">
        {t('agent.editor.version', { version: draft.version })}
        {' · '}
        {props.status === 'draft' ? 'draft' : 'published'}
        {props.dirty && props.activeVersion !== draft.version
          ? ` · ${t('agent.editor.historyVersion', { version: draft.version })}`
          : ''}
      </div>
      {props.notice && <div className="agent-editor-ok">{t('agent.editor.saved', { version: props.notice })}</div>}
      {props.error && <div className="agent-editor-error">{props.error}</div>}
      {props.issues.length > 0 && (
        <div className="agent-editor-issues" data-testid="agent-editor-issues">
          <strong>{t('agent.editor.issues', { count: props.issues.length })}</strong>
          {props.issues.map((issue, i) => (
            <div key={`${issue.code}-${i}`} className="agent-editor-issue" data-testid="agent-editor-issue" data-code={issue.code} data-node-id={issue.nodeId ?? ''} data-edge-id={issue.edgeId ?? ''}>
              <span className="agent-editor-issue-code">{issue.code}</span>
              <span>{issue.message}</span>
              {(issue.nodeId || issue.edgeId) &&
                (issue.nodeId ? (
                  <button
                    type="button"
                    className="agent-editor-locate"
                    data-testid="agent-editor-locate"
                    data-node-id={issue.nodeId}
                    onClick={() => props.onSelectNode(issue.nodeId as string)}
                  >
                    {t('agent.editor.issueAt', {
                      where: t('agent.editor.nodeLoc', { id: issue.nodeId })
                    })}
                  </button>
                ) : (
                  <span className="agent-editor-locate">
                    {t('agent.editor.issueAt', {
                      where: t('agent.editor.edgeLoc', { id: issue.edgeId ?? '' })
                    })}
                  </span>
                ))}
            </div>
          ))}
        </div>
      )}
      {Object.keys(props.nodeErrors).length > 0 && (
        <div className="agent-editor-sub">
          {Object.entries(props.nodeErrors)
            .map(([id, message]) => `${id}: ${message}`)
            .join(' · ')}
        </div>
      )}

      <div className="agent-editor-actions">
        <button type="button" className="agent-btn primary" data-testid="agent-editor-save" disabled={props.saving} onClick={props.onSave}>
          {t('agent.editor.save')}
        </button>
        <button type="button" className="agent-btn" data-testid="agent-editor-delete" onClick={props.onDeleteVersion}>
          {t('agent.editor.delete')}
        </button>
        <button type="button" className="agent-btn" data-testid="agent-editor-restore" onClick={props.onRestoreDefault}>
          {t('agent.editor.restore')}
        </button>
      </div>
      <div className="agent-editor-hint">{t('agent.editor.hint')}</div>
      <div className="agent-editor-hint">{t('agent.editor.connectHint')}</div>

      <div className="agent-editor-add">
        <select
          value=""
          data-testid="agent-editor-add"
          onChange={(e) => {
            if (e.target.value) props.onAddNode(e.target.value as AgentNodeType);
          }}
        >
          <option value="">{t('agent.editor.addType')}</option>
          {NODE_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`agent.editor.type.${type}` as 'agent.editor.type.memory')}
            </option>
          ))}
        </select>
        <span className="agent-editor-hint">{t('agent.editor.addNode')}</span>
      </div>

      <div className="agent-editor-settings">
        <h4>{t('agent.editor.settings')}</h4>
        <div className="agent-editor-grid">
          <NumberField
            label={t('agent.editor.field.maxDebateRounds')}
            value={setting('maxDebateRounds')}
            min={1}
            max={3}
            onChange={(v) => props.onSetting('maxDebateRounds', v)}
          />
          <NumberField
            label={t('agent.editor.field.maxRiskRounds')}
            value={setting('maxRiskRounds')}
            min={1}
            max={3}
            onChange={(v) => props.onSetting('maxRiskRounds', v)}
          />
          <NumberField
            label={t('agent.editor.field.maxToolRounds')}
            value={setting('maxToolRounds')}
            min={0}
            max={10}
            onChange={(v) => props.onSetting('maxToolRounds', v)}
          />
          <NumberField
            label={t('agent.editor.field.recursionLimit')}
            value={setting('recursionLimit')}
            min={1}
            max={300}
            onChange={(v) => props.onSetting('recursionLimit', v)}
          />
          <NumberField
            label={t('agent.editor.field.nodeTimeoutMs')}
            value={setting('nodeTimeoutMs')}
            min={1000}
            max={600000}
            step={1000}
            onChange={(v) => props.onSetting('nodeTimeoutMs', v)}
          />
          <NumberField
            label={t('agent.editor.field.runTimeoutMs')}
            value={setting('runTimeoutMs')}
            min={10000}
            max={3600000}
            step={1000}
            onChange={(v) => props.onSetting('runTimeoutMs', v)}
          />
          <NumberField
            label={t('agent.editor.field.maxCostUsd')}
            value={setting('maxCostUsd')}
            min={0.01}
            max={100}
            step={0.01}
            onChange={(v) => props.onSetting('maxCostUsd', v)}
          />
          <NumberField
            label={t('agent.editor.field.maxNodes')}
            value={setting('maxNodes')}
            min={1}
            max={30}
            onChange={(v) => props.onSetting('maxNodes', v)}
          />
        </div>
      </div>

      {selected ? (
        <NodeInspector
          node={selected}
          issue={props.nodeErrors[selected.id]}
          onLabel={(value) => props.onLabel(selected.id, value)}
          onJoinMode={(value) => props.onJoinMode(selected.id, value)}
          onConfig={(field, value) => props.onConfig(selected.id, field, value)}
        />
      ) : (
        <div className="agent-editor-hint">{t('agent.editor.noSelection')}</div>
      )}
    </div>
  );
}
