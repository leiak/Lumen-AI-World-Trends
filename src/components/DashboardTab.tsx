import { useEffect, useState } from 'react';
import { useEngineStatus } from '../hooks/useEngineStatus';
import { useInvoke } from '../hooks/useInvoke';

export default function DashboardTab() {
  const { status, error } = useEngineStatus();
  const crawl = useInvoke<{ fetched?: number; addedNew?: number; dupes?: number }>('collector:manualRun');
  const graph = useInvoke<{ articles?: number; entities?: number; events?: number; edges?: number }>('graph:build');
  const insight = useInvoke<{ title?: string; content?: string }>('insights:generate');

  const btn: React.CSSProperties = { padding: '8px 16px', marginRight: 8, cursor: 'pointer' };

  return (
    <section>
      <h2>总览</h2>
      <pre style={{ background: '#f5f5f5', padding: 12 }}>
        {status ? `ready: ${status.ready}\ndbPath: ${status.dbPath}\nsources: ${status.sources.join(', ')}` : '加载引擎状态…'}
        {error ? `\n错误: ${error}` : ''}
      </pre>

      <div style={{ margin: '12px 0' }}>
        <button style={btn} onClick={() => void crawl.run()} disabled={crawl.loading}>手动采集</button>
        <button style={btn} onClick={() => void graph.run()} disabled={graph.loading}>构建图谱</button>
        <button style={btn} onClick={() => void insight.run()} disabled={insight.loading}>生成解读</button>
      </div>

      {(crawl.data || crawl.error) && (
        <p>采 集 → {crawl.error ? `错误: ${crawl.error}` : `抓取 ${crawl.data?.fetched ?? 0}，新增 ${crawl.data?.addedNew ?? 0}`}</p>
      )}
      {(graph.data || graph.error) && (
        <p>图 谱 → {graph.error ? `错误: ${graph.error}` : `文章 ${graph.data?.articles ?? 0} / 实体 ${graph.data?.entities ?? 0} / 事件 ${graph.data?.events ?? 0} / 边 ${graph.data?.edges ?? 0}`}</p>
      )}

      {insight.data && (
        <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, marginTop: 16 }}>
          <h3>AI 解读</h3>
          <p>{insight.data.content}</p>
        </div>
      )}
    </section>
  );
}
