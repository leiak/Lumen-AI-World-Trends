import { useEffect } from 'react';
import { useInvoke } from '../hooks/useInvoke';
import type { TimelineEvent } from '../../shared/timeline';

export default function TimelineTab() {
  const { data, run } = useInvoke<TimelineEvent[]>('timeline:replay');
  useEffect(() => {
    void run();
  }, []);

  return (
    <section>
      <div className="card">
        <h2>时间线回放</h2>
        <p className="muted">事件按时间倒序；需先「构建图谱」产生事件。</p>
        <button className="btn primary" onClick={() => void run()}>刷新</button>
      </div>

      <div className="card">
        {(data?.length ?? 0) === 0 ? (
          <p className="muted">暂无事件。请在「总览」点「构建图谱」生成后再回来。</p>
        ) : (
          <div className="timeline">
            {data!.map((ev) => (
              <div className="timeline-item" key={ev.id}>
                <div className="timeline-time">{ev.occurredAt.slice(0, 16).replace('T', ' ')} · {ev.articleCount} 篇</div>
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
