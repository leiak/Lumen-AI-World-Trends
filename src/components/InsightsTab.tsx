import { useEffect, useState } from 'react';
import { useInvoke } from '../hooks/useInvoke';
import { useI18n } from '../i18n/I18n';
import type { Insight } from '../../shared/insight';
import type { CausalChain } from '../../shared/causal';

function ChainView({ chain }: { chain: CausalChain }) {
  const { t } = useI18n();
  const kindLabel = (kind: string) =>
    kind === 'ai' ? t('insights.causal.kind.ai') : t('insights.causal.kind.rule');
  const kindTag = (kind: string) => (kind === 'ai' ? 'tag-ai' : 'tag-rule');
  return (
    <div>
      <div className="muted" style={{ marginBottom: 12 }}>
        {chain.rootEntity}
        {chain.entities && chain.entities.length > 1
          ? ` +${chain.entities.length - 1} · ${t('insights.nar.entities', { a: chain.entities.length })}`
          : ''}{' '}
        · {t('insights.causal.nodes', { a: chain.nodes.length })} ·{' '}
        {t('insights.causal.links', { a: chain.links.length })} · {t('insights.model')} {chain.model}
      </div>
      <ol className="chain-list">
        {chain.nodes.map((node, idx) => {
          const outgoing = chain.links.filter((l) => l.fromEventId === node.eventId);
          return (
            <li key={node.eventId}>
              <div className="chain-node">
                <span className="chain-order">{(chain.nodes.indexOf(node) + 1).toString()}</span>
                <div className="chain-node-body">
                  <div className="chain-title">{node.title}</div>
                  <div className="muted">
                    {node.occurredAt.slice(0, 10)} · {node.articleCount} {t('timeline.articles')}
                  </div>
                </div>
              </div>
              {outgoing.map((link, li) => (
                <div key={li} className="chain-edge">
                  <div className="chain-line">↓</div>
                  <div className="chain-assert">
                    {link.anchor && <span className="chip">{t('insights.causal.anchor', { a: link.anchor })}</span>}
                    <span className={`tag ${kindTag(link.kind)}`}>{kindLabel(link.kind)}</span>
                    {link.assertion && <div className="mono chain-assert-text">{link.assertion}</div>}
                  </div>
                </div>
              ))}
            </li>
          );
        })}
      </ol>
      {chain.summary && (
        <div style={{ marginTop: 12 }}>
          <h3 style={{ marginBottom: 6 }}>{t('insights.causal.summary')}</h3>
          <div className="mono">{chain.summary}</div>
        </div>
      )}
    </div>
  );
}

