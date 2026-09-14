import { useEffect, useState } from 'react';
import { useInvoke } from '../hooks/useInvoke';
import { useI18n } from '../i18n/I18n';
import type { Insight } from '../../shared/insight';

export default function InsightsTab() {
  const { t } = useI18n();
  const list = useInvoke<Insight[]>('insights:list');
  const gen = useInvoke<Insight>('insights:generate');
  const weekly = useInvoke<Insight>('insights:weekly');
  const [selected, setSelected] = useState<Insight | null>(null);
  const [live, setLive] = useState<Insight | null>(null);

  useEffect(() => {
    void list.run({ limit: 50 });
  }, []);

  async function handleGen(kind: 'causal' | 'weekly') {
    const run = kind === 'causal' ? gen : weekly;
    await run.run();
    if (run.data) setLive(run.data);
    void list.run({ limit: 50 });
  }

  const current = selected ?? live;
  const typeLabel = (type: string) =>
    type === 'weekly' ? t('insights.type.weekly') : t('insights.type.causal');

  return (
    <section>
      <div className="card">
        <h2>{t('insights.title')}</h2>
        <p className="muted">{t('insights.hint')}</p>
        <button className="btn primary" onClick={() => void handleGen('causal')} disabled={gen.loading}>
          {gen.loading ? t('insights.generating') : t('insights.genCausal')}
        </button>
        <button className="btn" onClick={() => void handleGen('weekly')} disabled={weekly.loading}>
          {weekly.loading ? t('insights.generating') : t('insights.genWeekly')}
        </button>
        {(gen.error || weekly.error) && <p className="err">{t('insights.failed')}: {gen.error ?? weekly.error}</p>}
      </div>

      <div className="card">
        <h2>{current ? `${typeLabel(current.type)} · ${current.title}` : t('insights.recent')}</h2>
        {current ? (
          <>
            <div className="muted" style={{ marginBottom: 8 }}>
              {current.generatedAt.slice(0, 19).replace('T', ' ')} · {t('insights.model')} {current.model}
            </div>
            <div className="mono">{current.content}</div>
          </>
        ) : (
          <p className="muted">{t('insights.empty')}</p>
        )}
      </div>

      <div className="card">
        <h2>{t('insights.history')}</h2>
        {(list.data?.length ?? 0) === 0 ? (
          <p className="muted">{list.loading ? t('insights.loadingHistory') : t('insights.historyEmpty')}</p>
        ) : (
          <ul className="insight-list">
            {(list.data ?? []).map((ins) => (
              <li key={ins.id} className="insight-item" onClick={() => setSelected(ins)}>
                <span className={`tag tag-${ins.type}`}>{typeLabel(ins.type)}</span>
                <span className="insight-title">{ins.title}</span>
                <span className="muted">
                  {ins.generatedAt.slice(0, 16).replace('T', ' ')} · {ins.model}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}