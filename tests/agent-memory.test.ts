import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import {
  computeBaseline,
  listMemoryView,
  loadMemoryContext,
  settleDecisionById,
  settleDueMemory
} from '../electron/main/agent/memory.js';
import type { MemoryBaseline, TrendRating } from '../shared/agent.js';

const AS_OF = '2026-01-01T00:00:00.000Z';
const DUE = '2026-01-08T00:00:00.000Z';

let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs();
});

function newDb(): Database {
  const db = new SQL.Database();
  migrate(db);
  return db;
}

function insertEntity(db: Database, id: string, name: string): void {
  const stmt = db.prepare(
    `INSERT INTO entity (id, name, name_en, type, lang) VALUES (?, ?, NULL, 'topic', 'zh')`
  );
  stmt.run([id, name]);
  stmt.free();
}

function addArticles(db: Database, articleIds: string[], entityId: string, at: string): void {
  const stmt = db.prepare(`INSERT INTO article_entity (article_id, entity_id, crawled_at) VALUES (?, ?, ?)`);
  for (const articleId of articleIds) stmt.run([articleId, entityId, at]);
  stmt.free();
}

interface DecisionSeed {
  id: string;
  subjectKey?: string;
  subjectLabel?: string;
  asOf?: string;
  rating?: TrendRating;
  horizonDays?: number;
  resolveAfter?: string;
  baseline?: MemoryBaseline | null;
  status?: string;
}

function insertDecision(db: Database, seed: DecisionSeed): void {
  const stmt = db.prepare(
    `INSERT INTO agent_decision
      (id, run_id, subject_key, subject_label, as_of, rating, confidence, horizon_days, thesis,
       key_risks_json, status, resolve_after, baseline_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0.6, ?, 'test thesis', '[]', ?, ?, ?, ?)`
  );
  stmt.run([
    seed.id,
    `run_${seed.id}`,
    seed.subjectKey ?? 'topic:China',
    seed.subjectLabel ?? 'China',
    seed.asOf ?? AS_OF,
    seed.rating ?? 'up',
    seed.horizonDays ?? 7,
    seed.status ?? 'pending',
    seed.resolveAfter ?? DUE,
    seed.baseline === undefined || seed.baseline === null
      ? null
      : JSON.stringify(seed.baseline),
    AS_OF
  ]);
  stmt.free();
}

function memoryCount(db: Database): number {
  const res = db.exec(`SELECT COUNT(*) AS n FROM agent_memory`);
  return Number(res[0]?.values[0]?.[0] ?? 0);
}

describe('记忆注入的时间正确性', () => {
  it('只注入 resolved_at 与 as_of 都不晚于 asOf 的教训', () => {
    const db = newDb();
    const stmt = db.prepare(
      `INSERT INTO agent_memory
        (id, decision_id, subject_key, as_of, resolved_at, rating, horizon_days, outcome_json, reflection, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 7, '{}', ?, ?)`
    );
    // 可用：在 asOf 之前已结算。
    stmt.run([
      'mem_ok',
      'dec_ok',
      'topic:China',
      '2025-12-20T00:00:00.000Z',
      '2025-12-25T00:00:00.000Z',
      'up',
      '可用教训：2025-12 的看多判断成立。',
      '2025-12-25T00:00:00.000Z'
    ]);
    // 不可用：窗口在 asOf 之后才结束。
    stmt.run([
      'mem_future_resolve',
      'dec_future_resolve',
      'topic:China',
      '2026-01-05T00:00:00.000Z',
      '2026-01-20T00:00:00.000Z',
      'up',
      '未来结算的教训不得注入。',
      '2026-01-20T00:00:00.000Z'
    ]);
    // 不可用：as_of 本身晚于 asOf（窗口还没开始）。
    stmt.run([
      'mem_future_asof',
      'dec_future_asof',
      'topic:China',
      '2026-01-15T00:00:00.000Z',
      '2026-01-22T00:00:00.000Z',
      'up',
      '未来起点的教训不得注入。',
      '2026-01-22T00:00:00.000Z'
    ]);
    // 不可用：超出 lookback 窗口。
    stmt.run([
      'mem_too_old',
      'dec_too_old',
      'topic:China',
      '2024-10-01T00:00:00.000Z',
      '2024-10-08T00:00:00.000Z',
      'up',
      '过旧教训默认不注入。',
      '2024-10-08T00:00:00.000Z'
    ]);
    stmt.free();

    const asOf = '2026-01-10T00:00:00.000Z';
    const { context, lessons } = loadMemoryContext(db, {
      asOf,
      subjectKey: 'topic:China',
      sameLimit: 5,
      otherLimit: 3,
      lookbackDays: 90
    });
    expect(lessons).toHaveLength(1);
    expect(lessons[0].memoryId).toBe('mem_ok');
    expect(context).toContain('可用教训');
    expect(context).not.toContain('未来结算的教训');
    expect(context).not.toContain('未来起点的教训');
    expect(context).not.toContain('过旧教训');
    expect(context).toContain(asOf);
    db.close();
  });

  it('无历史记录时返回空 lessons 与可读的空上下文，不报错', () => {
    const db = newDb();
    const { context, lessons } = loadMemoryContext(db, {
      asOf: AS_OF,
      subjectKey: 'topic:China'
    });
    expect(lessons).toEqual([]);
    expect(context).toContain('无');
    db.close();
  });
});

