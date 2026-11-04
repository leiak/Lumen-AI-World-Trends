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

const MIGRATION_8 = `
DROP TABLE IF EXISTS stock_kline;
CREATE TABLE stock_kline (
  symbol TEXT NOT NULL,
  period TEXT NOT NULL DEFAULT 'day',
  date TEXT NOT NULL,
  open REAL NOT NULL DEFAULT 0,
  close REAL NOT NULL DEFAULT 0,
  high REAL NOT NULL DEFAULT 0,
  low REAL NOT NULL DEFAULT 0,
  volume REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (symbol, period, date)
);
CREATE INDEX IF NOT EXISTS idx_kline_symbol_period ON stock_kline(symbol, period);
CREATE TABLE IF NOT EXISTS stock_watch (
  symbol TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  market TEXT NOT NULL DEFAULT 'cn',
  sort INTEGER NOT NULL DEFAULT 0
);
`;

const MIGRATION_9_DDL = `
CREATE TABLE IF NOT EXISTS stock_group (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS stock_alert (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL,
  threshold REAL NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fired_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alert_symbol ON stock_alert(symbol);
CREATE INDEX IF NOT EXISTS idx_alert_enabled ON stock_alert(enabled);
`;

/** sql.js 不支持 `ALTER TABLE ADD COLUMN IF NOT EXISTS` —— 包成安全执行。
 *  抛错信息含 "duplicate column" 时视为成功；其余错误向上抛。 */
function safeAlter(db: Database, sql: string): void {
  try {
    db.exec(sql);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/duplicate column name|already exists/i.test(msg)) throw e;
  }
}

const MIGRATION_9_ALTERS = [
  'ALTER TABLE stock_watch ADD COLUMN group_id INTEGER REFERENCES stock_group(id) ON DELETE SET NULL;',
  'ALTER TABLE stock_quote ADD COLUMN pe REAL;',
  'ALTER TABLE stock_quote ADD COLUMN pb REAL;',
  'ALTER TABLE stock_quote ADD COLUMN market_cap REAL;',
  'ALTER TABLE stock_quote ADD COLUMN turnover_pct REAL;',
  'ALTER TABLE stock_quote ADD COLUMN amplitude_pct REAL;',
  'ALTER TABLE stock_quote ADD COLUMN volume_ratio REAL;'
];

const MIGRATION_10_ALTERS = [
  'ALTER TABLE source_article ADD COLUMN hot_score INTEGER;'
];

/** P4：图草稿/发布状态与 spec 摘要；run 记录绑定摘要。 */
const MIGRATION_13_ALTERS = [
  "ALTER TABLE agent_graph ADD COLUMN status TEXT NOT NULL DEFAULT 'published';",
  'ALTER TABLE agent_graph ADD COLUMN digest TEXT;',
  'ALTER TABLE agent_run ADD COLUMN graph_digest TEXT;'
];

/** P5：审批挂起快照，供进程重启后只恢复 final 节点。 */
const MIGRATION_14_ALTERS = [
  'ALTER TABLE agent_run ADD COLUMN suspend_json TEXT;'
];

/** P6：角色 prompt 版本包（不可变）+ run 绑定 prompt 版本/摘要/快照。 */
const MIGRATION_15_DDL = `
CREATE TABLE IF NOT EXISTS agent_prompt_pack (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  digest TEXT NOT NULL,
  prompts_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_prompt_pack_active ON agent_prompt_pack(is_active);
`;

const MIGRATION_15_ALTERS = [
  'ALTER TABLE agent_run ADD COLUMN prompt_version INTEGER NOT NULL DEFAULT 0;',
  'ALTER TABLE agent_run ADD COLUMN prompt_digest TEXT;',
  'ALTER TABLE agent_run ADD COLUMN prompt_json TEXT;'
];

/** P7：LangGraph checkpoint 持久化（thread_id = runId）+ 断点续跑启动恢复元数据。
 *  checkpoint/writes 的 value 都以 serde 的类型 + 文本保存；不存可执行代码。
 *  用 checkpoint_id（uuid6）排序，字典序即时间序；writes 额外保存 task_path，
 *  恢复时按 (task_path, task_id, idx) 还原并行节点的 pending writes。 */
const MIGRATION_16_DDL = `
CREATE TABLE IF NOT EXISTS agent_run_checkpoint (
  run_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  serde_type TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL,
  metadata_type TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  run_meta_json TEXT NOT NULL DEFAULT '{}',
  step INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, checkpoint_ns, checkpoint_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_checkpoint_run ON agent_run_checkpoint(run_id, checkpoint_id);

CREATE TABLE IF NOT EXISTS agent_run_checkpoint_write (
  run_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  channel TEXT NOT NULL,
  serde_type TEXT NOT NULL,
  value_json TEXT NOT NULL,
  task_path TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (run_id, checkpoint_ns, checkpoint_id, task_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_agent_checkpoint_write_task ON agent_run_checkpoint_write(run_id, checkpoint_id, task_id);
`;

const MIGRATION_16_ALTERS = [
  'ALTER TABLE agent_run ADD COLUMN recovery_json TEXT;'
];

