import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { MockProvider, type AiProvider, type ChatMessage } from '../electron/main/ai/provider.js';
import { AgentRuntime } from '../electron/main/agent/runtime.js';
import { defaultGraphSpec, digestGraphSpec, stockGraphSpec, validateGraphSpec } from '../electron/main/agent/spec.js';
import { isTradingDay, nextTradingDays } from '../electron/main/stocks/calendar.js';
import { buildSampleCsv, importFactsCsv, listStockFacts, stockFactsView } from '../electron/main/stocks/facts.js';
import { checkDecisionNumbers } from '../electron/main/agent/fact-check.js';
import { listMemoryView, settleDecisionById } from '../electron/main/agent/memory.js';
import { STOCK_DEFAULT_BENCHMARK, STOCK_SUBJECT_PREFIX } from '../shared/stock-agent.js';
import type { AgentRunSummary, FinalDecision, StartRunRequest } from '../shared/agent.js';

const NOW = '2026-11-03T10:00:00.000Z';
const AS_OF = '2026-10-30T10:00:00.000Z';
const SYMBOL = 'sh600519';
const SUBJECT = { key: `${STOCK_SUBJECT_PREFIX}${SYMBOL}`, label: SYMBOL.toUpperCase(), kind: 'stock' as const };

let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs();
});

function newDb(): Database {
  const db = new SQL.Database();
  migrate(db);
  return db;
}

function expectOk<T>(res: { ok: true; data: T } | { ok: false; code: string; message: string }): T {
  if (!res.ok) throw new Error(`expected ok, got ${res.code}: ${res.message}`);
  return res.data;
}

function makeRuntime(
  db: Database,
  provider: AiProvider,
  now = NOW
): AgentRuntime {
  let i = 0;
  return new AgentRuntime({
    db,
    provider,
    mockProvider: new MockProvider(),
    persist: () => {},
    send: undefined,
    now: () => now,
    newRunId: () => {
      i += 1;
      return `run_stock_${i}`;
    }
  });
}

function request(overrides?: Partial<StartRunRequest>): StartRunRequest {
  return {
    graphId: 'stock-analysis',
    subject: SUBJECT,
    asOf: AS_OF,
    options: { forceMock: true },
    ...overrides
  };
}

function importSample(db: Database, opts?: { onlyMarket?: boolean }): number {
  const sample = buildSampleCsv(SYMBOL);
  const csv = opts?.onlyMarket
    ? sample.csv
        .split('\n')
        .filter((line, i) => i === 0 || (line.split(',')[1] === 'market' && line.length > 0))
        .join('\n')
    : sample.csv;
  const res = importFactsCsv(db, () => {}, { csv, symbol: SYMBOL }, AS_OF);
  return res.imported;
}

function insertOldRun(db: Database, id: string, kind: string): void {
  db.exec(
    `INSERT INTO agent_run
      (run_id, graph_id, graph_version, thread_id, status, subject_key, subject_label, subject_kind,
       as_of, started_at, config_json)
     VALUES (?, 'trend-analysis', 4, ?, 'completed', 'topic:China', 'China', ?, ?, ?, '{"forceMock":true}')`,
    [id, id, kind, NOW, NOW]
  );
}

function insertStockDecision(
  db: Database,
  seed: { id: string; rating: string; asOf: string; resolveAfter: string; baseline: unknown }
): void {
  db.exec(
    `INSERT INTO agent_decision
      (id, run_id, subject_key, subject_label, as_of, rating, confidence, horizon_days, thesis,
       key_risks_json, status, resolve_after, baseline_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0.6, 5, 'test thesis', '[]', 'pending', ?, ?, ?)`,
    [seed.id, `run_${seed.id}`, SUBJECT.key, SYMBOL.toUpperCase(), seed.asOf, seed.rating, seed.resolveAfter, JSON.stringify(seed.baseline), NOW]
  );
}