describe('结算口径与幂等', () => {
  function seedChinaCase(db: Database): MemoryBaseline {
    insertEntity(db, 'e_china', 'China');
    insertEntity(db, 'e_us', 'US');
    // 基准窗口 [2025-12-25, 2026-01-01]：China 6（前 3 后 3），US 1。
    addArticles(db, ['a1', 'a2', 'u1'], 'e_china', '2025-12-26T00:00:00.000Z');
    addArticles(db, ['a3', 'a4', 'a5'], 'e_china', '2025-12-30T00:00:00.000Z');
    addArticles(db, ['u2'], 'e_us', '2025-12-26T00:00:00.000Z');
    const baseline = computeBaseline(db, 'China', AS_OF, 7);
    expect(baseline.articleCount).toBe(6);
    expect(baseline.hotRank).toBe(1);

    // 结算窗口 [2026-01-01, 2026-01-08]：China 3（前 1 后 2），US 6 → China 排名第 2。
    addArticles(db, ['c1'], 'e_china', '2026-01-02T00:00:00.000Z');
    addArticles(db, ['c2', 'c3'], 'e_china', '2026-01-06T00:00:00.000Z');
    addArticles(
      db,
      ['v1', 'v2', 'v3', 'v4', 'v5', 'v6'],
      'e_us',
      '2026-01-04T00:00:00.000Z'
    );
    return baseline;
  }

  it('到期结算写入 outcome/reflection；重复结算幂等且不重复写入', () => {
    const db = newDb();
    const baseline = seedChinaCase(db);
    insertDecision(db, { id: 'd1', baseline });

    const first = settleDecisionById(db, () => {}, 'd1', { now: DUE });
    expect(first.status).toBe('settled');
    expect(memoryCount(db)).toBe(1);

    const res = db.exec(
      `SELECT status, outcome_json, reflection FROM agent_decision WHERE id='d1'`
    )[0].values[0];
    expect(res[0]).toBe('settled');
    const outcome = JSON.parse(res[1] as string) as {
      articleCount: number;
      hotRank: number;
      hotRankDelta: number;
      momentum: number;
      momentumDelta: number;
      verdict: string;
    };
    expect(outcome.articleCount).toBe(3);
    expect(outcome.hotRank).toBe(2);
    expect(outcome.hotRankDelta).toBe(-1);
    expect(outcome.momentum).toBe(2 - 1);
    expect(outcome.verdict).toBe('miss');
    expect(String(res[2])).toContain('落空');

    const second = settleDecisionById(db, () => {}, 'd1', { now: '2026-01-20T00:00:00.000Z' });
    expect(second.status).toBe('already_settled');
    expect(memoryCount(db)).toBe(1);
    const unchanged = db.exec(
      `SELECT resolved_at, outcome_json FROM agent_decision WHERE id='d1'`
    )[0].values[0];
    expect(unchanged[0]).toBe(DUE);
    expect(unchanged[1]).toBe(res[1]);
    db.close();
  });

  it('窗口未到期拒绝结算；扫描只处理到期记录', () => {
    const db = newDb();
    const baseline = seedChinaCase(db);
    insertDecision(db, { id: 'd_due', baseline, resolveAfter: DUE });
    insertDecision(db, {
      id: 'd_later',
      baseline,
      resolveAfter: '2026-02-01T00:00:00.000Z'
    });

    const notDue = settleDecisionById(db, () => {}, 'd_later', { now: DUE });
    expect(notDue.status).toBe('not_due');
    expect(memoryCount(db)).toBe(0);

    const scanned = settleDueMemory(db, () => {}, { now: DUE });
    expect(scanned.scanned).toBe(1);
    expect(scanned.settled).toBe(1);
    expect(scanned.details[0].decisionId).toBe('d_due');

    const again = settleDueMemory(db, () => {}, { now: DUE });
    expect(again.scanned).toBe(0);
    db.close();
  });

  it('数据不足标记 insufficient，且不计入命中率', () => {
    const db = newDb();
    // 没有任何实体数据：基准与结算窗口都不足。
    insertDecision(db, {
      id: 'd_insufficient',
      subjectKey: 'topic:Japan',
      subjectLabel: 'Japan',
      baseline: null
    });
    const res = settleDecisionById(db, () => {}, 'd_insufficient', { now: DUE });
    expect(res.status).toBe('insufficient');
    expect(memoryCount(db)).toBe(0);

    const row = db.exec(
      `SELECT status, outcome_json, reflection FROM agent_decision WHERE id='d_insufficient'`
    )[0].values[0];
    expect(row[0]).toBe('insufficient');
    expect((JSON.parse(row[1] as string) as { verdict: string }).verdict).toBe('inconclusive');
    expect(String(row[2])).toContain('insufficient');

    const view = listMemoryView(db);
    expect(view.stats.insufficient).toBe(1);
    expect(view.stats.settled).toBe(0);
    expect(view.stats.hitRate).toBe(0);
    expect(view.insufficient).toHaveLength(1);
    db.close();
  });

  it('review 决策不参与结算，未知记录返回 not_found', () => {
    const db = newDb();
    insertDecision(db, { id: 'd_review', rating: 'review', status: 'review' });
    const res = settleDecisionById(db, () => {}, 'd_review', { now: DUE });
    expect(res.status).toBe('not_settleable');
    expect(settleDecisionById(db, () => {}, 'missing', { now: DUE }).status).toBe('not_found');
    db.close();
  });
});

