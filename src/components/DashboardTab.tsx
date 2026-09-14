import { useEffect } from 'react';
import { useEngineStatus } from '../hooks/useEngineStatus';
import { useInvoke } from '../hooks/useInvoke';
import type { DashboardSnapshot } from '../../shared/dashboard';

const METRICS: { key: keyof DashboardSnapshot['metrics']; label: string }[] = [
  { key: 'articles', label: '文章' },
  { key: 'entities', label: '实体' },
  { key: 'events', label: '事件' },
  { key: 'edges', label: '关系边' },
  { key: 'addedToday', label: '今日新增' }
];

export default function DashboardTab() {
  const { status, error } = useEngineStatus();
  const dash = useInvoke<DashboardSnapshot>('dashboard:today');
  const crawl = useInvoke<{ fetched?: number; addedNew?: number }>('collector:manualRun');
  const graph = useInvoke<{ articles?: number; entities?: number; events?: number; edges?: number }>('graph:build');

  useEffect(() => {
    void dash.run();
  }, []);

  const snap = dash.data;

  return (
    <section>
      <div className="card">
        <h2>总览</h2>
        {snap ? (
          <>
            <div className="stat-grid">
              {METRICS.map((m) => (
                <div className="stat" key={m.key}>
                  <div className="stat-num">{snap.metrics[m.key]}</div>
                  <div className="stat-label">{m.label}</div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 12 }}>
              <div className="stat-label" style={{ marginBottom: 8 }}>今日热点</div>
              {snap.topTopics.length === 0 ? (
                <span className="muted">暂无。先「手动采集 + 构建图谱」。</span>
              ) : (
                <div className="chips">
                  {snap.topTopics.map((t) => (
                    <span className="chip" key={t.name}>
                      {t.name}
                      <span className="n">{t.count}</span>
                      <span className={t.rising ? 'up' : 'down'}>{t.rising ? '▲' : '▼'}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <p className="muted">加载总览…</p>
        )}
      </div>

      <div className="card">
        <h2>引擎与调度</h2>
        <pre className="mono">
          {status
            ? `ready: ${status.ready}\ndbPath: ${status.dbPath}\nsources: ${status.sources.join(', ')}\n自动调度: 每 ${snap?.autoIntervalMinutes ?? '?'} 分钟\n上次自动运行: ${snap?.lastAutoRunAt ? snap.lastAutoRunAt.slice(0, 19).replace('T', ' ') : '尚未运行'}\n上次采集: ${snap?.lastCrawlAt ? snap.lastCrawlAt.slice(0, 19).replace('T', ' ') : '无'}`
            : error
              ? `错误: ${error}`
              : '加载引擎状态…'}
        </pre>
      </div>

      <div className="card">
        <h2>操作</h2>
        <button className="btn" onClick={() => void crawl.run()} disabled={crawl.loading}>手动采集</button>
        <button className="btn primary" onClick={() => void graph.run()} disabled={graph.loading}>构建图谱</button>

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
        {snap && (
          <div className="muted" style={{ marginTop: 8 }}>
            AI 解读请到「解读」Tab 生成。
          </div>
        )}
      </div>
    </section>
  );
}