describe('M26 schema / 零回归', () => {
  it('v17 迁移是追加式：旧 run 保留，agent_run 放开 stock，新增 stock_fact', () => {
    const db = newDb();
    insertOldRun(db, 'run_old_event', 'event');
    // 模拟 v16 库：把版本改回 16 后再迁移，确认重建不会丢数据。
    db.exec(`UPDATE meta SET value='16' WHERE key='schema_version'`);
    migrate(db);
    const rows = db.exec(`SELECT run_id, subject_kind FROM agent_run WHERE run_id='run_old_event'`);
    expect(rows[0].values[0]).toEqual(['run_old_event', 'event']);
    insertOldRun(db, 'run_new_stock', 'stock');
    const stockRows = db.exec(`SELECT COUNT(*) FROM agent_run WHERE subject_kind='stock'`);
    expect(stockRows[0].values[0][0]).toBe(1);
    const factTable = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='stock_fact'`);
    expect(factTable[0]?.values[0][0]).toBe('stock_fact');
  });

  it('世界趋势默认图 v4 未被改动：不含 fact_check，校验通过且 digest 稳定', () => {
    const spec = defaultGraphSpec(NOW);
    expect(spec.id).toBe('trend-analysis');
    expect(spec.version).toBe(4);
    expect(spec.nodes.some((n) => n.type === 'fact_check')).toBe(false);
    expect(validateGraphSpec(spec).ok).toBe(true);
    // 零回归证据：默认图 digest 固定值（改动默认图会立刻让该断言失败）。
    expect(digestGraphSpec(spec)).toBe('93e039e96961e019373ddb867419ea637c20d278cbc0538bddef73c3e48bb642');
  });

  it('股票默认图 v1 校验通过，且 graph id 与趋势图隔离', () => {
    const spec = stockGraphSpec(NOW);
    expect(spec.id).toBe('stock-analysis');
    expect(spec.version).toBe(1);
    expect(validateGraphSpec(spec).ok).toBe(true);
    expect(spec.nodes.find((n) => n.id === 'fact_check')?.config).toMatchObject({
      type: 'fact_check'
    });
  });
});

describe('M26 事实层', () => {
  it('内置样例可导入，覆盖四层，严格 asOf 截断', () => {
    const db = newDb();
    const imported = importSample(db);
    expect(imported).toBeGreaterThan(0);

    const view = stockFactsView(db, SYMBOL, AS_OF);
    expect(view.layers.map((l) => [l.layer, l.status])).toEqual([
      ['market', 'ok'],
      ['fundamentals', 'ok'],
      ['disclosures', 'ok'],
      ['news', 'ok']
    ]);
    // asOf 之后的事实不可见（样例覆盖到 2026-12-15）。
    const later = stockFactsView(db, SYMBOL, '2026-12-15T23:59:59.000Z');
    expect(later.facts.length).toBeGreaterThan(view.facts.length);
    expect(view.facts.every((f) => f.effectiveAt <= '2026-10-30T10:00:00.000Z')).toBe(true);
  });

  it('只导入行情时，财报/公告/舆情显式标记为 missing', () => {
    const db = newDb();
    importSample(db, { onlyMarket: true });
    const view = stockFactsView(db, SYMBOL, AS_OF);
    const missing = view.layers.filter((l) => l.status === 'missing').map((l) => l.layer);
    expect(missing).toEqual(['fundamentals', 'disclosures', 'news']);
    expect(view.facts.every((f) => f.layer === 'market')).toBe(true);
  });

  it('publishedAt 晚于 asOf 的事实不可见（禁止未来数据泄漏）', () => {
    const db = newDb();
    importSample(db);
    const csv = [
      'symbol,layer,metric,value,unit,period,published_at,effective_at,source',
      `${SYMBOL},fundamentals,late_metric,999,%,2026Q3,2026-11-10T10:00:00.000Z,2026-09-30T00:00:00.000Z,test`
    ].join('\n');
    importFactsCsv(db, () => {}, { csv, symbol: SYMBOL }, AS_OF);
    // 生效日在 asOf 之前，但发布日在 asOf 之后 → 当时不可见。
    expect(listStockFacts(db, SYMBOL, AS_OF).some((f) => f.metric === 'late_metric')).toBe(false);
    expect(listStockFacts(db, SYMBOL, '2026-11-11T00:00:00.000Z').some((f) => f.metric === 'late_metric')).toBe(
      true
    );
  });

  it('A 股交易日历：周末/节假日休市，T+5 按交易日推进', () => {
    expect(isTradingDay('2026-10-30')).toBe(true);
    expect(isTradingDay('2026-10-31')).toBe(false);
    expect(isTradingDay('2026-10-01')).toBe(false);
    expect(nextTradingDays('2026-10-30', 5)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06'
    ]);
  });
});

describe('M26 数字闸门', () => {
  const baseDecision: FinalDecision = {
    rating: 'up',
    confidence: 0.6,
    horizonDays: 5,
    thesis: '本地事实显示净利润同比 18.4% [fact:fact_ok]',
    keyRisks: [],
    nextCheckAt: NOW,
    reviewRequired: false,
    stock: {
      factors: [
        {
          id: 'earnings_surprise',
          label: '业绩超预期',
          layer: 'fundamentals',
          contribution: 'positive',
          weight: 1,
          mechanism: '净利润同比 18.4% [fact:fact_ok]',
          factIds: ['fact_ok']
        }
      ],
      missingLayers: [],
      assumptions: [],
      magnitude: 'medium',
      benchmarkSymbol: STOCK_DEFAULT_BENCHMARK,
      referencedFactIds: ['fact_ok']
    }
  };
  const fact = {
    factId: 'fact_ok',
    symbol: SYMBOL,
    layer: 'fundamentals' as const,
    metric: 'net_profit_yoy',
    value: 18.4,
    valueText: null,
    unit: '%',
    period: '2026Q3',
    publishedAt: NOW,
    effectiveAt: NOW,
    source: 'test'
  };

  it('数字可匹配则通过', () => {
    const res = checkDecisionNumbers(baseDecision, [fact], 50);
    expect(res.ok).toBe(true);
    expect(res.unverifiedNumbers).toEqual([]);
  });

  it('未匹配数字判定失败（含不存在的 fact 引用）', () => {
    const bad: FinalDecision = {
      ...baseDecision,
      thesis: '净利润同比 99.9% [fact:fact_missing]',
      stock: baseDecision.stock
        ? { ...baseDecision.stock, referencedFactIds: ['fact_missing'] }
        : undefined
    };
    const res = checkDecisionNumbers(bad, [fact], 50);
    expect(res.ok).toBe(false);
    expect(res.unverifiedNumbers).toContain('99.9');
    expect(res.unverifiedNumbers).toContain('[fact:fact_missing]');
  });
});

describe('M26 股票图全链路（Mock）', () => {
  it('四维取证→辩论→裁决→事实核查→观察→风控→审批→完成', async () => {
    const db = newDb();
    importSample(db);
    const runtime = makeRuntime(db, new MockProvider());
    runtime.ensureDefaultGraph(stockGraphSpec(NOW));

    const started = expectOk(await runtime.startRun(request()));
    await runtime.waitForRun(started.runId);

    const paused = expectOk(runtime.getRun(started.runId));
    expect(paused.status).toBe('interrupted');
    const decision = paused.approval?.decision;
    expect(decision?.rating).toBe('up');
    expect(decision?.stock).toBeTruthy();
    expect(decision?.stock?.missingLayers).toEqual([]);
    expect(decision?.stock?.factors.length).toBeGreaterThan(0);
    const gate = paused.nodes.find((n) => n.nodeId === 'fact_check');
    expect(gate?.status).toBe('succeeded');
    expect((gate?.output as { ok?: boolean } | undefined)?.ok).toBe(true);

    const resumed = expectOk(
      await runtime.resumeRun({ runId: started.runId, resolution: { type: 'approve' } })
    );
    expect(resumed.status).toBe('running');
    await runtime.waitForRun(started.runId);
    const done = expectOk(runtime.getRun(started.runId));
    expect(done.status).toBe('completed');
    // 节点未重跑：judge 只有 1 次 completed。
    const judge = done.nodes.filter((n) => n.nodeId === 'judge' && n.status === 'succeeded');
    expect(judge).toHaveLength(1);
    // 运行列表按 graphId 隔离。
    const stockRuns = expectOk(runtime.listRuns({ limit: 10, graphId: 'stock-analysis' }));
    const trendRuns = expectOk(runtime.listRuns({ limit: 10, graphId: 'trend-analysis' }));
    expect(stockRuns.map((r: AgentRunSummary) => r.runId)).toContain(started.runId);
    expect(trendRuns.map((r: AgentRunSummary) => r.runId)).not.toContain(started.runId);
  });

  it('缺失维度降级：只有行情时仍跑完，missingLayers 显式标注', async () => {
    const db = newDb();
    importSample(db, { onlyMarket: true });
    const runtime = makeRuntime(db, new MockProvider());
    runtime.ensureDefaultGraph(stockGraphSpec(NOW));
    const started = expectOk(await runtime.startRun(request()));
    await runtime.waitForRun(started.runId);
    const paused = expectOk(runtime.getRun(started.runId));
    expect(paused.status).toBe('interrupted');
    expect(paused.approval?.decision?.stock?.missingLayers).toEqual([
      'fundamentals',
      'disclosures',
      'news'
    ]);
    // 缺失维度必须显式降级为 review，而不是照常给方向。
    expect(paused.approval?.decision?.rating).toBe('review');
    expect(paused.approval?.decision?.reviewReason).toBe('missing_dimension');
    const evidenceNodes = paused.nodes.filter((n) => ['fundamentals', 'disclosures', 'news'].includes(n.nodeId));
    expect(evidenceNodes.every((n) => n.status === 'succeeded')).toBe(true);
  });

  it('裁决数字未匹配 → 强制 review + reviewReason=unverified_number', async () => {
    class BadNumberProvider implements AiProvider {
      readonly name = 'bad-number';
      private mock = new MockProvider();
      async generate(messages: ChatMessage[]): Promise<string> {
        const system = messages.find((m) => m.role === 'system')?.content ?? '';
        if (system.includes('股票裁决者')) {
          return JSON.stringify({
            rating: 'up',
            confidence: 0.6,
            horizonDays: 5,
            thesis: '净利润同比 99.9% [fact:fact_missing]',
            keyRisks: [],
            nextCheckAt: NOW,
            reviewRequired: false,
            stock: {
              factors: [
                {
                  id: 'earnings_surprise',
                  label: '业绩超预期',
                  layer: 'fundamentals',
                  contribution: 'positive',
                  weight: 1,
                  mechanism: '净利润同比 99.9% [fact:fact_missing]',
                  factIds: ['fact_missing']
                }
              ],
              missingLayers: [],
              assumptions: [],
              magnitude: 'medium',
              benchmarkSymbol: STOCK_DEFAULT_BENCHMARK,
              referencedFactIds: ['fact_missing']
            }
          });
        }
        return this.mock.generate(messages);
      }
    }

    const db = newDb();
    importSample(db);
    const runtime = makeRuntime(db, new BadNumberProvider());
    runtime.ensureDefaultGraph(stockGraphSpec(NOW));
    const started = expectOk(await runtime.startRun(request({ options: { forceMock: false } })));
    await runtime.waitForRun(started.runId);
    const paused = expectOk(runtime.getRun(started.runId));
    expect(paused.status).toBe('interrupted');
    expect(paused.approval?.decision?.rating).toBe('review');
    expect(paused.approval?.decision?.reviewReason).toBe('unverified_number');
    const gate = paused.nodes.find((n) => n.nodeId === 'fact_check');
    expect((gate?.output as { ok?: boolean; unverifiedNumbers?: string[] } | undefined)?.ok).toBe(false);
  });
});

describe('M26 T+5 结算', () => {
  it('按 K 线序号结算 T+5 超额收益，T+1/T+20 仅诊断', () => {
    const db = newDb();
    importSample(db);
    const market = listStockFacts(db, SYMBOL, '2026-12-15T23:59:59.000Z').filter(
      (f) => f.layer === 'market' && f.metric === 'close'
    );
    const bench = listStockFacts(db, STOCK_DEFAULT_BENCHMARK, '2026-12-15T23:59:59.000Z').filter(
      (f) => f.layer === 'market' && f.metric === 'close'
    );
    const entryIdx = market.filter((f) => f.effectiveAt <= AS_OF).length - 1;
    const entry = market[entryIdx];
    const exit = market[entryIdx + 5];
    const benchEntry = bench.filter((f) => f.effectiveAt <= AS_OF).slice(-1)[0];
    const benchExitIdx = bench.findIndex((f) => f.factId === benchEntry.factId) + 5;
    const benchExit = bench[benchExitIdx];

    insertStockDecision(db, {
      id: 'dec_stock_1',
      rating: 'up',
      asOf: AS_OF,
      resolveAfter: '2026-11-06T23:59:59.000Z',
      baseline: {
        capturedAt: NOW,
        asOf: AS_OF,
        entryDate: entry.effectiveAt.slice(0, 10),
        entryClose: entry.value,
        benchmarkSymbol: STOCK_DEFAULT_BENCHMARK,
        benchmarkEntryClose: benchEntry.value
      }
    });

    const settled = settleDecisionById(db, () => {}, 'dec_stock_1', { now: '2026-11-20T00:00:00.000Z' });
    expect(settled.status).toBe('settled');

    const memory = listMemoryView(db).settled.find((m) => m.decisionId === 'dec_stock_1');
    expect(memory).toBeTruthy();
    const outcome = memory?.outcome?.stock;
    expect(outcome?.horizon).toBe('T+5');
    expect(outcome?.exitDate).toBe(exit.effectiveAt.slice(0, 10));
    expect(outcome?.exitClose).toBe(exit.value);
    const expectedStock = ((exit.value! - entry.value!) / entry.value!) * 100;
    const expectedBench = ((benchExit.value! - benchEntry.value!) / benchEntry.value!) * 100;
    expect(outcome?.stockReturnPct).toBeCloseTo(expectedStock, 3);
    expect(outcome?.benchmarkReturnPct).toBeCloseTo(expectedBench, 3);
    expect(outcome?.excessReturnPct).toBeCloseTo(expectedStock - expectedBench, 3);
    expect(outcome?.diagnostics.t1).not.toBeNull();
    expect(outcome?.verdict).toBe(expectedStock - expectedBench > 0 ? 'hit' : 'miss');
  });
});

describe('M26 命名空间隔离', () => {
  it('记忆面板按 scope 隔离，缺省保持旧行为', () => {
    const db = newDb();
    insertStockDecision(db, {
      id: 'dec_stock_scope',
      rating: 'up',
      asOf: AS_OF,
      resolveAfter: '2026-11-06T23:59:59.000Z',
      baseline: { asOf: AS_OF }
    });
    db.exec(
      `INSERT INTO agent_decision
        (id, run_id, subject_key, subject_label, as_of, rating, confidence, horizon_days, thesis,
         key_risks_json, status, resolve_after, baseline_json, created_at)
       VALUES ('dec_trend_scope', 'run_trend_scope', 'topic:China', 'China', ?, 'up', 0.6, 7,
               'trend thesis', '[]', 'pending', ?, '{}', ?)`,
      [AS_OF, '2026-11-06T23:59:59.000Z', NOW]
    );
    const stock = listMemoryView(db, 'stock');
    const trend = listMemoryView(db, 'trend');
    const all = listMemoryView(db);
    expect(stock.pending.map((d) => d.id)).toEqual(['dec_stock_scope']);
    expect(trend.pending.map((d) => d.id)).toEqual(['dec_trend_scope']);
    expect(all.pending.map((d) => d.id).sort()).toEqual(['dec_stock_scope', 'dec_trend_scope']);
  });

  it('股票图只接受 stock 主体，stock 主体也只能跑股票图', async () => {
    const runtime = makeRuntime(newDb(), new MockProvider());
    const wrongGraph = await runtime.startRun(request({ graphId: 'trend-analysis' }));
    expect(wrongGraph.ok).toBe(false);
    if (!wrongGraph.ok) expect(wrongGraph.code).toBe('E_VALIDATION');

    const wrongSubject = await runtime.startRun(
      request({ subject: { key: 'topic:China', label: 'China', kind: 'topic' } })
    );
    expect(wrongSubject.ok).toBe(false);
    if (!wrongSubject.ok) expect(wrongSubject.code).toBe('E_VALIDATION');
  });
});
