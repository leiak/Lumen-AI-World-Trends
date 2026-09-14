import { useEffect } from 'react';
import { useInvoke } from '../hooks/useInvoke';
import { useI18n } from '../i18n/I18n';
import type { TimelineEvent } from '../../shared/timeline';

export default function TimelineTab() {
  const { t } = useI18n();
  const { data, run } = useInvoke<TimelineEvent[]>('timeline:replay');
  useEffect(() => {
    void run();
  }, []);

  return (
    <section>
      <div className="card">
        <h2>{t('timeline.title')}</h2>
        <p className="muted">{t('timeline.hint')}</p>
        <button className="btn primary" onClick={() => void run()}>{t('common.refresh')}</button>
      </div>

      <div className="card">
        {(data?.length ?? 0) === 0 ? (
          <p className="muted">{t('timeline.empty')}</p>
        ) : (
          <div className="timeline">
            {data!.map((ev) => (
              <div className="timeline-item" key={ev.id}>
                <div className="timeline-time">{ev.occurredAt.slice(0, 16).replace('T', ' ')} · {ev.articleCount} {t('timeline.articles')}</div>
                <strong>{ev.title}</strong>
                <ul className="article-list">
                  {ev.articles.slice(0, 5).map((a) => (
                    <li key={a.id}>
                      <a href={a.url} target="_blank" rel="noreferrer">
                        {a.title} <span className="muted">— {a.source}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}