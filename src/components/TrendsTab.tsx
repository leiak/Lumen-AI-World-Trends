import { useEffect } from 'react';
import { useInvoke } from '../hooks/useInvoke';
import EChart from './EChart';
import type { TrendsResult } from '../../shared/trend';

export default function TrendsTab() {
  const { data, run } = useInvoke<TrendsResult>('topics:list');
  useEffect(() => {
    void run();
  }, []);

  return (
    <section>
      <h2>话题趋势</h2>
      <button onClick={() => void run()} style={{ cursor: 'pointer' }}>刷新</button>
      {data ? (
        <EChart
          height={360}
          deps={[data]}
          buildOption={() => {
            const top = data.trends.slice(0, 5);
            const x = top[0]?.buckets.map((b) => b.bucketStart.slice(5, 16)) ?? [];
            return {
              tooltip: { trigger: 'axis' },
              legend: { data: top.map((t) => t.name) },
              xAxis: { type: 'category', data: x },
              yAxis: { type: 'value' },
              series: top.map((t) => ({
                name: t.name,
                type: 'line',
                smooth: true,
                data: t.buckets.map((b) => b.count)
              }))
            };
          }}
        />
      ) : (
        <p>加载趋势…</p>
      )}
    </section>
  );
}
