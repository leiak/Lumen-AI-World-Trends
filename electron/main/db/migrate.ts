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
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');
`;

export function migrate(db: Database): void {
  db.exec(MIGRATION_1);
}
