import { useEffect, useMemo, useState } from 'react';
import * as echarts from 'echarts';
import { useInvoke } from '../hooks/useInvoke';
import { useI18n } from '../i18n/I18n';
import EChart from './EChart';
import HotBadge from './HotBadge';
import { worldGeo, normalizeCountry, countriesToMapData } from '../world/geo';
import { aggregateRegions, regionOfCountry } from '../world/regions';
import { MARKET_INDEX_SYMBOLS } from '../../shared/stocks';
import type { SourceArticle } from '../../shared/models';
import type { TrendsResult } from '../../shared/trend';
import type { CountryDetail, CountrySeriesResult, WorldTimeline } from '../../shared/world';
import type { StocksView } from '../../shared/stocks';

echarts.registerMap('world', worldGeo as unknown as Parameters<typeof echarts.registerMap>[1]);

export default function WorldTab() {
  const { t } = useI18n();
  const list = useInvoke<TrendsResult>('topics:list');
  const detail = useInvoke<CountryDetail>('countries:detail');
  const series = useInvoke<CountrySeriesResult>('countries:series');
  const timeline = useInvoke<WorldTimeline>('world:timeline');
  const market = useInvoke<StocksView>('stocks:list');
  const [selected, setSelected] = useState<string[]>([]);
  const [detailName, setDetailName] = useState<string | null>(null);
  const [replay, setReplay] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [replayIdx, setReplayIdx] = useState(0);
  const [dim, setDim] = useState<'country' | 'region'>('country');

  useEffect(() => {
    void list.run();
    void timeline.run({ days: 14 });
    void market.run();
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
  const regionHeat = aggregateRegions(shownCountries);
  const regionTotal = new Map(regionHeat.map((r) => [r.key, r.count]));
  const mapData =
    dim === 'region'
      ? countriesToMapData(shownCountries).map((d) => ({
          name: d.name,
          value: regionTotal.get(regionOfCountry(d.name)) ?? 0
        }))
      : countriesToMapData(shownCountries);
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
        <h3>{t('world.market.title')}</h3>
        {market.data?.quotes.length ? (
          <div className="chips" style={{ marginTop: 8 }}>
            {MARKET_INDEX_SYMBOLS.map((sym) => {
              const q = market.data!.quotes.find((x) => x.symbol === sym);
              if (!q) return null;
              const pct = q.changePct;
              const cls = pct === 0 ? '' : pct > 0 ? 'gain' : 'loss';
              return (
                <span className="chip" key={sym}>
                  {q.name}
                  <span className={`n ${cls}`}>{pct > 0 ? '+' : ''}{pct.toFixed(2)}%</span>
                </span>
              );
            })}
          </div>
        ) : (
          <p className="muted">{t('world.market.empty')}</p>
        )}
      </div>

      <div className="card">
        <h3>{t('world.map')}</h3>
        <div className="chips" style={{ marginTop: 4, marginBottom: 10 }}>
          <button
            className={`chip pick${dim === 'country' ? ' on' : ''}`}
            onClick={() => setDim('country')}
          >
            {t('world.dim.country')}
          </button>
          <button
            className={`chip pick${dim === 'region' ? ' on' : ''}`}
            onClick={() => setDim('region')}
          >
            {t('world.dim.region')}
          </button>
        </div>
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
        ) : dim === 'region' ? (
          <>
            <h3>{t('world.regions')}</h3>
            <div className="chips" style={{ marginTop: 8 }}>
              {regionHeat.map((r) => (
                <span className="chip" key={r.key}>
                  {t(`world.region.${r.key}`)}
                  <span className="n">{r.count}</span>
                </span>
              ))}
            </div>
            <p className="muted" style={{ marginTop: 10 }}>{t('world.region.hint')}</p>
          </>
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
        <>
          <CountryHotWidget entity={detailName} />
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
        </>
      )}
    </section>
  );
}

const COUNTRY_HOT_LIMIT = 5;

function CountryHotWidget({ entity }: { entity: string }) {
  const { t } = useI18n();
  const { data, run } = useInvoke<SourceArticle[]>('articles:byHot');
  const max = useMemo(
    () => data?.reduce((m, a) => Math.max(m, a.hotScore ?? 0), 0) ?? 0,
    [data]
  );

  useEffect(() => {
    void run({ window: '24h', countryEntity: entity, limit: COUNTRY_HOT_LIMIT });
  }, [entity]);

  if (!data || data.length === 0) return null;

  return (
    <div className="card country-hot-widget">
      <h3>{t('hot.countryHot')}</h3>
      <ul className="hot-list">
        {data.map((a) => (
          <li key={a.rawHash} className="hot-row">
            <a href={a.url} target="_blank" rel="noreferrer">{a.title}</a>
            <span className="muted">{a.source}</span>
            <HotBadge score={a.hotScore ?? null} style="B" max={max} />
          </li>
        ))}
      </ul>
    </div>
  );
}
