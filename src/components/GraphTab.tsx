import { useEffect } from 'react';
import { useInvoke } from '../hooks/useInvoke';
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
  const { data, run } = useInvoke<GraphView>('graph:query');
  useEffect(() => {
    void run({ topN: 30 });
  }, []);

  return (
    <section>
      <div className="card">
        <h2>事件图谱</h2>
        <p className="muted">节点尺寸=实体频次；连线粗细=共现权重。可拖拽、滚轮缩放。</p>
        <button className="btn primary" onClick={() => void run({ topN: 30 })}>刷新</button>
      </div>

      <div className="card">
        <div className="chart-box tall">
          <EChart
            height={520}
            deps={[data]}
            buildOption={() => {
              const view = data ?? { nodes: [], links: [] };
              return {
                tooltip: {
                  formatter: (p: unknown) => {
                    const item = Array.isArray(p) ? p[0] : p;
                    const o = (item && typeof item === 'object' ? item : {}) as {
                      name?: string;
                      value?: unknown;
                      data?: unknown;
                    };
                    const d = o.data && typeof o.data === 'object' ? (o.data as { name?: string; value?: number }) : o;
                    return `${d.name ?? ''} · 频次 ${typeof d.value === 'number' ? d.value : 0}`;
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
                      symbolSize: Math.max(12, Math.sqrt(n.count) * 7 + 6),
                      itemStyle: { color: TYPE_COLORS[n.type] ?? '#8b949e' }
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
        {data && <p className="muted">{data.nodes.length} 节点 / {data.links.length} 边</p>}
      </div>
    </section>
  );
}