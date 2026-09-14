import { useEffect } from 'react';
import { useEngineStatus } from '../hooks/useEngineStatus';
import { useInvoke } from '../hooks/useInvoke';
import { useI18n } from '../i18n/I18n';
import type { DashboardSnapshot } from '../../shared/dashboard';
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

  useEffect(() => {
    void dash.run();
  }, []);

  const snap = dash.data;

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