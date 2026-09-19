import { useEffect, useState } from 'react';
import { useInvoke } from '../hooks/useInvoke';
import { useI18n } from '../i18n/I18n';
import EChart from './EChart';
import HotBadge from './HotBadge';
import { useHotStyle } from '../hooks/useHotStyle';
import { buildOverlaySeries } from '../stocks/overlay';
import { MARKET_INDEX_SYMBOLS } from '../../shared/stocks';
import type { TrendsResult } from '../../shared/trend';
import type { StocksView, StockHistoryResult } from '../../shared/stocks';
import type { HotWindow } from '../../shared/contracts';
import type { SourceArticle } from '../../shared/models';

export default function TrendsTab() {
  const { t } = useI18n();
  const { data, run } = useInvoke<TrendsResult>('topics:list');
  const market = useInvoke<StocksView>('stocks:list');
  const hist = useInvoke<StockHistoryResult>('stocks:history');
  const [indexSymbol, setIndexSymbol] = useState<string>(MARKET_INDEX_SYMBOLS[0]);
  type SortMode = 'time' | 'hot';
  const [sortMode, setSortMode] = useState<SortMode>('time');
  const [hotWindow, setHotWindow] = useState<HotWindow>('24h');
  const [hotStyle, setHotStyle] = useHotStyle();
  const hotArticles = useInvoke<SourceArticle[]>('articles:byHot');

  useEffect(() => {
    void run();
    void market.run();
  }, []);

  useEffect(() => {
    void hist.run({ symbol: indexSymbol, period: 'day' });
  }, [indexSymbol]);

  useEffect(() => {
    if (sortMode === 'hot') {
      void hotArticles.run({ window: hotWindow, limit: 50 });
    }
  }, [sortMode, hotWindow]);

  const indexName =
    market.data?.quotes.find((q) => q.symbol === indexSymbol)?.name ?? indexSymbol;
  const topTopic = data?.trends[0];
  const overlay = topTopic ? buildOverlaySeries(topTopic.buckets, hist.data?.points ?? []) : null;

  return (
    <section>
      <div className="card">
        <h2>{t('trends.title')}</h2>
        <p className="muted">{t('trends.hint')}</p>
        <div className="toolbar">
          <button className="btn primary" onClick={() => void run()}>{t('common.refresh')}</button>
          <span className="muted">{t('trends.market.hint')}</span>
        </div>
        <div className="trends-hot-controls">
          <div className="seg-group">
            <button className={`seg${sortMode === 'time' ? ' on' : ''}`} onClick={() => setSortMode('time')}>{t('hot.sortByTime')}</button>
            <button className={`seg${sortMode === 'hot' ? ' on' : ''}`} onClick={() => setSortMode('hot')}>{t('hot.sortByHot')}</button>
          </div>
          {sortMode === 'hot' && (
            <>
              <div className="seg-group">
                {(['24h','7d','30d','all'] as const).map((w) => (
                  <button key={w} className={`seg${hotWindow === w ? ' on' : ''}`} onClick={() => setHotWindow(w)}>{t(w === 'all' ? 'hot.winAll' : `hot.win${w}`)}</button>
                ))}
              </div>
              <div className="seg-group">
                {(['A','B','C','D'] as const).map((s) => (
                  <button key={s} className={`seg style-${s.toLowerCase()}${hotStyle === s ? ' on' : ''}`} onClick={() => setHotStyle(s)}>{s}</button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="chips" style={{ marginTop: 4 }}>
          {MARKET_INDEX_SYMBOLS.map((sym) => {
            const q = market.data?.quotes.find((x) => x.symbol === sym);
            const pct = q?.changePct ?? 0;
            const cls = q ? (pct === 0 ? '' : pct > 0 ? 'gain' : 'loss') : '';
            return (
              <button
                key={sym}
                className={`chip pick${indexSymbol === sym ? ' on' : ''}`}
                onClick={() => setIndexSymbol(sym)}
              >
                {q?.name ?? sym}
                {q ? <span className={`n ${cls}`}>{pct > 0 ? '+' : ''}{pct.toFixed(2)}%</span> : null}
              </button>
            );
          })}
        </div>
      </div>

      {sortMode === 'hot' ? (
        <div className="card">
          <h3>{t('hot.todayHot')}</h3>
          <HotList articles={hotArticles.data ?? []} style={hotStyle} />
        </div>
      ) : (
        <>
          <div className="card">
            {data ? (
              <div className="chart-box">
                <EChart
                  height={360}
                  deps={[data, t]}
                  buildOption={() => {
                    const top = data.trends.slice(0, 5);
                    const x = top[0]?.buckets.map((b) => b.bucketStart.slice(5, 16)) ?? [];
                    return {
                      tooltip: { trigger: 'axis' },
                      legend: { data: top.map((tp) => tp.name), textStyle: { color: '#9aa4b2' } },
                      xAxis: { type: 'category', data: x, axisLabel: { color: '#9aa4b2' } },
                      yAxis: { type: 'value', axisLabel: { color: '#9aa4b2' }, splitLine: { lineStyle: { color: '#30363d' } } },
                      series: top.map((tp) => ({
                        name: tp.name,
                        type: 'line',
                        smooth: true,
                        data: tp.buckets.map((b) => b.count)
                      }))
                    };
                  }}
                />
              </div>
            ) : (
              <p className="muted">{t('trends.loading')}</p>
            )}
          </div>

          <div className="card">
            <h3>{t('trends.market.title')}</h3>
            {data && overlay ? (
              <div className="chart-box">
                <EChart
                  height={360}
                  deps={[overlay, hist.data, topTopic, indexName, t]}
                  buildOption={() => {
                    const topic = topTopic!;
                    const over = overlay!;
                    return {
                      tooltip: { trigger: 'axis' },
                      legend: { data: [topic.name, indexName], textStyle: { color: '#9aa4b2' } },
                      xAxis: { type: 'category', data: over.x, axisLabel: { color: '#9aa4b2' } },
                      yAxis: [
                        {
                          type: 'value',
                          name: topic.name,
                          axisLabel: { color: '#9aa4b2' },
                          splitLine: { lineStyle: { color: '#30363d' } }
                        },
                        {
                          type: 'value',
                          name: indexName,
                          scale: true,
                          axisLabel: { color: '#9aa4b2' },
                          splitLine: { show: false }
                        }
                      ],
                      series: [
                        {
                          name: topic.name,
                          type: 'line',
                          smooth: true,
                          data: over.topic,
                          itemStyle: { color: '#3fb950' }
                        },
                        {
                          name: indexName,
                          type: 'line',
                          smooth: true,
                          connectNulls: false,
                          data: over.close,
                          yAxisIndex: 1,
                          itemStyle: { color: '#f0a04b' }
                        }
                      ]
                    };
                  }}
                />
              </div>
            ) : (
              <p className="muted">{t('trends.market.noData')}</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function HotList({ articles, style }: { articles: SourceArticle[]; style: 'A' | 'B' | 'C' | 'D' }) {
  const max = articles.reduce((m, a) => Math.max(m, a.hotScore ?? 0), 0);
  if (articles.length === 0) return <p className="muted">—</p>;
  return (
    <ul className="hot-list">
      {articles.map((a) => (
        <li key={a.rawHash} className="hot-row">
          <a href={a.url} target="_blank" rel="noreferrer">{a.title}</a>
          <span className="muted">{a.source}</span>
          <HotBadge score={a.hotScore ?? null} style={style} max={max} />
        </li>
      ))}
    </ul>
  );
}
