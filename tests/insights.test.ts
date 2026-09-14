import { describe, it, expect } from 'vitest';
import initSqlJs from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { saveInsight, listInsights } from '../electron/main/db/insights.js';
import { MockProvider } from '../electron/main/ai/provider.js';
import { interpretWeekly, buildWeeklyPrompt } from '../electron/main/ai/interpreter.js';
import type { Insight } from '../shared/insight.js';
import type { TrendsResult } from '../shared/trend.js';

const trends: TrendsResult = {
  trends: [
    { key: 'china', name: 'China', count: 8, buckets: [], momentum: 3, rising: true },
    { key: 'oil', name: 'Oil', count: 5, buckets: [], momentum: -1, rising: false }
  ],
  countries: [{ name: 'China', count: 8 }, { name: 'US', count: 3 }],
  generatedAt: '2026-01-09T00:00:00Z'
};

describe('insight 仓储', () => {
  it('保存后按时间倒序列出', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    migrate(db);

    const a: Insight = { id: 'i1', type: 'causal', title: 't1', content: 'c1', generatedAt: '2026-01-01T00:00:00Z', model: 'mock' };
    const b: Insight = { id: 'i2', type: 'weekly', title: 't2', content: 'c2', generatedAt: '2026-01-03T00:00:00Z', model: 'ark' };
    saveInsight(db, a);
    saveInsight(db, b);

    const rows = listInsights(db);
    expect(rows.map((r) => r.id)).toEqual(['i2', 'i1']);
    expect(rows[0]?.model).toBe('ark');
    db.close();
  });

  it('迁移包含 insight 表', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    migrate(db);
    const stmt = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`);
    stmt.step();
    const v = (stmt.getAsObject() as { value: string }).value;
    stmt.free();
    db.close();
    expect(v).toBe('5');
  });
});

describe('周报解读', () => {
  it('buildWeeklyPrompt 含周报系统指令与热度上下文', () => {
    const messages = buildWeeklyPrompt(trends);
    expect(messages.length).toBe(2);
    expect(messages[0]?.content).toContain('周报');
    expect(messages[1]?.content).toContain('China');
    expect(messages[1]?.content).toContain('Oil');
  });

  it('interpretWeekly 用 mock 产出 weekly 类型 Insight', async () => {
    const insight = await interpretWeekly(new MockProvider(), trends, '2026-01-09T00:00:00Z');
    expect(insight.type).toBe('weekly');
    expect(insight.title).toContain('2026-01-09');
    expect(insight.content.length).toBeGreaterThan(0);
    expect(insight.model).toBe('mock');
  });
});