import { describe, it, expect } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migrate } from '../electron/main/db/migrate.js';
import { insertArticles, runCrawl, getExistingHashes } from '../electron/main/db/persistence.js';
import { createRssCollector } from '../electron/main/collectors/rss.js';
import type { SourceConfig } from '../electron/main/collectors/types.js';

const fixture = () =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'rss.xml'), 'utf8');

async function makeDb(): Promise<Database> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  migrate(db);
  return db;
}

const rssCfg: SourceConfig = { id: 'bbc', name: 'BBC', lang: 'en', kind: 'rss', url: 'http://x/rss' };

describe('persistence', () => {
  it('insertArticles 幂等：相同文章第二次不重复插入', async () => {
    const db = await makeDb();
    const mk = () => ({
      id: 'h1', source: 'bbc', title: 'T', url: 'http://x/1', lang: 'en' as const,
      publishedAt: null, crawledAt: new Date().toISOString(), rawHash: 'h1'
    });
    expect(insertArticles(db, [mk()])).toBe(1);
    expect(insertArticles(db, [mk()])).toBe(0);
    db.close();
  });

  it('runCrawl 首次新增、二次全部去重', async () => {
    const db = await makeDb();
    const c = createRssCollector(rssCfg, async () => fixture());

    const first = await runCrawl(db, [c]);
    const second = await runCrawl(db, [c]);

    expect(first.fetched).toBe(2);
    expect(first.addedNew).toBe(2);
    expect(first.dupes).toBe(0);

    expect(second.fetched).toBe(2);
    expect(second.addedNew).toBe(0);
    expect(second.dupes).toBe(2);

    expect(getExistingHashes(db, 'bbc').size).toBe(2);
    db.close();
  });
});

