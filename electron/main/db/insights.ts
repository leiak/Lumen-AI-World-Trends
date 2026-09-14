import type { Database } from 'sql.js';
import type { Insight } from '../../../shared/insight.js';

export function saveInsight(db: Database, insight: Insight): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO insight (id, type, title, content, generated_at, model)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  stmt.run([
    insight.id,
    insight.type,
    insight.title,
    insight.content,
    insight.generatedAt,
    insight.model
  ]);
  stmt.free();
}

export function listInsights(db: Database, limit = 50): Insight[] {
  const stmt = db.prepare(
    `SELECT id, type, title, content, generated_at, model
     FROM insight ORDER BY generated_at DESC LIMIT ?`
  );
  stmt.bind([limit]);
  const out: Insight[] = [];
  while (stmt.step()) {
    const r = stmt.getAsObject() as unknown as {
      id: string;
      type: string;
      title: string;
      content: string;
      generated_at: string;
      model: string;
    };
    out.push({
      id: r.id,
      type: r.type as Insight['type'],
      title: r.title,
      content: r.content,
      generatedAt: r.generated_at,
      model: r.model
    });
  }
  stmt.free();
  return out;
}