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

const MIGRATION_3 = `
CREATE TABLE IF NOT EXISTS entity (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_en TEXT,
  type TEXT NOT NULL,
  lang TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS event (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT,
  occurred_at TEXT,
  lang TEXT
);
CREATE TABLE IF NOT EXISTS article_event (
  article_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY (article_id, event_id)
);
CREATE TABLE IF NOT EXISTS graph_edge (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  event_id TEXT,
  relation_type TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_edge_source ON graph_edge(source);
CREATE INDEX IF NOT EXISTS idx_article_event_article ON article_event(article_id);
`;

const MIGRATION_4 = `
CREATE TABLE IF NOT EXISTS article_entity (
  article_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  crawled_at TEXT NOT NULL,
  PRIMARY KEY (article_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_article_entity_crawled ON article_entity(crawled_at);
`;

const MIGRATION_6 = `
CREATE TABLE IF NOT EXISTS causal_chain (
  id TEXT PRIMARY KEY,
  root_entity TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  model TEXT NOT NULL,
  chain_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_causal_root ON causal_chain(root_entity);
CREATE INDEX IF NOT EXISTS idx_causal_generated ON causal_chain(generated_at);
`;

const MIGRATION_5 = `
CREATE TABLE IF NOT EXISTS insight (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  model TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_insight_generated ON insight(generated_at);
`;

const MIGRATION_7 = `
CREATE TABLE IF NOT EXISTS stock_quote (
  symbol TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  prev_close REAL NOT NULL DEFAULT 0,
  change REAL NOT NULL DEFAULT 0,
  change_pct REAL NOT NULL DEFAULT 0,
  open REAL,
  high REAL,
  low REAL,
  volume REAL,
  amount REAL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stock_kline (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  open REAL NOT NULL DEFAULT 0,
  close REAL NOT NULL DEFAULT 0,
  high REAL NOT NULL DEFAULT 0,
  low REAL NOT NULL DEFAULT 0,
  volume REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_kline_symbol ON stock_kline(symbol);
`;

export function migrate(db: Database): void {
  db.exec(MIGRATION_1);
  db.exec(MIGRATION_2);
  db.exec(MIGRATION_3);
  db.exec(MIGRATION_4);
  db.exec(MIGRATION_5);
  db.exec(MIGRATION_6);
  db.exec(MIGRATION_7);
  db.exec(
    `DELETE FROM meta WHERE key='schema_version';` +
      `INSERT INTO meta (key, value) VALUES ('schema_version', '7');`
  );
}