const MIGRATION_11 = `
CREATE TABLE IF NOT EXISTS agent_graph (
  graph_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  spec_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (graph_id, version)
);
CREATE INDEX IF NOT EXISTS idx_agent_graph_active ON agent_graph(is_active);

CREATE TABLE IF NOT EXISTS agent_run (
  run_id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL,
  graph_version INTEGER NOT NULL,
  thread_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','interrupted','completed','failed','canceled')),
  subject_key TEXT NOT NULL,
  subject_label TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('topic','country','event')),
  as_of TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  config_json TEXT NOT NULL,
  state_json TEXT,
  error_code TEXT,
  error_message TEXT,
  rating TEXT,
  review_required INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  calls INTEGER NOT NULL DEFAULT 0,
  prompt_chars INTEGER NOT NULL DEFAULT 0,
  completion_chars INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL
);
CREATE INDEX IF NOT EXISTS idx_agent_run_status ON agent_run(status, started_at);
CREATE INDEX IF NOT EXISTS idx_agent_run_subject ON agent_run(subject_key, as_of);

CREATE TABLE IF NOT EXISTS agent_run_event (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  node_id TEXT,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS agent_node_result (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  node_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','skipped')),
  started_at TEXT,
  ended_at TEXT,
  elapsed_ms INTEGER,
  input_summary TEXT,
  output_json TEXT,
  error_code TEXT,
  error_message TEXT,
  PRIMARY KEY (run_id, node_id, attempt)
);
CREATE INDEX IF NOT EXISTS idx_agent_node_run ON agent_node_result(run_id);

CREATE TABLE IF NOT EXISTS agent_decision (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  subject_label TEXT NOT NULL,
  as_of TEXT NOT NULL,
  rating TEXT NOT NULL,
  confidence REAL NOT NULL,
  horizon_days INTEGER NOT NULL,
  thesis TEXT NOT NULL,
  key_risks_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','settled','review')),
  resolve_after TEXT,
  resolved_at TEXT,
  outcome_json TEXT,
  reflection TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (subject_key, as_of, run_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_decision_pending ON agent_decision(status, resolve_after);
CREATE INDEX IF NOT EXISTS idx_agent_decision_subject ON agent_decision(subject_key, as_of);

CREATE TABLE IF NOT EXISTS agent_memory (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  as_of TEXT NOT NULL,
  resolved_at TEXT NOT NULL,
  rating TEXT NOT NULL,
  horizon_days INTEGER NOT NULL,
  outcome_json TEXT NOT NULL,
  reflection TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_memory_subject ON agent_memory(subject_key, resolved_at);
CREATE INDEX IF NOT EXISTS idx_agent_memory_resolved ON agent_memory(resolved_at);
`;

const MIGRATION_12 = `
DROP TABLE IF EXISTS agent_decision_v12;
CREATE TABLE agent_decision_v12 (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  subject_label TEXT NOT NULL,
  as_of TEXT NOT NULL,
  rating TEXT NOT NULL,
  confidence REAL NOT NULL,
  horizon_days INTEGER NOT NULL,
  thesis TEXT NOT NULL,
  key_risks_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','settled','insufficient','review')),
  resolve_after TEXT,
  resolved_at TEXT,
  outcome_json TEXT,
  reflection TEXT,
  baseline_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (subject_key, as_of, run_id)
);
INSERT OR IGNORE INTO agent_decision_v12
  (id, run_id, subject_key, subject_label, as_of, rating, confidence, horizon_days, thesis,
   key_risks_json, status, resolve_after, resolved_at, outcome_json, reflection, baseline_json, created_at)
  SELECT id, run_id, subject_key, subject_label, as_of, rating, confidence, horizon_days, thesis,
   key_risks_json, status, resolve_after, resolved_at, outcome_json, reflection, NULL, created_at
  FROM agent_decision;
DROP TABLE agent_decision;
ALTER TABLE agent_decision_v12 RENAME TO agent_decision;
CREATE INDEX IF NOT EXISTS idx_agent_decision_pending ON agent_decision(status, resolve_after);
CREATE INDEX IF NOT EXISTS idx_agent_decision_subject ON agent_decision(subject_key, as_of);
CREATE INDEX IF NOT EXISTS idx_agent_decision_run ON agent_decision(run_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memory_decision ON agent_memory(decision_id);
`;

function readSchemaVersion(db: Database): number {
  try {
    const res = db.exec("SELECT value FROM meta WHERE key='schema_version'");
    const raw = res[0]?.values[0]?.[0];
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function migrate(db: Database): void {
  const existing = readSchemaVersion(db);
  db.exec(MIGRATION_1);
  db.exec(MIGRATION_2);
  db.exec(MIGRATION_3);
  db.exec(MIGRATION_4);
  db.exec(MIGRATION_5);
  db.exec(MIGRATION_6);
  db.exec(MIGRATION_7);
  db.exec(MIGRATION_8);
  db.exec(MIGRATION_9_DDL);
  for (const stmt of MIGRATION_9_ALTERS) safeAlter(db, stmt);
  for (const stmt of MIGRATION_10_ALTERS) safeAlter(db, stmt);
  db.exec(MIGRATION_11);
  if (existing < 12) db.exec(MIGRATION_12);
  if (existing < 13) for (const stmt of MIGRATION_13_ALTERS) safeAlter(db, stmt);
  if (existing < 14) for (const stmt of MIGRATION_14_ALTERS) safeAlter(db, stmt);
  if (existing < 15) {
    db.exec(MIGRATION_15_DDL);
    for (const stmt of MIGRATION_15_ALTERS) safeAlter(db, stmt);
  }
  if (existing < 16) {
    db.exec(MIGRATION_16_DDL);
    for (const stmt of MIGRATION_16_ALTERS) safeAlter(db, stmt);
  }
  db.exec(
    `DELETE FROM meta WHERE key='schema_version';` +
      `INSERT INTO meta (key, value) VALUES ('schema_version', '16');`
  );
}


