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
      <h2>世界热点（国家维度）</h2>
      <button onClick={() => void run()} style={{ cursor: 'pointer' }}>刷新</button>
      {data ? (
        <EChart
          height={420}
          deps={[data]}
          buildOption={() => {
            const items = data.countries.slice(0, 15);
            return {
              tooltip: {},
              xAxis: { type: 'value' },
              yAxis: { type: 'category', data: items.map((c) => c.name) },
              series: [
                {
                  type: 'bar',
                  data: items.map((c) => c.count),
                  itemStyle: { color: '#e0553a' }
                }
              ]
            };
          }}
        />
      ) : (
        <p>加载世界热点…</p>
      )}
    </section>
  );
}
