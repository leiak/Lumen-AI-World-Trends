import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { STOCK_GRAPH_ID, STOCK_LAYER_LABELS, normalizeAStockSymbol } from '../../shared/stock-agent';
import type {
  StockFactsImportResponse,
  StockFactsView,
  StockSampleResponse,
  StockMarketSyncResponse,
  StockFactLayer
} from '../../shared/stock-agent';
import { RATING_LABELS, type MemoryListResponse, type TrendRating } from '../../shared/agent';
import { useAgentRun } from '../hooks/useAgentRun';
import { useI18n } from '../i18n/I18n';
import AgentFlowCanvas from './agent/AgentFlowCanvas';

type InvokeResult = {
  ok?: boolean;
  data?: unknown;
  error?: string;
  code?: string;
  message?: string;
};

const MAGNITUDE_LABELS: Record<'small' | 'medium' | 'large', string> = {
  small: '小',
  medium: '中',
  large: '大'
};

function dateOnlyNow(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoAsOf(dateStr: string): string {
  if (!dateStr) return new Date().toISOString();
  const today = dateOnlyNow();
  if (dateStr >= today) return new Date().toISOString();
  return `${dateStr}T15:00:00.000Z`;
}

export default function StockAgentTab() {
  const { t } = useI18n();
  const {
    state,
    graph,
    viewGraph,
    runs,
    runsLoading,
    start,
    resume,
    selectRun
  } = useAgentRun(STOCK_GRAPH_ID);

  const [symbolInput, setSymbolInput] = useState('sh600519');
  const [asOfDate, setAsOfDate] = useState(dateOnlyNow());
  const [windowDays, setWindowDays] = useState(30);
  const [coverage, setCoverage] = useState<StockFactsView>();
  const [memory, setMemory] = useState<MemoryListResponse>();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const symbol = normalizeAStockSymbol(symbolInput) ?? symbolInput.trim().toLowerCase();

  const refreshed = useCallback(async (sym: string) => {
    const res = (await window.lumen.invoke('agent:stocks:facts:list', {
      symbol: sym,
      asOf: isoAsOf(asOfDate)
    })) as InvokeResult | undefined;
    if (res?.ok) setCoverage(res.data as StockFactsView);
    else setCoverage(undefined);
  }, [asOfDate]);

  useEffect(() => {
    if (!symbol) return;
    void refreshed(symbol);
  }, [symbol, refreshed]);

  const loadMemory = useCallback(async () => {
    const res = (await window.lumen.invoke('agent:memory:list', {
      scope: 'stock'
    })) as InvokeResult | undefined;
    if (res?.ok) setMemory(res.data as MemoryListResponse);
  }, []);

  useEffect(() => {
    void loadMemory();
  }, [loadMemory]);

  useEffect(() => {
    if (state.status === 'completed' || state.status === 'canceled' || state.status === 'failed') {
      void loadMemory();
    }
  }, [state.status, loadMemory]);

  const decision = state.decision ?? state.approval?.decision;
  const stock = decision?.stock;
  const factCheck = state.nodes['fact_check']?.output as
    | { ok?: boolean; unverifiedNumbers?: string[]; checkedNumbers?: string[]; reason?: string }
    | undefined;

  const coverageFacts = useMemo(() => {
    if (!coverage) return [];
    const cutoff = Date.parse(isoAsOf(asOfDate)) - windowDays * 86400000;
    return coverage.facts.filter((f) => Date.parse(f.effectiveAt) >= cutoff);
  }, [coverage, asOfDate, windowDays]);

  const canvasSpec = viewGraph?.spec ?? graph;

  const onImportCsvText = async (csv: string): Promise<void> => {
    setBusy(true);
    try {
      const res = (await window.lumen.invoke('agent:stocks:facts:import', {
        csv,
        symbol
      })) as InvokeResult | undefined;
      if (!res?.ok) {
        setNote(`${res?.code ?? 'E_VALIDATION'}: ${res?.message ?? res?.error ?? '导入失败'}`);
        return;
      }
      const data = res.data as StockFactsImportResponse;
      setNote(`导入 ${data.imported} 条，跳过 ${data.skipped} 条`);
      await refreshed(symbol);
    } finally {
      setBusy(false);
    }
  };

  const onImportSample = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = (await window.lumen.invoke('agent:stocks:sample', {})) as InvokeResult | undefined;
      if (!res?.ok) {
        setNote(`${res?.code ?? 'E_VALIDATION'}: ${res?.message ?? '样例生成失败'}`);
        return;
      }
      const sample = res.data as StockSampleResponse;
      setSymbolInput(sample.symbol);
      await onImportCsvText(sample.csv);
      await refreshed(sample.symbol);
    } finally {
      setBusy(false);
    }
  };

  const onDownloadSample = async (): Promise<void> => {
    const res = (await window.lumen.invoke('agent:stocks:sample', {})) as InvokeResult | undefined;
    if (!res?.ok) {
      setNote(`${res?.code ?? 'E_VALIDATION'}: ${res?.message ?? '样例生成失败'}`);
      return;
    }
    const sample = res.data as StockSampleResponse;
    const blob = new Blob([sample.csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sample.symbol}-facts-sample.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    const text = await file.text();
    await onImportCsvText(text);
  };

  const onSyncMarket = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = (await window.lumen.invoke('agent:stocks:facts:syncMarket', {
        symbol,
        asOf: isoAsOf(asOfDate)
      })) as InvokeResult | undefined;
      if (!res?.ok) {
        setNote(`${res?.code ?? 'E_DB'}: ${res?.message ?? '同步失败'}`);
        return;
      }
      const data = res.data as StockMarketSyncResponse;
      setNote(`行情快照来源：${data.from}，写入 ${data.wrote} 条`);
      await refreshed(symbol);
    } finally {
      setBusy(false);
    }
  };

  const onStart = (): void => {
    if (!symbol) {
      setNote('请填写股票代码');
      return;
    }
    setNote('');
    void start({
      graphId: STOCK_GRAPH_ID,
      subject: { key: `stock:${symbol}`, label: symbol.toUpperCase(), kind: 'stock' },
      asOf: isoAsOf(asOfDate),
      options: {}
    });
  };

  const layerLabel = (layer: StockFactLayer): string =>
    t(`stock.factLayer.${layer}` as Parameters<typeof t>[0]);

  return (
    <div className="agent-tab" data-testid="stock-agent-tab">
      <div className="card">
        <div className="agent-debate-head">
          <h2>{t('stock.title')}</h2>
          <span className={`agent-run-status status-${state.status}`} data-testid="stock-run-state" data-status={state.status}>
            {state.status}
          </span>
        </div>
        <p className="muted">{t('stock.hint')}</p>

        <div className="agent-controls">
          <label className="agent-field">
            <span>{t('stock.symbol')}</span>
            <input
              className="input"
              data-testid="stock-symbol"
              value={symbolInput}
              placeholder={t('stock.symbolPlaceholder')}
              onChange={(e) => setSymbolInput(e.target.value)}
            />
          </label>
          <label className="agent-field">
            <span>{t('stock.asOf')}</span>
            <input
              className="input"
              type="date"
              data-testid="stock-asof"
              value={asOfDate}
              onChange={(e) => setAsOfDate(e.target.value)}
            />
          </label>
          <label className="agent-field">
            <span>{t('stock.window')}</span>
            <input
              className="input"
              type="number"
              min={5}
              max={365}
              data-testid="stock-window"
              value={windowDays}
              onChange={(e) => setWindowDays(Number(e.target.value) || 30)}
            />
          </label>
          <button className="btn primary" data-testid="stock-start" onClick={onStart} disabled={busy || state.status === 'running'}>
            {t('stock.start')}
          </button>
          <button className="btn" data-testid="stock-import-sample" onClick={() => void onImportSample()} disabled={busy}>
            {t('stock.sample')}
          </button>
          <button className="btn" data-testid="stock-sync-market" onClick={() => void onSyncMarket()} disabled={busy}>
            {t('stock.syncMarket')}
          </button>
          <button className="btn" data-testid="stock-import-csv" onClick={() => fileRef.current?.click()} disabled={busy}>
            {t('stock.import')}
          </button>
          <button className="btn" data-testid="stock-download-sample" onClick={() => void onDownloadSample()} disabled={busy}>
            {t('stock.downloadSample')}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            data-testid="stock-file"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
        </div>
        <p className="muted">{t('stock.importHint')}</p>
        {note ? <p className="muted" data-testid="stock-note">{note}</p> : null}

        {coverage ? (
          <div className="agent-legend" data-testid="stock-coverage">
            {coverage.layers.map((l) => (
              <span key={l.layer} className={`legend-item stock-layer-${l.status}`} data-layer={l.layer} data-status={l.status}>
                <i className="dot" />
                {layerLabel(l.layer)} · {l.status} · {l.factCount}
              </span>
            ))}
            <span className="muted">{coverageFacts.length} facts in window</span>
          </div>
        ) : null}
        {state.error ? <p className="agent-error">{state.error}</p> : null}
      </div>

      {state.status === 'interrupted' && state.approval ? (
        <div className="card agent-approval-card" data-testid="stock-approval">
          <div className="agent-debate-head">
            <h3>{t('agent.approval.title')}</h3>
            <span className="agent-review-flag">{t('agent.approval.waiting')}</span>
          </div>
          {state.approval.decision ? (
            <p className="agent-approval-suggested">
              {RATING_LABELS[state.approval.decision.rating]} · {(state.approval.decision.confidence * 100).toFixed(0)}%
              <br />
              {state.approval.decision.thesis}
            </p>
          ) : null}
          <div className="agent-approval-actions">
            <button className="btn primary" data-testid="stock-approve" onClick={() => void resume({ type: 'approve' })}>
              {t('agent.approval.approve')}
            </button>
            <button
              className="btn danger"
              data-testid="stock-reject"
              onClick={() => void resume({ type: 'reject', reason: 'user_rejected' })}
            >
              {t('agent.approval.reject')}
            </button>
          </div>
        </div>
      ) : null}

      <div className="agent-workbench">
        <div className="card agent-flow-card">
          <div className="agent-debate-head">
            <h3>{t('agent.graph.title')}</h3>
            {viewGraph ? (
              <span className="muted" data-testid="stock-graph-version" data-digest={viewGraph.digest}>
                v{viewGraph.version} · {viewGraph.digest.slice(0, 10)}
              </span>
            ) : null}
          </div>
          <div className="agent-legend">
            <span className="legend-item"><i className="dot pending" />{t('agent.legend.pending')}</span>
            <span className="legend-item"><i className="dot running" />{t('agent.legend.running')}</span>
            <span className="legend-item"><i className="dot done" />{t('agent.legend.done')}</span>
            <span className="legend-item"><i className="dot error" />{t('agent.legend.error')}</span>
          </div>
          <AgentFlowCanvas
            spec={canvasSpec}
            nodes={state.nodes}
            streams={state.streams}
            onSelect={() => undefined}
          />
        </div>

        <div className="card" data-testid="stock-conclusion">
          <div className="agent-debate-head">
            <h3>{t('stock.conclusion')}</h3>
            {decision ? (
              <span className={`rating-badge rating-${decision.rating}`} data-rating={decision.rating}>
                {decision.rating === 'review'
                  ? `待复核${decision.reviewReason ? ` · ${decision.reviewReason}` : ''}`
                  : RATING_LABELS[decision.rating as TrendRating]}
              </span>
            ) : null}
          </div>
          {!decision ? (
            <p className="muted">尚未产生结论。请先导入事实数据并运行分析。</p>
          ) : (
            <>
              <p className="agent-approval-suggested" data-testid="stock-thesis">{decision.thesis}</p>
              <div className="agent-legend">
                <span className="legend-item">{t('stock.direction')}：{RATING_LABELS[decision.rating]}</span>
                <span className="legend-item">{t('stock.magnitude')}：{stock ? MAGNITUDE_LABELS[stock.magnitude] : '—'}</span>
                <span className="legend-item">置信度：{(decision.confidence * 100).toFixed(0)}%</span>
                {decision.reviewRequired ? <span className="agent-review-flag">{decision.reviewReason}</span> : null}
              </div>
              {stock ? (
                <>
                  <h4>{t('stock.factors')}</h4>
                  {stock.factors.map((f) => (
                    <div key={`${f.id}-${f.layer}`} className="stock-factor" data-layer={f.layer}>
                      <span className={`stock-factor-contrib ${f.contribution}`}>{f.contribution}</span>
                      <strong>{f.label}</strong>
                      <span className="muted">（权重 {(f.weight * 100).toFixed(0)}%）</span>
                      <p>{f.mechanism}</p>
                      <p className="muted stock-fact-ids">
                        {f.factIds.map((id) => (
                          <code key={id} data-fact-id={id}>{id}</code>
                        ))}
                      </p>
                    </div>
                  ))}
                  {stock.missingLayers.length > 0 ? (
                    <p className="agent-error" data-testid="stock-missing-layers">
                      {t('stock.missing')}：{stock.missingLayers.map(layerLabel).join('、')}（该维度缺失，未做外推）
                    </p>
                  ) : null}
                  {stock.assumptions.length > 0 ? (
                    <div data-testid="stock-assumptions">
                      <h4>{t('stock.assumptions')}</h4>
                      <ul>
                        {stock.assumptions.map((a, i) => (
                          <li key={i}>{a}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </>
              ) : null}
              <h4>{t('stock.factCheck')}</h4>
              <p data-testid="stock-fact-check" data-ok={factCheck?.ok ? 'true' : 'false'}>
                {factCheck?.ok ? t('stock.gateOk') : t('stock.gateFail')}
                {factCheck?.unverifiedNumbers?.length
                  ? `：${factCheck.unverifiedNumbers.join('、')}`
                  : ''}
              </p>
            </>
          )}
          <p className="muted">{t('stock.disclaimer')}</p>
        </div>
      </div>

      <div className="card">
        <div className="agent-debate-head">
          <h3>{t('stock.runs')}</h3>
          {runsLoading ? <span className="muted">…</span> : null}
        </div>
        {runs.map((r) => (
          <button
            key={r.runId}
            className="btn agent-run-item"
            data-testid={`stock-run-${r.runId}`}
            onClick={() => void selectRun(r.runId)}
          >
            {r.subject.label} · {r.status} · {r.startedAt.slice(0, 19).replace('T', ' ')}
          </button>
        ))}
      </div>

      {memory ? (
        <div className="card" data-testid="stock-memory">
          <div className="agent-debate-head">
            <h3>记忆与结算</h3>
            <span className="muted">主口径 T+5 交易日</span>
          </div>
          <div className="agent-legend">
            <span className="legend-item" data-testid="stock-memory-pending">待结算 {memory.stats.pending}</span>
            <span className="legend-item">已结算 {memory.stats.settled}</span>
            <span className="legend-item">命中 {memory.stats.hits} / 未命中 {memory.stats.misses}</span>
            <span className="legend-item">命中率 {(memory.stats.hitRate * 100).toFixed(0)}%</span>
            <span className="legend-item">数据不足 {memory.stats.insufficient}</span>
          </div>
          {memory.pending.slice(0, 5).map((d) => (
            <p key={d.id} className="muted" data-testid={`stock-memory-pending-${d.id}`}>
              {d.subjectLabel} · {RATING_LABELS[d.rating]} · 观察至 {d.resolveAfter}
            </p>
          ))}
          {memory.settled.slice(0, 5).map((m) => (
            <p key={m.id} className="muted" data-testid={`stock-memory-settled-${m.id}`}>
              {m.subjectKey} · {m.outcome.verdict}
              {m.reflection ? ` · ${m.reflection}` : ''}
            </p>
          ))}
        </div>
      ) : null}

      {coverageFacts.length > 0 ? (
        <div className="card">
          <div className="agent-debate-head"><h3>{t('stock.coverage')}</h3></div>
          {coverage?.layers.map((l) => (
            <div key={l.layer} className="stock-layer-row" data-layer={l.layer}>
              <span>{layerLabel(l.layer)}</span>
              <span className={`legend-item stock-layer-${l.status}`}>{l.status}</span>
              {l.gaps.length > 0 ? <span className="muted">{l.gaps.join('；')}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
