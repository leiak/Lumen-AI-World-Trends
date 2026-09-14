import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

interface EChartProps {
  height?: number;
  buildOption: () => echarts.EChartsOption;
  deps: unknown[];
}

export default function EChart({ height = 380, buildOption, deps }: EChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chart.setOption(buildOption());
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    if (ref.current) {
      const ro = new ResizeObserver(() => chart.resize());
      ro.observe(ref.current);
      return () => {
        window.removeEventListener('resize', onResize);
        ro.disconnect();
        chart.dispose();
      };
    }
    return () => {
      window.removeEventListener('resize', onResize);
      chart.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return <div ref={ref} className="chart-box" style={{ height }} />;
}