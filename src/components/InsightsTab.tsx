import { useEffect, useState } from 'react';
import { useInvoke } from '../hooks/useInvoke';
import { useI18n } from '../i18n/I18n';
import type { Insight } from '../../shared/insight';
import type { CausalChain } from '../../shared/causal';

function ChainView({ chain }: { chain: CausalChain }) {
  const { t } = useI18n();
  return (
    <div>
      <div className="muted" style={{ marginBottom: 12 }}>
        {chain.rootEntity} · {t('insights.causal.nodes', { a: chain.nodes.length })} ·{' '}
        {t('insights.causal.links', { a: chain.links.length })} · {t('insights.model')} {chain.model}
      </div>
      <ol className="chain-list">
        {chain.nodes.map((node, i) => {
          const link = chain.links[i];
          return (
            <li key={node.eventId}>
              <div className="chain-node">
                <span className="chain-order">{i + 1}</span>
                <div className="chain-node-body">
                  <div className="chain-title">{node.title}</div>
                  <div className="muted">
                    {node.occurredAt.slice(0, 10)} · {node.articleCount} {t('timeline.articles')}
                  </div>
                </div>
              </div>
              {link && (
                <div className="chain-edge">
                  <div className="chain-line">↓</div>
                  <div className="chain-assert">
                    <span className="chip">{t('insights.causal.anchor', { a: link.anchor })}</span>
                    <span className={`tag ${link.kind === 'ai' ? 'tag-ai' : 'tag-rule'}`}>
                      {link.kind === 'ai' ? t('insights.causal.kind.ai') : t('insights.causal.kind.rule')}
                    </span>
                    {link.assertion && <div className="mono chain-assert-text">{link.assertion}</div>}
                  </div>
                </div>
              )}
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
  const [entity, setEntity] = useState('');
  const [useAi, setUseAi] = useState(true);
  const [selectedChain, setSelectedChain] = useState<CausalChain | null>(null);

  useEffect(() => {
    void list.run({ limit: 50 });
    void causalList.run({ limit: 20 });
  }, []);

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

  const current = selected ?? live;
  const typeLabel = (type: string) =>
    type === 'weekly' ? t('insights.type.weekly') : t('insights.type.causal');

  return (
    <section>
      <div className="card">
        <h2>{t('insights.title')}</h2>
        <p className="muted">{t('insights.hint')}</p>
        <button className="btn primary" onClick={() => void handleGen('causal')} disabled={gen.loading}>
          {gen.loading ? t('insights.generating') : t('insights.genCausal')}
        </button>
        <button className="btn" onClick={() => void handleGen('weekly')} disabled={weekly.loading}>
          {weekly.loading ? t('insights.generating') : t('insights.genWeekly')}
        </button>
        {(gen.error || weekly.error) && <p className="err">{t('insights.failed')}: {gen.error ?? weekly.error}</p>}
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
    </section>
  );
}