import { describe, it, expect } from 'vitest';
import initSqlJs from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { computeTrends, computeHeatmap } from '../electron/main/trends/engine.js';

describe('computeTrends', () => {
  it('计算时间序列、动量与世界热点', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    migrate(db);

    const addEntity = (name: string, type: string) =>
      db.run(
        'INSERT OR IGNORE INTO entity (id, name, name_en, type, lang) VALUES (?, ?, NULL, ?, ?)',
        [name.toLowerCase(), name, type, 'en']
      );
    addEntity('China', 'country');
    addEntity('Russia', 'country');
    addEntity('OpenAI', 'organization');

    const addRow = (entity: string, article: string, at: string) =>
      db.run(
        'INSERT OR IGNORE INTO article_entity (article_id, entity_id, crawled_at) VALUES (?, ?, ?)',
        [article, entity.toLowerCase(), at]
      );

    ['a1', 'a2', 'a3'].forEach((a, i) => addRow('China', a, `2026-01-0${i + 2}T00:00:00Z`));
    ['a4', 'a5', 'a6', 'a7', 'a8'].forEach((a) => addRow('China', a, '2026-01-08T00:00:00Z'));
    ['a9', 'a10', 'a11'].forEach((a, i) => addRow('Russia', a, `2026-01-0${i + 1}T00:00:00Z`));
    addRow('OpenAI', 'a12', '2026-01-07T00:00:00Z');

    const now = '2026-01-09T00:00:00Z';
    const res = computeTrends(db, { now, horizonMs: 8 * 86400000, bucketCount: 8, topN: 20 });

    const china = res.trends.find((t) => t.name === 'China');
    const russia = res.trends.find((t) => t.name === 'Russia');
    expect(china?.count).toBe(8);
    expect(china?.buckets.length).toBe(8);
    expect(china?.rising).toBe(true);
    expect(russia?.rising).toBe(false);

    expect(res.countries.some((c) => c.name === 'China')).toBe(true);
    expect(res.countries.some((c) => c.name === 'OpenAI')).toBe(false);

    const heat = computeHeatmap(db, { now, horizonMs: 8 * 86400000, bucketCount: 8 });
    expect(heat[0].name).toBe('China');
    expect(heat.some((c) => c.name === 'OpenAI')).toBe(false);
    db.close();
  });
});
