import { useEffect, useState } from 'react';
import { useInvoke } from '../hooks/useInvoke';
import { useI18n } from '../i18n/I18n';
import EChart from './EChart';
import type { TrendsResult } from '../../shared/trend';
import type { CountryDetail, CountrySeriesResult } from '../../shared/world';

export default function WorldTab() {
  const { t } = useI18n();
  const list = useInvoke<TrendsResult>('topics:list');
  const detail = useInvoke<CountryDetail>('countries:detail');
  const series = useInvoke<CountrySeriesResult>('countries:series');
  const [selected, setSelected] = useState<string[]>([]);
  const [detailName, setDetailName] = useState<string | null>(null);

  useEffect(() => {
    void list.run();
  }, []);

  useEffect(() => {
    if (detailName) void detail.run({ name: detailName });
  }, [detailName]);

  useEffect(() => {
    if (selected.length >= 2) void series.run({ names: selected });
  }, [selected]);

  function toggleCountry(name: string) {
    setDetailName(name);
    setSelected((prev) =>
      prev.includes(name)
        ? prev.filter((n) => n !== name)
        : prev.length >= 4
          ? prev
          : [...prev, name]
    );
  }

  const countries = list.data?.countries ?? [];

  return (
    <section>
      <div className="card">
        <h2>{t('world.title')}</h2>
        <p className="muted">{t('world.hint')}</p>
        <button className="btn primary" onClick={() => void list.run()}>{t('common.refresh')}</button>
      </div>

      <div className="card">
        {countries.length === 0 ? (
          <p className="muted">{list.data ? t('world.empty') : t('world.loading')}</p>
        ) : (
          <>
            <h3>{t('world.title')} (Top {countries.length})</h3>
            <div className="chips" style={{ marginTop: 8 }}>
              {countries.slice(0, 15).map((c) => (
                <button
                  key={c.name}
                  className={`chip pick${selected.includes(c.name) ? ' on' : ''}`}
                  onClick={() => toggleCountry(c.name)}
                >
                  {c.name}
                  <span className="n">{c.count}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h3>{t('world.compare')}</h3>
        {selected.length < 2 ? (
          <p className="muted">{t('world.selectCompare')}</p>
        ) : (
          <div className="chart-box">
            <EChart
              height={300}
              deps={[series.data, selected, t]}
              buildOption={() => {
                const sers = series.data?.series ?? [];
                const x = sers[0]?.points.map((p) => p.bucketStart.slice(5, 16)) ?? [];
                return {
                  tooltip: { trigger: 'axis' },
                  legend: { data: sers.map((s) => s.name), textStyle: { color: '#9aa4b2' } },
                  xAxis: { type: 'category', data: x, axisLabel: { color: '#9aa4b2' } },
                  yAxis: { type: 'value', axisLabel: { color: '#9aa4b2' }, splitLine: { lineStyle: { color: '#30363d' } } },
                  series: sers.map((s) => ({
                    name: s.name,
                    type: 'line',
                    smooth: true,
                    data: s.points.map((p) => p.count)
                  }))
                };
              }}
            />
          </div>
        )}
      </div>

      {detailName && (
        <div className="card">
          <h3>{t('world.detail')}: {detailName}</h3>
          {detail.loading ? (
            <p className="muted">{t('common.loading')}</p>
          ) : detail.data ? (
            <>
              <div className="stat-grid" style={{ marginBottom: 12 }}>
                <div className="stat">
                  <div className="stat-num">{detail.data.count}</div>
                  <div className="stat-label">{t('dash.metric.articles')}</div>
                </div>
              </div>
              <div className="stat-label" style={{ marginBottom: 8 }}>{t('world.topics')}</div>
              {detail.data.topics.length === 0 ? (
                <p className="muted">{t('world.noRelated')}</p>
              ) : (
                <div className="chips">
                  {detail.data.topics.map((tp) => (
                    <span className="chip" key={tp.name}>
                      {tp.name}
                      <span className="n">{tp.count}</span>
                      <span className={tp.rising ? 'up' : 'down'}>{tp.rising ? '▲' : '▼'}</span>
                    </span>
                  ))}
                </div>
              )}
              <div className="stat-label" style={{ margin: '12px 0 8px' }}>{t('world.articles')}</div>
              <ul className="article-list">
                {detail.data.articles.slice(0, 10).map((a) => (
                  <li key={a.id}>
                    <a href={a.url} target="_blank" rel="noreferrer">
                      {a.title} <span className="muted">— {a.source}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="muted">{t('world.noRelated')}</p>
          )}
        </div>
      )}
    </section>
  );
}