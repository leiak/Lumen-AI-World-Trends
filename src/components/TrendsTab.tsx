import { useEffect, useState } from 'react';
import { useInvoke } from '../hooks/useInvoke';
import { useI18n } from '../i18n/I18n';
import EChart from './EChart';
import { buildOverlaySeries } from '../stocks/overlay';
import { MARKET_INDEX_SYMBOLS } from '../../shared/stocks';
import type { TrendsResult } from '../../shared/trend';
import type { StocksView, StockHistoryResult } from '../../shared/stocks';

export default function TrendsTab() {
  const { t } = useI18n();
  const { data, run } = useInvoke<TrendsResult>('topics:list');
  const market = useInvoke<StocksView>('stocks:list');
  const hist = useInvoke<StockHistoryResult>('stocks:history');
  const [indexSymbol, setIndexSymbol] = useState<string>(MARKET_INDEX_SYMBOLS[0]);

  useEffect(() => {
    void run();
    void market.run();
  }, []);

  useEffect(() => {
    void hist.run({ symbol: indexSymbol, period: 'day' });
  }, [indexSymbol]);

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
    </section>
  );
}
