import { useEffect, useState } from 'react';
import { useInvoke } from '../hooks/useInvoke';
import type { Insight } from '../../shared/insight';

const TYPE_LABEL: Record<string, string> = {
  causal: '因果解读',
  weekly: '周报'
};

export default function InsightsTab() {
  const list = useInvoke<Insight[]>('insights:list');
  const gen = useInvoke<Insight>('insights:generate');
  const weekly = useInvoke<Insight>('insights:weekly');
  const [selected, setSelected] = useState<Insight | null>(null);
  const [live, setLive] = useState<Insight | null>(null);

  useEffect(() => {
    void list.run({ limit: 50 });
  }, []);

  async function handleGen(kind: 'causal' | 'weekly') {
    const run = kind === 'causal' ? gen : weekly;
    await run.run();
    if (run.data) setLive(run.data);
    void list.run({ limit: 50 });
  }

  const current = selected ?? live;

  return (
    <section>
      <div className="card">
        <h2>AI 解读中心</h2>
        <p className="muted">解读基于本地趋势数据生成并缓存；未配置 ARK_API_KEY 时走离线 Mock。</p>
        <button className="btn primary" onClick={() => void handleGen('causal')} disabled={gen.loading}>
          {gen.loading ? '生成中…' : '生成解读'}
        </button>
        <button className="btn" onClick={() => void handleGen('weekly')} disabled={weekly.loading}>
          {weekly.loading ? '生成中…' : '生成周报'}
        </button>
        {(gen.error || weekly.error) && <p className="err">生成失败: {gen.error ?? weekly.error}</p>}
      </div>

      <div className="card">
        <h2>{current ? `${TYPE_LABEL[current.type] ?? current.type} · ${current.title}` : '最近生成'}</h2>
        {current ? (
          <>
            <div className="muted" style={{ marginBottom: 8 }}>
              {current.generatedAt.slice(0, 19).replace('T', ' ')} · 模型 {current.model}
            </div>
            <div className="mono">{current.content}</div>
          </>
        ) : (
          <p className="muted">还没有解读。点上方按钮生成第一条。</p>
        )}
      </div>

      <div className="card">
        <h2>历史（本地缓存）</h2>
        {(list.data?.length ?? 0) === 0 ? (
          <p className="muted">{list.loading ? '加载历史…' : '暂无历史记录。'}</p>
        ) : (
          <ul className="insight-list">
            {(list.data ?? []).map((ins) => (
              <li key={ins.id} className="insight-item" onClick={() => setSelected(ins)}>
                <span className={`tag tag-${ins.type}`}>{TYPE_LABEL[ins.type] ?? ins.type}</span>
                <span className="insight-title">{ins.title}</span>
                <span className="muted">
                  {ins.generatedAt.slice(0, 16).replace('T', ' ')} · {ins.model}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}