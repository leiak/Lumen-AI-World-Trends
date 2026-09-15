import { useEffect, useState } from 'react';
import { useEngineStatus } from '../hooks/useEngineStatus';
import { useInvoke } from '../hooks/useInvoke';
import { useI18n } from '../i18n/I18n';
import type { DashboardSnapshot } from '../../shared/dashboard';
import type { SettingsView } from '../../shared/settings';
import type { I18nKey } from '../i18n/dict';

const METRICS: { key: keyof DashboardSnapshot['metrics']; labelKey: I18nKey }[] = [
  { key: 'articles', labelKey: 'dash.metric.articles' },
  { key: 'entities', labelKey: 'dash.metric.entities' },
  { key: 'events', labelKey: 'dash.metric.events' },
  { key: 'edges', labelKey: 'dash.metric.edges' },
  { key: 'addedToday', labelKey: 'dash.metric.addedToday' }
];

export default function DashboardTab() {
  const { t } = useI18n();
  const { status, error } = useEngineStatus();
  const dash = useInvoke<DashboardSnapshot>('dashboard:today');
  const crawl = useInvoke<{ fetched?: number; addedNew?: number }>('collector:manualRun');
  const graph = useInvoke<{ articles?: number; entities?: number; events?: number; edges?: number }>('graph:build');
  const settings = useInvoke<SettingsView>('settings:get');
  const settingsSave = useInvoke<SettingsView>('settings:update');

  const [selSources, setSelSources] = useState<string[]>([]);
  const [autoOn, setAutoOn] = useState(true);
  const [intervalText, setIntervalText] = useState('30');
  const [settingsNote, setSettingsNote] = useState<{ text: string; isError: boolean } | null>(null);

  useEffect(() => {
    void dash.run();
    void settings.run();
  }, []);

  useEffect(() => {
    if (!settings.data) return;
    const s = settings.data.settings;
    setSelSources(
      s.enabledSources.length === 0
        ? settings.data.allSources.map((x) => x.id)
        : s.enabledSources
    );
    setAutoOn(s.autoEnabled);
    setIntervalText(String(s.intervalMinutes));
  }, [settings.data]);

  const snap = dash.data;

  function toggleSource(id: string) {
    setSelSources((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  async function handleSaveSettings() {
    const res = await settingsSave.run({
      enabledSources: selSources,
      autoEnabled: autoOn,
      intervalMinutes: Number(intervalText) || 30
    });
    setSettingsNote(
      res?.ok
        ? { text: t('dash.settings.saved'), isError: false }
        : { text: res?.error ?? t('common.error'), isError: true }
    );
  }

  return (
    <section>
      <div className="card">
        <h2>{t('dash.title')}</h2>
        {snap ? (
          <>
            <div className="stat-grid">
              {METRICS.map((m) => (
                <div className="stat" key={m.key}>
                  <div className="stat-num">{snap.metrics[m.key]}</div>
                  <div className="stat-label">{t(m.labelKey)}</div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 12 }}>
              <div className="stat-label" style={{ marginBottom: 8 }}>{t('dash.topTopics')}</div>
              {snap.topTopics.length === 0 ? (
                <span className="muted">{t('dash.noTopics')}</span>
              ) : (
                <div className="chips">
                  {snap.topTopics.map((tp) => (
                    <span className="chip" key={tp.name}>
                      {tp.name}
                      <span className="n">{tp.count}</span>
                      <span className={tp.rising ? 'up' : 'down'}>{tp.rising ? '▲' : '▼'}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <p className="muted">{t('dash.loading')}</p>
        )}
      </div>

      <div className="card">
        <h2>{t('dash.engine')}</h2>
        <pre className="mono">
          {status
            ? `ready: ${status.ready}\ndbPath: ${status.dbPath}\nsources: ${status.sources.join(', ')}\n${t('dash.autoInterval', { m: snap?.autoIntervalMinutes ?? '?' })}\n${t('dash.lastAuto')}: ${snap?.lastAutoRunAt ? snap.lastAutoRunAt.slice(0, 19).replace('T', ' ') : t('dash.notRun')}\n${t('dash.lastCrawl')}: ${snap?.lastCrawlAt ? snap.lastCrawlAt.slice(0, 19).replace('T', ' ') : t('dash.none')}`
            : error
              ? `${t('common.error')}: ${error}`
              : t('common.loading')}
        </pre>
      </div>

      <div className="card">
        <h2>{t('dash.settings.title')}</h2>
        <p className="muted">{t('dash.settings.hint')}</p>
        <div className="settings-grid">
          <div className="settings-row">
            <span className="stat-label">{t('dash.settings.auto')}</span>
            <button className={autoOn ? 'btn toggle-btn on' : 'btn toggle-btn'} onClick={() => setAutoOn(!autoOn)}>
              {autoOn ? t('common.on') : t('common.off')}
            </button>
            <span className="stat-label" style={{ marginLeft: 12 }}>{t('dash.settings.interval')}</span>
            <input
              className="input settings-num"
              type="number"
              min={1}
              max={720}
              value={intervalText}
              onChange={(e) => setIntervalText(e.target.value)}
            />
          </div>
          <div className="settings-row">
            <span className="stat-label">{t('dash.settings.sources')}</span>
          </div>
          <div className="chips">
            {(settings.data?.allSources ?? []).map((s) => (
              <label key={s.id} className={`chip pick source-check${selSources.includes(s.id) ? ' on' : ''}`}>
                <input
                  type="checkbox"
                  checked={selSources.includes(s.id)}
                  onChange={() => toggleSource(s.id)}
                  style={{ marginRight: 4 }}
                />
                {s.name}
                <span className="n">{s.lang === 'zh' ? '中文' : 'EN'}</span>
              </label>
            ))}
          </div>
          <div className="settings-row" style={{ marginTop: 12 }}>
            <button
              className="btn primary"
              onClick={() => void handleSaveSettings()}
              disabled={settingsSave.loading || selSources.length === 0}
            >
              {settingsSave.loading ? t('common.loading') : t('dash.settings.save')}
            </button>
            {selSources.length === 0 && <span className="err">{t('dash.settings.minOne')}</span>}
            {settingsNote && <span className={settingsNote.isError ? 'err' : 'ok'}>{settingsNote.text}</span>}
          </div>
        </div>
      </div>

      <div className="card">
        <h2>{t('dash.ops')}</h2>
        <button className="btn" onClick={() => void crawl.run()} disabled={crawl.loading}>{t('dash.crawl')}</button>
        <button className="btn primary" onClick={() => void graph.run()} disabled={graph.loading}>{t('dash.build')}</button>

        {(crawl.data || crawl.error) && (
          <p className={crawl.error ? 'err' : 'ok'}>
            {crawl.error ? `${t('common.error')}: ${crawl.error}` : t('dash.crawlOk', { a: crawl.data?.fetched ?? 0, b: crawl.data?.addedNew ?? 0 })}
          </p>
        )}
        {(graph.data || graph.error) && (
          <p className={graph.error ? 'err' : 'ok'}>
            {graph.error ? `${t('common.error')}: ${graph.error}` : t('dash.buildOk', { a: graph.data?.articles ?? 0, b: graph.data?.entities ?? 0, c: graph.data?.events ?? 0, d: graph.data?.edges ?? 0 })}
          </p>
        )}
        {snap && (
          <div className="muted" style={{ marginTop: 8 }}>{t('dash.insightHint')}</div>
        )}
      </div>
    </section>
  );
}