export default function InsightsTab() {
  const { t } = useI18n();
  const list = useInvoke<Insight[]>('insights:list');
  const gen = useInvoke<Insight>('insights:generate');
  const weekly = useInvoke<Insight>('insights:weekly');
  const [selected, setSelected] = useState<Insight | null>(null);
  const [live, setLive] = useState<Insight | null>(null);

  const causalList = useInvoke<CausalChain[]>('causality:list');
  const causalGen = useInvoke<CausalChain>('causality:generate');
  const narratives = useInvoke<CausalChain[]>('causality:narratives');
  const narSum = useInvoke<CausalChain>('causality:summarize');
  const narCf = useInvoke<{ text: string; model: string }>('causality:counterfactual');
  const [entity, setEntity] = useState('');
  const [useAi, setUseAi] = useState(true);
  const [selectedChain, setSelectedChain] = useState<CausalChain | null>(null);
  const [selectedNarrative, setSelectedNarrative] = useState<CausalChain | null>(null);
  const [narSummary, setNarSummary] = useState<CausalChain | null>(null);
  const [cfText, setCfText] = useState<string | null>(null);
  const [cfHypothesis, setCfHypothesis] = useState('');

  const exportSnap = useInvoke<{ saved: boolean; path?: string }>('export:snapshot');
  const crawl = useInvoke<{ fetched?: number; addedNew?: number }>('collector:manualRun');
  const graph = useInvoke<{ articles?: number; entities?: number; events?: number; edges?: number }>('graph:build');
  const [exportNote, setExportNote] = useState<{ text: string; isError: boolean } | null>(null);

  useEffect(() => {
    void list.run({ limit: 50 });
    void causalList.run({ limit: 20 });
    void loadNarratives();
  }, []);

  async function loadNarratives() {
    const res = await narratives.run();
    if (res?.ok && res.data && res.data.length > 0) {
      const first = res.data[0];
      if (first) setSelectedNarrative(first);
    }
  }

  async function handleNarSummary() {
    if (!selectedNarrative) return;
    const res = await narSum.run({ chain: selectedNarrative });
    if (res?.ok && res.data) setNarSummary(res.data);
  }

  async function handleNarCounterfactual() {
    if (!selectedNarrative) return;
    const hypothesis = cfHypothesis.trim();
    const res = await narCf.run({ chain: selectedNarrative, hypothesis: hypothesis || undefined });
    if (res?.ok && res.data) setCfText(res.data.text);
  }
  async function handleGen(kind: 'causal' | 'weekly') {
    const run = kind === 'causal' ? gen : weekly;
    await run.run();
    if (run.data) setLive(run.data);
    void list.run({ limit: 50 });
  }

  async function handleCausalGen() {
    const name = entity.trim();
    if (!name) return;
    const res = await causalGen.run({ name, maxEvents: 5, useAi });
    if (res?.ok && res.data) {
      setSelectedChain(res.data);
      void causalList.run({ limit: 20 });
    }
  }

  async function handleExport() {
    const res = await exportSnap.run({ format: 'md' });
    if (res?.ok && res.data) {
      setExportNote(
        res.data.saved
          ? { text: t('insights.exported', { path: res.data.path ?? '' }), isError: false }
          : { text: t('insights.exportCanceled'), isError: true }
      );
    } else if (res?.ok === false) {
      setExportNote({ text: t('insights.exportFailed', { msg: res.error ?? '' }), isError: true });
    }
  }

  const current = selected ?? live;
  const typeLabel = (type: string) =>
    type === 'weekly' ? t('insights.type.weekly') : t('insights.type.causal');
  const emptyAll = (list.data?.length ?? 0) === 0 && (causalList.data?.length ?? 0) === 0;
  const showGuide = emptyAll && !list.loading && !causalList.loading;

  return (
    <section>
      {showGuide && (
        <div className="card">
          <h2>{t('insights.guide.title')}</h2>
          <ol className="guide-steps">
            <li>{t('insights.guide.step1')}</li>
            <li>{t('insights.guide.step2')}</li>
            <li>{t('insights.guide.step3')}</li>
          </ol>
          <div className="chain-bar">
            <button className="btn" onClick={() => void crawl.run()} disabled={crawl.loading}>
              {crawl.loading ? t('common.loading') : t('insights.guide.crawl')}
            </button>
            <button className="btn primary" onClick={() => void graph.run()} disabled={graph.loading}>
              {graph.loading ? t('common.loading') : t('insights.guide.build')}
            </button>
          </div>
          {crawl.error && <p className="err">{t('common.error')}: {crawl.error}</p>}
          {graph.error && <p className="err">{t('common.error')}: {graph.error}</p>}
          {crawl.data && (
            <p className="ok">{t('dash.crawlOk', { a: crawl.data?.fetched ?? 0, b: crawl.data?.addedNew ?? 0 })}</p>
          )}
          {graph.data && (
            <p className="ok">
              {t('dash.buildOk', {
                a: graph.data?.articles ?? 0,
                b: graph.data?.entities ?? 0,
                c: graph.data?.events ?? 0,
                d: graph.data?.edges ?? 0
              })}
            </p>
          )}
          <p className="muted" style={{ marginTop: 8 }}>{t('insights.guide.hint')}</p>
        </div>
      )}

      <div className="insights-grid">
        <div className="insights-col">
          <div className="card">
            <div className="card-head">
              <h2>{t('insights.title')}</h2>
              <button className="btn" onClick={() => void handleExport()} disabled={exportSnap.loading}>
                {exportSnap.loading ? t('insights.exporting') : t('insights.export')}
              </button>
            </div>
            <p className="muted">{t('insights.hint')}</p>
            <button className="btn primary" onClick={() => void handleGen('causal')} disabled={gen.loading}>
              {gen.loading ? t('insights.generating') : t('insights.genCausal')}
            </button>
            <button className="btn" onClick={() => void handleGen('weekly')} disabled={weekly.loading}>
              {weekly.loading ? t('insights.generating') : t('insights.genWeekly')}
            </button>
            {(gen.error || weekly.error) && <p className="err">{t('insights.failed')}: {gen.error ?? weekly.error}</p>}
            {exportNote && <p className={exportNote.isError ? 'err' : 'ok'}>{exportNote.text}</p>}
          </div>

          <div className="card">
            <h2>{current ? `${typeLabel(current.type)} · ${current.title}` : t('insights.recent')}</h2>
            {current ? (
              <>
                <div className="muted" style={{ marginBottom: 8 }}>
                  {current.generatedAt.slice(0, 19).replace('T', ' ')} · {t('insights.model')} {current.model}
                </div>
                <div className="mono">{current.content}</div>
              </>
            ) : (
              <p className="muted">{t('insights.empty')}</p>
            )}
          </div>

          <div className="card">
            <h2>{t('insights.history')}</h2>
            {(list.data?.length ?? 0) === 0 ? (
              <p className="muted">{list.loading ? t('insights.loadingHistory') : t('insights.historyEmpty')}</p>
            ) : (
              <ul className="insight-list">
                {(list.data ?? []).map((ins) => (
                  <li key={ins.id} className="insight-item" onClick={() => setSelected(ins)}>
                    <span className={`tag tag-${ins.type}`}>{typeLabel(ins.type)}</span>
                    <span className="insight-title">{ins.title}</span>
                    <span className="muted">
                      {ins.generatedAt.slice(0, 16).replace('T', ' ')} · {ins.model}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="insights-col">
          <div className="card">
            <div className="card-head">
              <h2>{t('insights.nar.title')}</h2>
              <button className="btn" onClick={() => void loadNarratives()} disabled={narratives.loading}>
                {narratives.loading ? t('common.loading') : t('insights.nar.refresh')}
              </button>
            </div>
            <p className="muted">{t('insights.nar.hint')}</p>
            {narratives.error && <p className="err">{t('insights.failed')}: {narratives.error}</p>}
            {(narratives.data?.length ?? 0) === 0 ? (
              <p className="muted">{narratives.loading ? t('insights.loadingHistory') : t('insights.nar.empty')}</p>
            ) : (
              <>
                <ul className="insight-list">
                  {(narratives.data ?? []).map((n) => (
                    <li
                      key={n.id}
                      className={`insight-item${selectedNarrative?.id === n.id ? ' selected' : ''}`}
                      onClick={() => { setSelectedNarrative(n); setNarSummary(null); setCfText(null); }}
                    >
                      <span className="tag tag-narrative">{t('insights.nar.title')}</span>
                      <span className="insight-title">
                        {n.rootEntity}
                        {n.entities && n.entities.length > 1 ? ` +${n.entities.length - 1}` : ''}
                      </span>
                      <span className="muted">
                        {t('insights.causal.nodes', { a: n.nodes.length })} ·{' '}
                        {t('insights.causal.links', { a: n.links.length })}
                      </span>
                    </li>
                  ))}
                </ul>
                {selectedNarrative && (
                  <div style={{ marginTop: 12 }}>
                    <ChainView chain={selectedNarrative} />
                    <div className='chain-bar' style={{ marginTop: 12 }}>
                      <button className='btn primary' onClick={() => void handleNarSummary()} disabled={narSum.loading}>
                        {narSum.loading ? t('insights.nar.summarizing') : t('insights.nar.summarize')}
                      </button>
                      <input
                        className='input chain-input'
                        placeholder={t('insights.nar.cfPlaceholder')}
                        value={cfHypothesis}
                        onChange={(e) => setCfHypothesis(e.target.value)}
                      />
                      <button className='btn' onClick={() => void handleNarCounterfactual()} disabled={narCf.loading}>
                        {narCf.loading ? t('common.loading') : t('insights.nar.cfDo')}
                      </button>
                    </div>
                    {(narSum.error || narCf.error) && (
                      <p className='err'>{t('insights.failed')}: {narSum.error ?? narCf.error}</p>
                    )}
                    {narSummary && (
                      <div style={{ marginTop: 12 }}>
                        <h3 style={{ marginBottom: 6 }}>{t('insights.nar.summarize')}</h3>
                        <div className='mono'>{narSummary.summary ?? ''}</div>
                      </div>
                    )}
                    {cfText && (
                      <div style={{ marginTop: 12 }}>
                        <h3 style={{ marginBottom: 6 }}>{t('insights.nar.counterfactual')}</h3>
                        <div className='mono'>{cfText}</div>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="card">
            <h2>{t('insights.causal.title')}</h2>
            <p className="muted">{t('insights.causal.hint')}</p>
            <div className="chain-bar">
              <input
                className="input chain-input"
                placeholder={t('insights.causal.placeholder')}
                value={entity}
                onChange={(e) => setEntity(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCausalGen();
                }}
              />
              <button
                className="btn primary"
                onClick={() => void handleCausalGen()}
                disabled={causalGen.loading || !entity.trim()}
              >
                {causalGen.loading ? t('insights.generating') : t('insights.causal.gen')}
              </button>
              <button className={useAi ? 'btn chain-ai on' : 'btn'} onClick={() => setUseAi(!useAi)}>
                {useAi ? t('insights.causal.aiOn') : t('insights.causal.aiOff')}
              </button>
            </div>
            {causalGen.error && <p className="err">{t('insights.failed')}: {causalGen.error}</p>}
            {selectedChain ? <ChainView chain={selectedChain} /> : <p className="muted">{t('insights.causal.empty')}</p>}
          </div>

          <div className="card">
            <h2>{t('insights.causal.history')}</h2>
            {(causalList.data?.length ?? 0) === 0 ? (
              <p className="muted">{causalList.loading ? t('insights.loadingHistory') : t('insights.causal.historyEmpty')}</p>
            ) : (
              <ul className="insight-list">
                {(causalList.data ?? []).map((chain) => (
                  <li key={chain.id} className="insight-item" onClick={() => setSelectedChain(chain)}>
                    <span className="tag tag-causal">{t('insights.causal.title')}</span>
                    <span className="insight-title">{chain.rootEntity}</span>
                    <span className="muted">
                      {chain.generatedAt.slice(0, 16).replace('T', ' ')} · {chain.model} ·{' '}
                      {t('insights.causal.nodes', { a: chain.nodes.length })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}



