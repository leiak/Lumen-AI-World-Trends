import { useEffect, useState } from 'react';
import * as echarts from 'echarts';
import { useInvoke } from '../hooks/useInvoke';
import { useI18n } from '../i18n/I18n';
import EChart from './EChart';
import type { StocksView, StockHistoryResult } from '../../shared/stocks';

function fmtPrice(n: number): string {
  if (n >= 1000) return n.toFixed(0);
  if (n >= 100) return n.toFixed(1);
  if (n >= 10) return n.toFixed(2);
  return n.toFixed(3);
}

function fmtTime(t: string): string {
  if (!t) return '';
  if (t.includes('T')) return new Date(t).toLocaleString();
  if (/^\d{14}$/.test(t)) {
    return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}`;
  }
  return t;
}

export default function StocksTab() {
  const { t } = useI18n();
  const view = useInvoke<StocksView>('stocks:list');
  const refresh = useInvoke<StocksView>('stocks:refresh');
  const hist = useInvoke<StockHistoryResult>('stocks:history');
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    void view.run();
  }, []);

  useEffect(() => {
    if (!view.loading && view.data && view.data.quotes.length === 0 && !view.error) {
      void refresh.run();
    }
  }, [view.loading, view.data, view.error]);

  useEffect(() => {
    if (selected) void hist.run({ symbol: selected });
  }, [selected]);

  const fresh = refresh.data ?? view.data;
  const quotes = fresh?.quotes ?? [];
  const note = fresh?.note;
  const updatedAt = refresh.data?.updatedAt || view.data?.updatedAt || '';

  function onRefresh() {
    void refresh.run();
  }

  function buildKlineOption(): echarts.EChartsOption {
    const pts = hist.data?.points ?? [];
    const dates = pts.map((p) => p.date);
    const ohlc = pts.map((p) => [p.open, p.close, p.low, p.high]);
    const volumes = pts.map((p) => p.volume);
    return {
      animation: false,
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      grid: [
        { left: 64, right: 16, top: 24, height: '58%' },
        { left: 64, right: 16, top: '72%', height: '18%' }
      ],
      xAxis: [
        {
          type: 'category',
          data: dates,
          boundaryGap: true,
          axisLine: { lineStyle: { color: '#30363d' } },
          axisLabel: { color: '#9aa4b2' }
        },
        { type: 'category', gridIndex: 1, data: dates, axisLabel: { show: false } }
      ],
      yAxis: [
        {
          scale: true,
          splitLine: { lineStyle: { color: '#30363d' } },
          axisLabel: { color: '#9aa4b2' }
        },
        {
          gridIndex: 1,
          splitNumber: 2,
          splitLine: { show: false },
          axisLabel: { color: '#9aa4b2' }
        }
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1], start: 55, end: 100 },
        {
          type: 'slider',
          xAxisIndex: [0, 1],
          start: 55,
          end: 100,
          bottom: 2,
          height: 18,
          borderColor: '#30363d',
          textStyle: { color: '#9aa4b2' }
        }
      ],
      series: [
        {
          name: 'K',
          type: 'candlestick',
          data: ohlc,
          barWidth: '70%',
          itemStyle: {
            color: '#e0553a',
            color0: '#3fb950',
            borderColor: '#e0553a',
            borderColor0: '#3fb950'
          }
        },
        {
          name: t('stocks.volume'),
          type: 'bar',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: volumes,
          itemStyle: { color: '#9aa4b2' }
        }
      ]
    };
  }

  return (
    <section>
      <div className="card">
        <h2>{t('stocks.title')}</h2>
        <p className="muted">{t('stocks.hint')}</p>
        <div className="toolbar">
          <button className="btn primary" onClick={onRefresh} disabled={refresh.loading}>
            {refresh.loading ? t('common.loading') : t('stocks.refresh')}
          </button>
          {updatedAt && <span className="muted">{t('stocks.updated', { t: fmtTime(updatedAt) })}</span>}
        </div>
        {note && <p className="muted warn">{t('stocks.offline')}</p>}
        {quotes.length === 0 ? (
          <p className="muted">
            {refresh.error ? refresh.error : refresh.loading ? t('stocks.loading') : t('stocks.empty')}
          </p>
        ) : (
          <table className="stock-table">
            <thead>
              <tr>
                <th>{t('stocks.name')}</th>
                <th>{t('stocks.code')}</th>
                <th>{t('stocks.price')}</th>
                <th>{t('stocks.change')}</th>
                <th>{t('stocks.pct')}</th>
              </tr>
            </thead>
            <tbody>
              {quotes.map((q) => {
                const up = q.change > 0;
                const flat = q.change === 0;
                const cls = up ? 'gain' : flat ? '' : 'loss';
                return (
                  <tr
                    key={q.symbol}
                    className={selected === q.symbol ? 'sel' : ''}
                    onClick={() => setSelected(q.symbol)}
                  >
                    <td>{q.name}</td>
                    <td className="muted">{q.symbol}</td>
                    <td className={cls}>{fmtPrice(q.price)}</td>
                    <td className={cls}>{up ? '+' : ''}{q.change.toFixed(2)}</td>
                    <td className={cls}>{up ? '+' : ''}{q.changePct.toFixed(2)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="muted" style={{ marginTop: 8 }}>{t('stocks.select')}</p>
      </div>

      {selected && (
        <div className="card">
          <h3>{t('stocks.kline')}: {selected}</h3>
          {hist.loading ? (
            <p className="muted">{t('common.loading')}</p>
          ) : hist.error ? (
            <p className="err">{hist.error}</p>
          ) : hist.data?.points.length ? (
            <div className="chart-box tall">
              <EChart height={460} deps={[hist.data, t]} buildOption={buildKlineOption} />
            </div>
          ) : (
            <p className="muted">{t('stocks.empty')}</p>
          )}
        </div>
      )}
    </section>
  );
}
