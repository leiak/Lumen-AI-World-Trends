import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AGENT_PROMPT_ROLES,
  PROMPT_MAX_RENDERED_CHARS,
  PROMPT_MAX_SYSTEM_CHARS,
  PROMPT_PLACEHOLDERS,
  type AgentPromptIssue,
  type AgentPromptPackView,
  type AgentPromptRole,
  type AgentPromptsGetResponse,
  type AgentPromptsSaveResponse
} from '../../../shared/agent';
import { useI18n } from '../../i18n/I18n';
import type { I18nKey } from '../../i18n/dict';

type InvokeResult = {
  ok?: boolean;
  data?: unknown;
  error?: string;
  code?: string;
  message?: string;
  details?: { issues?: AgentPromptIssue[] };
};

function packsEqual(a: Record<AgentPromptRole, string>, b: Record<AgentPromptRole, string>): boolean {
  return AGENT_PROMPT_ROLES.every((role) => a[role] === b[role]);
}

export default function PromptEditorPanel({
  onClose,
  graphId
}: {
  onClose: () => void;
  /** prompt 作用域（必传）：股票页签传 stock-analysis，智能体页签传 trend-analysis。 */
  graphId: string;
}) {
  const { t } = useI18n();
  const [pack, setPack] = useState<AgentPromptPackView>();
  const [drafts, setDrafts] = useState<Record<AgentPromptRole, string>>({} as Record<AgentPromptRole, string>);
  const [activeRole, setActiveRole] = useState<AgentPromptRole>('evidence');
  const [issues, setIssues] = useState<AgentPromptIssue[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const refs = useRef<Partial<Record<AgentPromptRole, HTMLTextAreaElement | null>>>({});

  const load = useCallback(async () => {
    const res = (await window.lumen.invoke('agent:prompts:get', { graphId })) as InvokeResult | undefined;
    if (!res?.ok || !res.data) {
      setError(res?.message ?? res?.error ?? 'load failed');
      return;
    }
    const data = res.data as AgentPromptsGetResponse;
    setPack(data.pack);
    setDrafts({ ...data.pack.defaults, ...data.pack.prompts });
    setError('');
  }, [graphId]);

  useEffect(() => {
    void load();
  }, [load]);

  const effective = useMemo(() => {
    if (!pack) return drafts;
    return { ...pack.defaults, ...pack.prompts } as Record<AgentPromptRole, string>;
  }, [pack, drafts]);

  const dirty = useMemo(() => !packsEqual(drafts, effective), [drafts, effective]);
  const activeIssues = issues.filter((i) => i.role === activeRole);
  const activeText = drafts[activeRole] ?? '';

  const update = (role: AgentPromptRole, value: string) => {
    setDrafts((prev) => ({ ...prev, [role]: value }));
    setNotice('');
  };

  const save = async () => {
    setSaving(true);
    setError('');
    setIssues([]);
    try {
      const res = (await window.lumen.invoke('agent:prompts:save', {
        graphId,
        prompts: drafts
      })) as InvokeResult | undefined;
      if (!res?.ok || !res.data) {
        setIssues(res?.details?.issues ?? []);
        setError(res?.message ?? res?.error ?? t('agent.prompt.saveFail'));
        return;
      }
      const data = res.data as AgentPromptsSaveResponse;
      setPack(data.pack);
      setDrafts({ ...data.pack.defaults, ...data.pack.prompts });
      setNotice(t('agent.prompt.saved', { version: data.pack.version }));
    } finally {
      setSaving(false);
    }
  };

  const restoreRole = (role: AgentPromptRole) => {
    if (!pack) return;
    update(role, pack.defaults[role]);
  };

  const restoreAll = () => {
    if (!pack) return;
    setDrafts({ ...pack.defaults });
    setNotice('');
  };

  const locate = (issue: AgentPromptIssue) => {
    setActiveRole(issue.role);
    const el = refs.current[issue.role];
    if (el) {
      el.focus();
      const offset = Math.min(Math.max(0, issue.offset ?? 0), el.value.length);
      el.setSelectionRange(offset, offset);
    }
  };

  const close = () => {
    if (dirty && !window.confirm(t('agent.prompt.confirmDiscard'))) return;
    onClose();
  };

  return (
    <div
      className="card agent-prompt-card"
      data-testid="agent-prompt-editor"
      data-graph-id={graphId}
    >
      <div className="agent-editor-head">
        <h3>{t('agent.prompt.title')}</h3>
        <div className="agent-editor-actions">
          {pack ? (
            <span className="muted" data-testid="agent-prompt-version" data-version={pack.version} data-digest={pack.digest}>
              {t('agent.prompt.version', { version: pack.version })}
              {' · '}
              {pack.digest.slice(0, 10)}
              {' · '}
              {pack.isDefault ? t('agent.prompt.noOverride') : t('agent.prompt.hasOverride')}
            </span>
          ) : null}
          <span
            className={`agent-editor-save-state${dirty ? ' dirty' : ''}`}
            data-testid="agent-prompt-dirty"
            data-dirty={dirty ? '1' : '0'}
          >
            {dirty ? t('agent.prompt.dirty') : t('agent.prompt.clean')}
          </span>
          <button className="btn primary" data-testid="agent-prompt-save" onClick={() => void save()} disabled={saving || !dirty}>
            {saving ? t('agent.prompt.saving') : t('agent.prompt.save')}
          </button>
          <button className="btn" data-testid="agent-prompt-restore-all" onClick={restoreAll} disabled={!pack}>
            {t('agent.prompt.restoreAll')}
          </button>
          <button className="btn" data-testid="agent-prompt-close" onClick={close}>
            {t('agent.prompt.close')}
          </button>
        </div>
      </div>

      <p className="agent-prompt-risk" data-testid="agent-prompt-risk">{t('agent.prompt.risk')}</p>
      <p className="muted">
        {t('agent.prompt.limits', {
          system: PROMPT_MAX_SYSTEM_CHARS,
          rendered: PROMPT_MAX_RENDERED_CHARS
        })}
        {' · '}
        {t('agent.prompt.placeholders', { list: PROMPT_PLACEHOLDERS.join(' ') })}
      </p>

      {error && issues.length === 0 ? (
        <p className="agent-error" data-testid="agent-prompt-error">{error}</p>
      ) : null}

      <div className="agent-prompt-roles" data-testid="agent-prompt-roles">
        {AGENT_PROMPT_ROLES.map((role) => (
          <button
            key={role}
            type="button"
            className={`btn agent-prompt-role${activeRole === role ? ' primary' : ''}`}
            data-testid={`agent-prompt-role-${role}`}
            onClick={() => setActiveRole(role)}
          >
            {t(`agent.prompt.role.${role}` as I18nKey)}
            {pack?.prompts[role] ? <span className="agent-prompt-badge">*</span> : null}
            {issues.some((i) => i.role === role) ? <span className="agent-prompt-badge error">!</span> : null}
          </button>
        ))}
      </div>

      <div className="agent-prompt-editor-body">
        <div className="agent-prompt-editor-label">
          <span>{t(`agent.prompt.role.${activeRole}` as I18nKey)}</span>
          <span className="muted" data-testid="agent-prompt-charcount" data-count={activeText.length}>
            {t('agent.prompt.templateChars', {
              count: activeText.length,
              max: PROMPT_MAX_SYSTEM_CHARS
            })}
          </span>
        </div>
        <textarea
          className="agent-prompt-textarea"
          data-testid={`agent-prompt-textarea-${activeRole}`}
          value={activeText}
          spellCheck={false}
          rows={10}
          ref={(el) => {
            refs.current[activeRole] = el;
          }}
          onChange={(e) => update(activeRole, e.target.value)}
        />
        <div className="agent-editor-actions">
          <button
            className="btn"
            data-testid={`agent-prompt-restore-${activeRole}`}
            onClick={() => restoreRole(activeRole)}
          >
            {t('agent.prompt.restoreRole')}
          </button>
        </div>

        {activeIssues.length > 0 ? (
          <ul className="agent-prompt-issues" data-testid="agent-prompt-issues">
            {activeIssues.map((issue, idx) => (
              <li key={`${issue.role}-${idx}`}>
                <button
                  type="button"
                  className="agent-editor-locate"
                  data-testid="agent-prompt-issue"
                  data-role={issue.role}
                  data-offset={issue.offset ?? 0}
                  onClick={() => locate(issue)}
                >
                  {t('agent.prompt.issueAt', { offset: issue.offset ?? 0 })} · {issue.message}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {notice ? (
          <p className="muted" data-testid="agent-prompt-notice">{notice}</p>
        ) : null}
      </div>
    </div>
  );
}
