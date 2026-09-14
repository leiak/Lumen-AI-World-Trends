import { useEffect } from 'react';
import { useInvoke } from '../hooks/useInvoke';
import EChart from './EChart';
import type { TrendsResult } from '../../shared/trend';

export default function WorldTab() {
  const { data, run } = useInvoke<TrendsResult>('topics:list');
  useEffect(() => {
    void run();
  }, []);

  return (
    <section>
      <div className="card">
        <h2>世界热点（国家维度）</h2>
        <p className="muted">按国家/地区关联的文章数量排序（Top15）。</p>
        <button className="btn primary" onClick={() => void run()}>刷新</button>
      </div>

      <div className="card">
        {data && data.countries.length > 0 ? (
          <div className="chart-box">
            <EChart
              height={420}
              deps={[data]}
              buildOption={() => {
                const items = data.countries.slice(0, 15);
                return {
                  tooltip: { axisPointer: { type: 'shadow' } },
                  xAxis: { type: 'value', axisLabel: { color: '#9aa4b2' }, splitLine: { lineStyle: { color: '#30363d' } } },
                  yAxis: { type: 'category', data: items.map((c) => c.name), axisLabel: { color: '#c9d1d9' } },
                  series: [
                    {
                      type: 'bar',
                      data: items.map((c) => ({ value: c.count })),
                      itemStyle: { color: '#e0553a', borderRadius: [0, 6, 6, 0] },
                      label: { show: true, position: 'right', color: '#9aa4b2' }
                    }
                  ]
                };
              }}
            />
          </div>
        ) : (
          <p className="muted">{data ? '暂无国家维度数据。' : '加载世界热点…'}</p>
        )}
      </div>
    </section>
  );
}