import type { Database } from 'sql.js';

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT UNIQUE NOT NULL,
  last_cursor TEXT,
  last_crawled_at TEXT
);
`;

const MIGRATION_2 = `
CREATE TABLE IF NOT EXISTS source_article (
  raw_hash TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  url TEXT NOT NULL,
  lang TEXT NOT NULL,
  published_at TEXT,
  crawled_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_article_source ON source_article(source);
CREATE INDEX IF NOT EXISTS idx_article_crawled ON source_article(crawled_at);
`;

export function migrate(db: Database): void {
  db.exec(MIGRATION_1);
  db.exec(MIGRATION_2);
  db.exec(
    `DELETE FROM meta WHERE key='schema_version';` +
      `INSERT INTO meta (key, value) VALUES ('schema_version', '2');`
  );
}
