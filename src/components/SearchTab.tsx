import { useState } from 'react';
import { useInvoke } from '../hooks/useInvoke';
import { useI18n } from '../i18n/I18n';
import type { SourceArticle } from '../../shared/models';

export default function SearchTab() {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const s = useInvoke<SourceArticle[]>('search:fulltext');

  return (
    <section>
      <div className="card">
        <h2>{t('search.title')}</h2>
        <p className="muted">{t('search.hint')}</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void s.run({ query: q });
            }}
            placeholder={t('search.placeholder')}
          />
          <button className="btn primary" onClick={() => void s.run({ query: q })}>{t('search.button')}</button>
        </div>
        {s.error && <p className="err">{t('common.error')}: {s.error}</p>}
      </div>

      <div className="card">
        {(s.data?.length ?? 0) === 0 ? (
          <p className="muted">{t('search.empty')}</p>
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