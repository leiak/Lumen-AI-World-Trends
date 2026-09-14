import { useEffect, useState } from 'react';
import { useInvoke } from '../hooks/useInvoke';
import { useI18n } from '../i18n/I18n';
import EChart from './EChart';
import type { GraphView } from '../../shared/graph-view';

const TYPE_COLORS: Record<string, string> = {
  country: '#e0553a',
  organization: '#3fb950',
  person: '#58a6ff',
  location: '#f0a04b',
  topic: '#a371f7',
  event: '#f778ba'
};

export default function GraphTab() {
  const { t } = useI18n();
  const { data, run } = useInvoke<GraphView>('graph:query');
  const [showEvents, setShowEvents] = useState(true);
  useEffect(() => {
    void run({ topN: 30, includeEvents: showEvents });
  }, [showEvents]);

  return (
    <section>
      <div className="card">
        <h2>{t('graph.title')}</h2>
        <p className="muted">{t('graph.hint')}</p>
        <button className="btn primary" onClick={() => void run({ topN: 30, includeEvents: showEvents })}>{t('common.refresh')}</button>
        <button className="btn" onClick={() => setShowEvents(!showEvents)}>
          {showEvents ? t('graph.showEventsOn') : t('graph.showEventsOff')}
        </button>
      </div>

      <div className="card">
        <div className="chart-box tall">
          <EChart
            height={520}
            deps={[data, showEvents, t]}
            buildOption={() => {
              const view = data ?? { nodes: [], links: [] };
              return {
                tooltip: {
                  formatter: (p: unknown) => {
                    const raw = (Array.isArray(p) ? p[0] : p ?? {}) as {
                      name?: string;
                      value?: unknown;
                      data?: { name?: string; value?: unknown; occurredAt?: string };
                    };
                    const name = raw.data?.name ?? raw.name ?? '';
                    const value =
                      typeof raw.data?.value === 'number'
                        ? raw.data.value
                        : typeof raw.value === 'number'
                          ? raw.value
                          : 0;
                    const time = raw.data?.occurredAt
                      ? new Date(raw.data.occurredAt).toISOString().slice(0, 16).replace('T', ' ')
                      : '';
                    return `${name} · ${t('graph.count')} ${value}${time ? `\n${time}` : ''}`;
                  }
                },
                series: [
                  {
                    type: 'graph',
                    layout: 'force',
                    roam: true,
                    draggable: true,
                    label: { show: true, position: 'right', color: '#c9d1d9', fontSize: 11 },
                    edgeLabel: { show: false },
                    data: view.nodes.map((n) => ({
                      id: n.id,
                      name: n.name,
                      value: n.count,
                      symbol: n.kind === 'event' ? 'diamond' : 'circle',
                      symbolSize: Math.max(12, Math.sqrt(n.count) * 7 + 6),
                      itemStyle: { color: TYPE_COLORS[n.type] ?? '#8b949e' },
                      occurredAt: n.occurredAt
                    })),
                    links: view.links.map((l) => ({
                      source: l.source,
                      target: l.target,
                      lineStyle: { opacity: 0.5, width: Math.min(5, Math.max(1, l.weight)) }
                    })),
                    force: { repulsion: 220, edgeLength: 90 },
                    emphasis: { focus: 'adjacency' }
                  }
                ]
              };
            }}
          />
        </div>
        {data && <p className="muted">{t('graph.nodeEdge', { a: data.nodes.length, b: data.links.length })}</p>}
      </div>
    </section>
  );
}