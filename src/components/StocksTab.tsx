import { useEffect, useState } from 'react';
import * as echarts from 'echarts';
import { useInvoke } from '../hooks/useInvoke';
import { useI18n } from '../i18n/I18n';
import EChart from './EChart';
import type {
  KlinePeriod,
  StocksView,
  StocksWatchView,
  StockHistoryResult
} from '../../shared/stocks';

const PERIODS: KlinePeriod[] = ['day', 'week', 'month'];

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
  const watch = useInvoke<StocksWatchView>('stocks:watch');
  const add = useInvoke<StocksWatchView>('stocks:add');
  const remove = useInvoke<StocksWatchView>('stocks:remove');
  const [selected, setSelected] = useState<string | null>(null);
  const [period, setPeriod] = useState<KlinePeriod>('day');
  const [addInput, setAddInput] = useState('');

  useEffect(() => {
    void view.run();
    void watch.run();
  }, []);

  useEffect(() => {
    if (!view.loading && view.data && view.data.quotes.length === 0 && !view.error) {
      void refresh.run();
    }
  }, [view.loading, view.data, view.error]);

  useEffect(() => {
    const timer = setInterval(() => void view.run(), 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (selected) void hist.run({ symbol: selected, period });
  }, [selected, period]);

  const fresh = refresh.data ?? view.data;
  const quotes = fresh?.quotes ?? [];
  const note = fresh?.note;
  const updatedAt = refresh.data?.updatedAt || view.data?.updatedAt || '';
  const quoteBySymbol = new Map(quotes.map((q) => [q.symbol, q]));
  const watchItems = watch.data?.items ?? [];
  const rows = watchItems.map((w) => ({ ...w, quote: quoteBySymbol.get(w.symbol) }));

  function onRefresh() {
    void refresh.run();
  }

  async function onAdd() {
    const symbol = addInput.trim();
    if (!symbol) return;
    const res = await add.run({ symbol });
    if (res && res.ok) {
      setAddInput('');
      void watch.run();
      void refresh.run();
    }
  }

  async function onRemove(symbol: string) {
    const res = await remove.run({ symbol });
    if (res && res.ok) {
      void watch.run();
      void view.run();
      if (selected === symbol) setSelected(null);
    }
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
        <p className="muted">{t('stocks.auto')}</p>
        {note && <p className="muted warn">{t('stocks.offline')}</p>}

        <div className="watch-add">
          <input
            className="input watch-input"
            value={addInput}
            placeholder={t('stocks.addPlaceholder')}
            onChange={(e) => setAddInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onAdd();
            }}
          />
          <button className="btn" onClick={() => void onAdd()} disabled={add.loading || !addInput.trim()}>
            {t('stocks.add')}
          </button>
          {add.error && <span className="err">{t('stocks.addFail')}</span>}
        </div>
        <p className="muted" style={{ margin: '4px 0 10px' }}>{t('stocks.addHint')}</p>

        {rows.length === 0 ? (
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
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ symbol, name, quote }) => {
                const up = (quote?.change ?? 0) > 0;
                const flat = (quote?.change ?? 0) === 0;
                const cls = up ? 'gain' : flat ? '' : 'loss';
                return (
                  <tr key={symbol} className={selected === symbol ? 'sel' : ''}>
                    <td className="sym-cell" onClick={() => setSelected(symbol)}>
                      {name}
                    </td>
                    <td className="muted sym-cell" onClick={() => setSelected(symbol)}>
                      {symbol}
                    </td>
                    <td className={cls}>{quote ? fmtPrice(quote.price) : '—'}</td>
                    <td className={cls}>{quote ? `${up ? '+' : ''}${quote.change.toFixed(2)}` : '—'}</td>
                    <td className={cls}>{quote ? `${up ? '+' : ''}${quote.changePct.toFixed(2)}%` : '—'}</td>
                    <td>
                      <button
                        className="btn tiny"
                        title={t('stocks.remove')}
                        onClick={() => void onRemove(symbol)}
                      >
                        ✕
                      </button>
                    </td>
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
          <div className="chips" style={{ margin: '4px 0 10px' }}>
            {PERIODS.map((p) => (
              <button
                key={p}
                className={`chip pick${period === p ? ' on' : ''}`}
                onClick={() => setPeriod(p)}
              >
                {t(`stocks.period.${p}`)}
              </button>
            ))}
          </div>
          {hist.loading ? (
            <p className="muted">{t('common.loading')}</p>
          ) : hist.error ? (
            <p className="err">{hist.error}</p>
          ) : hist.data?.points.length ? (
            <div className="chart-box tall">
              <EChart
                height={460}
                deps={[hist.data, period, t]}
                buildOption={buildKlineOption}
              />
            </div>
          ) : (
            <p className="muted">{t('stocks.empty')}</p>
          )}
        </div>
      )}
    </section>
  );
}
