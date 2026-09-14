import { useEngineStatus } from '../hooks/useEngineStatus';
import { useInvoke } from '../hooks/useInvoke';

export default function DashboardTab() {
  const { status, error } = useEngineStatus();
  const crawl = useInvoke<{ fetched?: number; addedNew?: number }>('collector:manualRun');
  const graph = useInvoke<{ articles?: number; entities?: number; events?: number; edges?: number }>('graph:build');
  const insight = useInvoke<{ title?: string; content?: string }>('insights:generate');

  return (
    <section>
      <div className="card">
        <h2>引擎状态</h2>
        <pre className="mono">
          {status
            ? `ready: ${status.ready}\ndbPath: ${status.dbPath}\nsources: ${status.sources.join(', ')}`
            : error
              ? `错误: ${error}`
              : '加载引擎状态…'}
        </pre>
      </div>

      <div className="card">
        <h2>操作</h2>
        <button className="btn" onClick={() => void crawl.run()} disabled={crawl.loading}>手动采集</button>
        <button className="btn" onClick={() => void graph.run()} disabled={graph.loading}>构建图谱</button>
        <button className="btn primary" onClick={() => void insight.run()} disabled={insight.loading}>生成解读</button>

        {(crawl.data || crawl.error) && (
          <p className={crawl.error ? 'err' : 'ok'}>
            {crawl.error ? `采集错误: ${crawl.error}` : `采集完成 · 抓取 ${crawl.data?.fetched ?? 0} / 新增 ${crawl.data?.addedNew ?? 0}`}
          </p>
        )}
        {(graph.data || graph.error) && (
          <p className={graph.error ? 'err' : 'ok'}>
            {graph.error ? `图谱错误: ${graph.error}` : `图谱完成 · 文章 ${graph.data?.articles ?? 0} / 实体 ${graph.data?.entities ?? 0} / 事件 ${graph.data?.events ?? 0} / 边 ${graph.data?.edges ?? 0}`}
          </p>
        )}
      </div>

      {insight.data && (
        <div className="card">
          <h2>AI 解读</h2>
          <p>{insight.data.content}</p>
          {insight.error && <p className="err">{insight.error}</p>}
        </div>
      )}
    </section>
  );
}
