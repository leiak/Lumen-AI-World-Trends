import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';

describe('database', () => {
  let db: Database;

  beforeAll(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    migrate(db);
  });

  it('迁移后存在核心表', () => {
    const res = db.exec(`SELECT name FROM sqlite_master WHERE type='table'`);
    const tables = res[0] ? res[0].values.flat() : [];
    expect(tables).toContain('meta');
    expect(tables).toContain('source_state');
    expect(tables).toContain('source_article');
    expect(tables).toContain('entity');
    expect(tables).toContain('event');
    expect(tables).toContain('graph_edge');
  });

  it('写入 schema_version = 2', () => {
    const stmt = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`);
    const has = stmt.step();
    const row = stmt.getAsObject() as { value: string };
    stmt.free();
    expect(has).toBe(true);
    expect(row.value).toBe('3');
  });
});

