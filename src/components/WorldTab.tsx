import { useEffect, useState } from 'react';
import * as echarts from 'echarts';
import { useInvoke } from '../hooks/useInvoke';
import { useI18n } from '../i18n/I18n';
import EChart from './EChart';
import { worldGeo, normalizeCountry, countriesToMapData } from '../world/geo';
import type { TrendsResult } from '../../shared/trend';
import type { CountryDetail, CountrySeriesResult, WorldTimeline } from '../../shared/world';

echarts.registerMap('world', worldGeo as unknown as Parameters<typeof echarts.registerMap>[1]);

export default function WorldTab() {
  const { t } = useI18n();
  const list = useInvoke<TrendsResult>('topics:list');
  const detail = useInvoke<CountryDetail>('countries:detail');
  const series = useInvoke<CountrySeriesResult>('countries:series');
  const timeline = useInvoke<WorldTimeline>('world:timeline');
  const [selected, setSelected] = useState<string[]>([]);
  const [detailName, setDetailName] = useState<string | null>(null);
  const [replay, setReplay] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [replayIdx, setReplayIdx] = useState(0);

  useEffect(() => {
    void list.run();
    void timeline.run({ days: 14 });
  }, []);

  useEffect(() => {
    if (detailName) void detail.run({ name: detailName });
  }, [detailName]);

  useEffect(() => {
    if (selected.length >= 2) void series.run({ names: selected });
  }, [selected]);

  useEffect(() => {
    if (!playing || !timeline.data?.dates.length) return;
    const timer = setInterval(() => {
      setReplayIdx((i) => (i + 1) % (timeline.data?.dates.length ?? 1));
    }, 1200);
    return () => clearInterval(timer);
  }, [playing, timeline.data]);

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

  function exitReplay() {
    setReplay(false);
    setPlaying(false);
    setReplayIdx(0);
  }

  function enterReplay() {
    if (!timeline.data?.dates.length) return;
    setReplay(true);
    setPlaying(true);
  }

  function togglePlay() {
    setPlaying((p) => !p);
  }

  function onReplaySlider(e: React.ChangeEvent<HTMLInputElement>) {
    setReplayIdx(Number(e.target.value));
    setPlaying(false);
  }

  const countries = list.data?.countries ?? [];
  const timelineDates = timeline.data?.dates ?? [];
  const replayActive = replay && Boolean(timeline.data) && timelineDates.length > 0;
  const shownCountries =
    replayActive && timeline.data
      ? (timeline.data.byDate[replayIdx]?.countries ?? [])
      : countries.map((c) => ({ name: c.name, count: c.count }));
  const mapData = countriesToMapData(shownCountries);
  const mapMax = Math.max(1, ...mapData.map((d) => d.value));

  function onMapClick(params: unknown) {
    const name = (params as { name?: string }).name;
    if (!name) return;
    const canonical = countries.find((c) => normalizeCountry(c.name) === name)?.name ?? name;
    toggleCountry(canonical);
  }

  return (
    <section>
      <div className="card">
        <h2>{t('world.title')}</h2>
        <p className="muted">{t('world.hint')}</p>
        <button className="btn primary" onClick={() => void list.run()}>{t('common.refresh')}</button>
      </div>

      <div className="card">
        <h3>{t('world.map')}</h3>
        <div className="player">
          <div className="chips">
            <button className={`chip pick${!replay ? ' on' : ''}`} onClick={exitReplay}>
              {t('world.pb.total')}
            </button>
            <button className={`chip pick${replay ? ' on' : ''}`} onClick={enterReplay}>
              {t('world.pb.replay')}
            </button>
          </div>
          {replay && (
            <div className="player-bar">
              {replayActive ? (
                <>
                  <button className="btn primary" onClick={togglePlay}>
                    {playing ? t('world.pb.pause') : t('world.pb.play')}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, timelineDates.length - 1)}
                    value={replayIdx}
                    onChange={onReplaySlider}
                    aria-label={t('world.pb.date')}
                  />
                  <span className="muted">{timelineDates[replayIdx]}</span>
                </>
              ) : (
                <span className="muted">
                  {timeline.loading ? t('world.loading') : t('world.pb.noData')}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="chart-box tall">
          <EChart
            height={420}
            deps={[list.data?.countries, timeline.data, replay, replayIdx, t]}
            onClick={onMapClick}
            buildOption={() => ({
              tooltip: { trigger: 'item' },
              visualMap: {
                min: 0,
                max: mapMax,
                calculable: true,
                left: 16,
                bottom: 16,
                textStyle: { color: '#9aa4b2' },
                inRange: { color: ['#161b22', '#3fb950', '#f0a04b', '#e0553a'] }
              },
              series: [
                {
                  type: 'map',
                  map: 'world',
                  roam: true,
                  label: { show: false },
                  itemStyle: { areaColor: '#1b232c', borderColor: '#30363d' },
                  emphasis: {
                    label: { show: true, color: '#fff' },
                    itemStyle: { areaColor: '#f0a04b' }
                  },
                  data: mapData
                }
              ]
            })}
          />
        </div>
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