describe('命中率统计', () => {
  it('无记录时为 0 与空数组，而不是报错', () => {
    const db = newDb();
    const view = listMemoryView(db);
    expect(view.stats).toEqual({
      pending: 0,
      settled: 0,
      insufficient: 0,
      hits: 0,
      misses: 0,
      inconclusive: 0,
      hitRate: 0
    });
    expect(view.pending).toEqual([]);
    expect(view.settled).toEqual([]);
    expect(view.insufficient).toEqual([]);
    db.close();
  });

  it('有历史记录时按 hit/(hit+miss) 计算，inconclusive 不计入分母', () => {
    const db = newDb();
    const stmt = db.prepare(
      `INSERT INTO agent_memory
        (id, decision_id, subject_key, as_of, resolved_at, rating, horizon_days, outcome_json, reflection, created_at)
       VALUES (?, ?, 'topic:China', ?, ?, 'up', 7, ?, ?, ?)`
    );
    const rows: Array<[string, string, string]> = [
      ['m_hit', 'hit', '2025-12-01T00:00:00.000Z'],
      ['m_miss', 'miss', '2025-12-02T00:00:00.000Z'],
      ['m_incon', 'inconclusive', '2025-12-03T00:00:00.000Z']
    ];
    for (const [id, verdict, at] of rows) {
      stmt.run([
        id,
        `dec_${id}`,
        at,
        at,
        JSON.stringify({ verdict, hit: verdict === 'hit' ? true : verdict === 'miss' ? false : null }),
        `lesson ${id}`,
        at
      ]);
    }
    stmt.free();

    const view = listMemoryView(db);
    expect(view.stats.settled).toBe(3);
    expect(view.stats.hits).toBe(1);
    expect(view.stats.misses).toBe(1);
    expect(view.stats.inconclusive).toBe(1);
    expect(view.stats.hitRate).toBe(0.5);
    db.close();
  });
});
