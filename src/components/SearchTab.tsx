import { useState } from 'react';
import { useInvoke } from '../hooks/useInvoke';
import type { SourceArticle } from '../../shared/models';

export default function SearchTab() {
  const [q, setQ] = useState('');
  const s = useInvoke<SourceArticle[]>('search:fulltext');

  return (
    <section>
      <div className="card">
        <h2>本地全文检索</h2>
        <p className="muted">检索本地缓存的已爬取文章（支持中英文关键词）。</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void s.run({ query: q });
            }}
            placeholder="输入关键词，如 China / 关税"
          />
          <button className="btn primary" onClick={() => void s.run({ query: q })}>搜索</button>
        </div>
        {s.error && <p className="err">错误: {s.error}</p>}
      </div>

      <div className="card">
        {(s.data?.length ?? 0) === 0 ? (
          <p className="muted">暂无结果。先搜一搜，或到「总览」采集文章。</p>
        ) : (
          <ul className="article-list">
            {(s.data ?? []).map((a) => (
              <li key={a.id} style={{ padding: '10px 0' }}>
                <strong>{a.title}</strong>
                <div className="muted">
                  {a.source} · {a.crawledAt.slice(0, 16).replace('T', ' ')}
                </div>
                {a.content && <div className="muted">{a.content.slice(0, 160)}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}