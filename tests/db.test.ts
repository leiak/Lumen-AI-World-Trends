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

  it('写入 schema_version = 16 且存在 agent_* 表与既有业务表', () => {
    const stmt = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`);
    const has = stmt.step();
    const row = stmt.getAsObject() as { value: string };
    stmt.free();
    expect(has).toBe(true);
    // P7：schema 从 v15 升到 v16（新增 checkpoint 表与 recovery_json 列）。
    expect(row.value).toBe('16');
    // P4：图草稿/发布状态、spec 摘要与 run 绑定摘要。
    const graphCols = db.exec(`PRAGMA table_info(agent_graph)`);
    const gcols = graphCols[0] ? graphCols[0].values.map((r) => r[1] as string) : [];
    expect(gcols).toContain('status');
    expect(gcols).toContain('digest');
    const runCols = db.exec(`PRAGMA table_info(agent_run)`);
    const rcols = runCols[0] ? runCols[0].values.map((r) => r[1] as string) : [];
    expect(rcols).toContain('graph_digest');
    // P5：审批挂起快照列（跨进程重启恢复）。
    expect(rcols).toContain('suspend_json');
    // P6：run 绑定 prompt 版本/摘要/快照列。
    expect(rcols).toContain('prompt_version');
    expect(rcols).toContain('prompt_digest');
    expect(rcols).toContain('prompt_json');
    // P7：断点续跑恢复元数据列。
    expect(rcols).toContain('recovery_json');
    // 验证 hot_score 列存在
    const colRes = db.exec(`PRAGMA table_info(source_article)`);
    const cols = colRes[0] ? colRes[0].values.map((r) => r[1] as string) : [];
    expect(cols).toContain('hot_score');
    for (const table of ['insight', 'causal_chain', 'stock_group', 'stock_alert']) {
      const res = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`);
      expect(res.length).toBeGreaterThan(0);
    }
    const agentTables = db.exec(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agent_graph','agent_run','agent_run_event','agent_node_result','agent_decision','agent_memory','agent_prompt_pack')`
    );
    const names = agentTables[0] ? agentTables[0].values.flat() : [];
    expect(names).toHaveLength(7);

    // P3：baseline_json 字段、insufficient 状态与 memory 唯一索引。
    const decisionCols = db.exec(`PRAGMA table_info(agent_decision)`);
    const dcols = decisionCols[0] ? decisionCols[0].values.map((r) => r[1] as string) : [];
    expect(dcols).toContain('baseline_json');
    const decisionSql = db.exec(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_decision'`
    )[0]?.values[0]?.[0] as string;
    expect(decisionSql).toContain('insufficient');
    const idx = db.exec(
      `SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_agent_memory_decision'`
    )[0]?.values[0]?.[0] as string;
    expect(idx).toContain('UNIQUE');
  });

  // P7：checkpoint 持久化表必须存在，且列/索引足以支撑 LangGraph 的
  // (thread_id, checkpoint_ns, checkpoint_id) 定位与并行 writes 排序。
  it('P7：存在 checkpoint 与 writes 表及必要列/索引', () => {
    const cpInfo = db.exec(`PRAGMA table_info(agent_run_checkpoint)`);
    const cpCols = cpInfo[0] ? cpInfo[0].values.map((r) => r[1] as string) : [];
    for (const c of [
      'run_id',
      'checkpoint_ns',
      'checkpoint_id',
      'parent_checkpoint_id',
      'serde_type',
      'checkpoint_json',
      'metadata_type',
      'metadata_json',
      'run_meta_json',
      'step',
      'created_at'
    ]) {
      expect(cpCols).toContain(c);
    }
    const pk = cpInfo[0]
      ? cpInfo[0].values.filter((r) => (r[5] as number) > 0).map((r) => r[1] as string)
      : [];
    expect(pk.sort()).toEqual(['checkpoint_id', 'checkpoint_ns', 'run_id'].sort());

    const wInfo = db.exec(`PRAGMA table_info(agent_run_checkpoint_write)`);
    const wCols = wInfo[0] ? wInfo[0].values.map((r) => r[1] as string) : [];
    for (const c of [
      'run_id',
      'checkpoint_ns',
      'checkpoint_id',
      'task_id',
      'idx',
      'channel',
      'serde_type',
      'value_json',
      'task_path'
    ]) {
      expect(wCols).toContain(c);
    }
    const wpk = wInfo[0]
      ? wInfo[0].values.filter((r) => (r[5] as number) > 0).map((r) => r[1] as string)
      : [];
    expect(wpk.sort()).toEqual(
      ['run_id', 'checkpoint_ns', 'checkpoint_id', 'task_id', 'idx'].sort()
    );

    const idxNames = db.exec(
      `SELECT name FROM sqlite_master WHERE type='index' AND name IN
        ('idx_agent_checkpoint_run','idx_agent_checkpoint_write_task')`
    )[0]?.values.flat() as string[] | undefined;
    expect(idxNames ?? []).toHaveLength(2);
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
