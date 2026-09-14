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
      <div className="card">
        <h2>话题趋势</h2>
        <p className="muted">按词频动量汇总，展示 Top5 话题的时间序列。</p>
        <button className="btn primary" onClick={() => void run()}>刷新</button>
      </div>

      <div className="card">
        {data ? (
          <div className="chart-box">
            <EChart
              height={360}
              deps={[data]}
              buildOption={() => {
                const top = data.trends.slice(0, 5);
                const x = top[0]?.buckets.map((b) => b.bucketStart.slice(5, 16)) ?? [];
                return {
                  tooltip: { trigger: 'axis' },
                  legend: { data: top.map((t) => t.name), textStyle: { color: '#9aa4b2' } },
                  xAxis: { type: 'category', data: x, axisLabel: { color: '#9aa4b2' } },
                  yAxis: { type: 'value', axisLabel: { color: '#9aa4b2' }, splitLine: { lineStyle: { color: '#30363d' } } },
                  series: top.map((t) => ({
                    name: t.name,
                    type: 'line',
                    smooth: true,
                    data: t.buckets.map((b) => b.count)
                  }))
                };
              }}
            />
          </div>
        ) : (
          <p className="muted">加载趋势…</p>
        )}
      </div>
    </section>
  );
}