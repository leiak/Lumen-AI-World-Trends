import { useState } from 'react';
import { useInvoke } from '../hooks/useInvoke';
import type { SourceArticle } from '../../shared/models';

export default function SearchTab() {
  const [q, setQ] = useState('');
  const s = useInvoke<SourceArticle[]>('search:fulltext');

  return (
    <section>
      <h2>本地全文检索</h2>
      <div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="输入关键词，如 China / 关税"
          style={{ padding: '6px 10px', width: 320, marginRight: 8 }}
        />
        <button onClick={() => void s.run({ query: q })} style={{ cursor: 'pointer' }}>搜索</button>
      </div>
      {s.error && <p style={{ color: 'red' }}>错误: {s.error}</p>}
      <ul>
        {(s.data ?? []).map((a) => (
          <li key={a.id} style={{ marginBottom: 12 }}>
            <strong>{a.title}</strong>
            <div style={{ color: '#666', fontSize: 13 }}>
              {a.source} · {a.crawledAt.slice(0, 16).replace('T', ' ')}
            </div>
            {a.content && <div style={{ color: '#555', fontSize: 13 }}>{a.content.slice(0, 140)}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}
