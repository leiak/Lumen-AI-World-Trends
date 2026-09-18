import { useEffect, useMemo, useState } from 'react';
import * as echarts from 'echarts';
import { useInvoke } from '../hooks/useInvoke';
import { useI18n } from '../i18n/I18n';
import EChart from './EChart';
import type {
  AlertKind,
  KlinePeriod,
  StockAlert,
  StockGroup,
  StockHistoryResult,
  StockWatchItem,
  StocksAlertsView,
  StocksGroupsView,
  StocksView,
  StocksWatchView
} from '../../shared/stocks';

const PERIODS: KlinePeriod[] = ['day', 'week', 'month'];
const ALERT_KINDS: AlertKind[] = ['price_above', 'price_below', 'pct_above', 'pct_below'];
type SortBy = 'default' | 'name' | 'price' | 'change' | 'changePct';
type SortDir = 'asc' | 'desc';

function fmtPrice(n: number): string {
  if (n >= 1000) return n.toFixed(0);
  if (n >= 100) return n.toFixed(1);
  if (n >= 10) return n.toFixed(2);
  return n.toFixed(3);
}

function fmtNum(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(2)} 万`;
  return n.toFixed(2);
}

function fmtPct(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  return `${n.toFixed(2)}%`;
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
  const groupsList = useInvoke<StocksGroupsView>('stocks:groups:list');
  const groupCreate = useInvoke<StockGroup>('stocks:groups:create');
  const groupRename = useInvoke<StocksGroupsView>('stocks:groups:rename');
  const groupRemove = useInvoke<StocksGroupsView>('stocks:groups:remove');
  const groupSetWatch = useInvoke<StocksWatchView>('stocks:groups:setWatch');
  const alertsList = useInvoke<StocksAlertsView>('stocks:alerts:list');
  const alertAdd = useInvoke<StockAlert>('stocks:alerts:add');
  const alertRemove = useInvoke<{ ok: true }>('stocks:alerts:remove');
  const alertToggle = useInvoke<StockAlert>('stocks:alerts:toggle');

  const [selected, setSelected] = useState<string | null>(null);
  const [period, setPeriod] = useState<KlinePeriod>('day');
  const [addInput, setAddInput] = useState('');
  const [activeGroup, setActiveGroup] = useState<number | null>(null); // null = 全部
  const [sortBy, setSortBy] = useState<SortBy>('default');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [showFin, setShowFin] = useState(false);
  const [alertFor, setAlertFor] = useState<StockWatchItem | null>(null);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');

  useEffect(() => {
    void view.run();
    void watch.run();
    void groupsList.run();
    void alertsList.run();
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
  const groups = groupsList.data?.items ?? [];
  const alerts = alertsList.data?.items ?? [];

  // 分组过滤 + 排序
  const filteredItems = useMemo(() => {
    const items =
      activeGroup === null ? watchItems : watchItems.filter((w) => w.groupId === activeGroup);
    if (sortBy === 'default') return items;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...items].sort((a, b) => {
      const qa = quoteBySymbol.get(a.symbol);
      const qb = quoteBySymbol.get(b.symbol);
      switch (sortBy) {
        case 'name':
          return dir * a.name.localeCompare(b.name);
        case 'price':
          return dir * ((qa?.price ?? 0) - (qb?.price ?? 0));
        case 'change':
          return dir * ((qa?.change ?? 0) - (qb?.change ?? 0));
        case 'changePct':
          return dir * ((qa?.changePct ?? 0) - (qb?.changePct ?? 0));
        default:
          return 0;
      }
    });
  }, [watchItems, activeGroup, sortBy, sortDir, quotes]);

  const rows = filteredItems.map((w) => ({ ...w, quote: quoteBySymbol.get(w.symbol) }));

  function toggleSort(col: SortBy): void {
    if (sortBy !== col) {
      setSortBy(col);
      setSortDir('desc');
    } else {
      setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
    }
  }

  function onRefresh(): void {
    void refresh.run();
  }

  async function onAdd(): Promise<void> {
    const symbol = addInput.trim();
    if (!symbol) return;
    const res = await add.run({ symbol });
    if (res && res.ok) {
      setAddInput('');
      void watch.run();
      void refresh.run();
    }
  }

  async function onRemove(symbol: string): Promise<void> {
    const res = await remove.run({ symbol });
    if (res && res.ok) {
      void watch.run();
      void view.run();
      if (selected === symbol) setSelected(null);
    }
  }

  async function onCreateGroup(): Promise<void> {
    const name = newGroupName.trim();
    if (!name) return;
    const res = await groupCreate.run({ name });
    if (res?.ok) {
      setNewGroupName('');
      setNewGroupOpen(false);
      void groupsList.run();
    }
  }

  async function onRenameGroup(id: number): Promise<void> {
    const cur = groups.find((g) => g.id === id);
    if (!cur) return;
    const name = window.prompt(t('stocks.group.rename'), cur.name);
    if (!name || name === cur.name) return;
    const res = await groupRename.run({ id, name });
    if (res?.ok) {
      void groupsList.run();
    } else if (res?.error) {
      window.alert(res.error);
    }
  }

  async function onRemoveGroup(id: number): Promise<void> {
    const cur = groups.find((g) => g.id === id);
    if (!cur) return;
    const fallback = groups.find((g) => g.id !== id)?.name ?? '';
    const ok = window.confirm(t('stocks.group.removeHint', { n: cur.name, fallback }));
    if (!ok) return;
    const res = await groupRemove.run({ id });
    if (res?.ok) {
      void groupsList.run();
      void watch.run();
      if (activeGroup === id) setActiveGroup(null);
    } else if (res?.error) {
      window.alert(res.error);
    }
  }

  async function onMoveToGroup(symbol: string, groupId: number | null): Promise<void> {
    const res = await groupSetWatch.run({ symbol, groupId });
    if (res?.ok) void watch.run();
  }

  function openAlertModal(item: StockWatchItem): void {
    setAlertFor(item);
  }

  async function onSubmitAlert(kind: AlertKind, threshold: number): Promise<void> {
    if (!alertFor) return;
    const res = await alertAdd.run({ symbol: alertFor.symbol, kind, threshold });
    if (res?.ok) {
      setAlertFor(null);
      void alertsList.run();
    } else if (res?.error) {
      window.alert(t('stocks.alert.addFail', { msg: res.error }));
    }
  }

  async function onAlertToggle(id: number, enabled: boolean): Promise<void> {
    const res = await alertToggle.run({ id, enabled });
    if (res?.ok) void alertsList.run();
  }

  async function onAlertRemove(id: number): Promise<void> {
    const res = await alertRemove.run({ id });
    if (res?.ok) void alertsList.run();
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

  function sortArrow(col: SortBy): string {
    if (sortBy !== col) return '';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  }

  const defaultGroupId = groups.find((g) => g.name === '默认' || g.name === 'Default')?.id;

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

        {/* 分组栏 */}
        <div className="chips" style={{ marginTop: 8 }}>
          <span className="muted" style={{ marginRight: 4 }}>{t('stocks.group.title')}:</span>
          <button
            key="all"
            className={`chip pick${activeGroup === null ? ' on' : ''}`}
            onClick={() => setActiveGroup(null)}
          >
            {t('stocks.group.all')} ({watchItems.length})
          </button>
          {groups.map((g) => (
            <button
              key={g.id}
              className={`chip pick${activeGroup === g.id ? ' on' : ''}`}
              onClick={() => setActiveGroup(g.id)}
              title={g.name}
            >
              {g.name}
              {g.id !== defaultGroupId && (
                <span style={{ marginLeft: 6, opacity: 0.6 }}>
                  <span
                    role="button"
                    aria-label="rename"
                    style={{ cursor: 'pointer', paddingRight: 4 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      void onRenameGroup(g.id);
                    }}
                  >
                    ✎
                  </span>
                  <span
                    role="button"
                    aria-label="remove"
                    style={{ cursor: 'pointer' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      void onRemoveGroup(g.id);
                    }}
                  >
                    ✕
                  </span>
                </span>
              )}
            </button>
          ))}
          {newGroupOpen ? (
            <span style={{ display: 'inline-flex', gap: 4 }}>
              <input
                className="input"
                style={{ width: 140 }}
                autoFocus
                value={newGroupName}
                placeholder={t('stocks.group.newPlaceholder')}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void onCreateGroup();
                  if (e.key === 'Escape') {
                    setNewGroupOpen(false);
                    setNewGroupName('');
                  }
                }}
              />
              <button className="btn tiny primary" onClick={() => void onCreateGroup()}>
                ✓
              </button>
              <button
                className="btn tiny"
                onClick={() => {
                  setNewGroupOpen(false);
                  setNewGroupName('');
                }}
              >
                ✕
              </button>
            </span>
          ) : (
            <button className="chip" onClick={() => setNewGroupOpen(true)}>
              + {t('stocks.group.new')}
            </button>
          )}
        </div>

        {/* 排序 + 财务指标 切换 */}
        <div className="chips" style={{ marginTop: 6 }}>
          <span className="muted" style={{ marginRight: 4 }}>{t('stocks.sort.title')}:</span>
          {(['default', 'name', 'price', 'change', 'changePct'] as SortBy[]).map((s) => (
            <button
              key={s}
              className={`chip pick${sortBy === s ? ' on' : ''}`}
              onClick={() => {
                if (s === 'default') {
                  setSortBy('default');
                } else {
                  toggleSort(s);
                }
              }}
            >
              {t(`stocks.sort.${s}`)}{s !== 'default' ? sortArrow(s) : ''}
            </button>
          ))}
          <button
            className={`chip pick${showFin ? ' on' : ''}`}
            style={{ marginLeft: 12 }}
            onClick={() => setShowFin(!showFin)}
          >
            {t('stocks.fin.title')}: {showFin ? t('stocks.fin.hide') : t('stocks.fin.show')}
          </button>
        </div>

        <div className="watch-add" style={{ marginTop: 10 }}>
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
                {showFin && <th>{t('stocks.fin.pe')}</th>}
                {showFin && <th>{t('stocks.fin.pb')}</th>}
                {showFin && <th>{t('stocks.fin.marketCap')}</th>}
                {showFin && <th>{t('stocks.fin.turnoverPct')}</th>}
                {showFin && <th>{t('stocks.fin.amplitudePct')}</th>}
                {showFin && <th>{t('stocks.fin.volumeRatio')}</th>}
                <th>
                  {t('stocks.group.title')}
                  <select
                    className="select"
                    style={{ marginLeft: 4, fontSize: 11 }}
                    value=""
                    onChange={(e) => {
                      const v = e.target.value;
                      if (!v) return;
                      const gid = v === '__null' ? null : Number(v);
                      for (const r of rows) void onMoveToGroup(r.symbol, gid);
                    }}
                  >
                    <option value="">→</option>
                    <option value="__null">—</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                </th>
                <th></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ symbol, name, groupId, quote }) => {
                const up = (quote?.change ?? 0) > 0;
                const flat = (quote?.change ?? 0) === 0;
                const cls = up ? 'gain' : flat ? '' : 'loss';
                const grp = groups.find((g) => g.id === groupId);
                return (
                  <tr key={symbol} className={selected === symbol ? 'sel' : ''}>
                    <td className="sym-cell" onClick={() => setSelected(symbol)}>{name}</td>
                    <td className="muted sym-cell" onClick={() => setSelected(symbol)}>{symbol}</td>
                    <td className={cls}>{quote ? fmtPrice(quote.price) : '—'}</td>
                    <td className={cls}>{quote ? `${up ? '+' : ''}${quote.change.toFixed(2)}` : '—'}</td>
                    <td className={cls}>{quote ? `${up ? '+' : ''}${quote.changePct.toFixed(2)}%` : '—'}</td>
                    {showFin && <td className="muted">{fmtNum(quote?.pe)}</td>}
                    {showFin && <td className="muted">{fmtNum(quote?.pb)}</td>}
                    {showFin && <td className="muted">{fmtNum(quote?.marketCap)}</td>}
                    {showFin && <td className="muted">{fmtPct(quote?.turnoverPct)}</td>}
                    {showFin && <td className="muted">{fmtPct(quote?.amplitudePct)}</td>}
                    {showFin && <td className="muted">{fmtNum(quote?.volumeRatio)}</td>}
                    <td className="muted">{grp?.name ?? '—'}</td>
                    <td>
                      <button
                        className="btn tiny"
                        title={t('stocks.alert.add')}
                        onClick={() => openAlertModal({ symbol, name, market: '', groupId })}
                      >
                        🔔
                      </button>
                    </td>
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

      {/* 预警管理 */}
      <div className="card">
        <h3>{t('stocks.alert.title')}</h3>
        {alerts.length === 0 ? (
          <p className="muted">{t('stocks.alert.empty')}</p>
        ) : (
          <table className="stock-table">
            <thead>
              <tr>
                <th>{t('stocks.alert.symbol')}</th>
                <th>{t('stocks.alert.kind')}</th>
                <th>{t('stocks.alert.threshold')}</th>
                <th>{t('stocks.alert.status')}</th>
                <th>{t('stocks.alert.lastFired')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((al) => {
                const sym = watchItems.find((w) => w.symbol === al.symbol)?.name ?? al.symbol;
                return (
                  <tr key={al.id}>
                    <td>{sym}</td>
                    <td>{t(`stocks.alert.kind.${al.kind}`)}</td>
                    <td>
                      {al.threshold.toFixed(2)}
                      {al.kind.startsWith('pct') ? t('stocks.alert.thresholdPctSuffix') : ''}
                    </td>
                    <td>
                      <button
                        className={`chip pick${al.enabled ? ' on' : ''}`}
                        onClick={() => void onAlertToggle(al.id, !al.enabled)}
                      >
                        {al.enabled ? t('stocks.alert.on') : t('stocks.alert.off')}
                      </button>
                    </td>
                    <td className="muted">{al.lastFiredAt ? fmtTime(al.lastFiredAt) : t('stocks.alert.never')}</td>
                    <td>
                      <button
                        className="btn tiny"
                        title={t('common.error')}
                        onClick={() => void onAlertRemove(al.id)}
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

      {alertFor && (
        <AlertModal
          item={alertFor}
          onClose={() => setAlertFor(null)}
          onSubmit={onSubmitAlert}
        />
      )}
    </section>
  );
}

interface AlertModalProps {
  item: StockWatchItem;
  onClose: () => void;
  onSubmit: (kind: AlertKind, threshold: number) => Promise<void>;
}

function AlertModal({ item, onClose, onSubmit }: AlertModalProps): React.ReactElement {
  const { t } = useI18n();
  const [kind, setKind] = useState<AlertKind>('price_above');
  const [threshold, setThreshold] = useState('');
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t('stocks.alert.addFor', { name: item.name })}</h3>
        <div className="form-row">
          <label>{t('stocks.alert.kind')}:</label>
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value as AlertKind)}>
            {ALERT_KINDS.map((k) => (
              <option key={k} value={k}>{t(`stocks.alert.kind.${k}`)}</option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label>{t('stocks.alert.threshold')}:</label>
          <input
            className="input"
            type="number"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
          {kind.startsWith('pct') && <span>%</span>}
        </div>
        <div className="form-actions">
          <button className="btn" onClick={onClose}>{t('stocks.alert.cancel')}</button>
          <button
            className="btn primary"
            onClick={() => {
              const n = Number(threshold);
              if (!threshold || !Number.isFinite(n)) {
                window.alert(t('stocks.alert.required'));
                return;
              }
              void onSubmit(kind, n);
            }}
          >
            {t('stocks.alert.create')}
          </button>
        </div>
      </div>
    </div>
  );
}