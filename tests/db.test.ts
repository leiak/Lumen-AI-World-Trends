import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import initSqlJs, { type Database } from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { openDatabase, saveDatabase } from '../electron/main/db/connection.js';
import { insertArticles } from '../electron/main/db/persistence.js';
import type { SourceArticle } from '../shared/models.js';

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
    expect(tables).toContain('article_entity');
  });

  it('写入 schema_version = 7 且存在 insight/causal_chain 表', () => {
    const stmt = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`);
    const has = stmt.step();
    const row = stmt.getAsObject() as { value: string };
    stmt.free();
    expect(has).toBe(true);
    expect(row.value).toBe('7');
    for (const table of ['insight', 'causal_chain']) {
      const res = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`);
      expect(res.length).toBeGreaterThan(0);
    }
  });

  it('saveDatabase 落盘后可重开读回（本地缓存契约）', async () => {
    const dbPath = path.join(
      os.tmpdir(),
      `lumen-test-${crypto.randomUUID().slice(0, 8)}.db`
    );
    const art: SourceArticle = {
      id: 'r1', source: 'bbc', title: 'Persisted', url: 'http://x/1',
      lang: 'en', publishedAt: null, crawledAt: '2026-01-01T00:00:00Z', rawHash: 'r1'
    };
    try {
      const db1 = await openDatabase(dbPath);
      insertArticles(db1, [art]);
      saveDatabase(db1, dbPath);
      db1.close();

      const db2 = await openDatabase(dbPath);
      const stmt = db2.prepare('SELECT COUNT(*) AS n FROM source_article');
      expect(stmt.step()).toBe(true);
      const row = stmt.getAsObject() as { n: number };
      stmt.free();
      db2.close();
      expect(row.n).toBe(1);
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });
});
