import { useEffect } from 'react';
import { useInvoke } from '../hooks/useInvoke';
import { useI18n } from '../i18n/I18n';
import EChart from './EChart';
import type { TrendsResult } from '../../shared/trend';

export default function TrendsTab() {
  const { t } = useI18n();
  const { data, run } = useInvoke<TrendsResult>('topics:list');
  useEffect(() => {
    void run();
  }, []);

  return (
    <section>
      <div className="card">
        <h2>{t('trends.title')}</h2>
        <p className="muted">{t('trends.hint')}</p>
        <button className="btn primary" onClick={() => void run()}>{t('common.refresh')}</button>
      </div>

      <div className="card">
        {data ? (
          <div className="chart-box">
            <EChart
              height={360}
              deps={[data, t]}
              buildOption={() => {
                const top = data.trends.slice(0, 5);
                const x = top[0]?.buckets.map((b) => b.bucketStart.slice(5, 16)) ?? [];
                return {
                  tooltip: { trigger: 'axis' },
                  legend: { data: top.map((tp) => tp.name), textStyle: { color: '#9aa4b2' } },
                  xAxis: { type: 'category', data: x, axisLabel: { color: '#9aa4b2' } },
                  yAxis: { type: 'value', axisLabel: { color: '#9aa4b2' }, splitLine: { lineStyle: { color: '#30363d' } } },
                  series: top.map((tp) => ({
                    name: tp.name,
                    type: 'line',
                    smooth: true,
                    data: tp.buckets.map((b) => b.count)
                  }))
                };
              }}
            />
          </div>
        ) : (
          <p className="muted">{t('trends.loading')}</p>
        )}
      </div>
    </section>
  );
}