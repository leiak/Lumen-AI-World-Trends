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
import { AGENT_PROMPT_ROLES, type AgentPromptsSaveRequest, type AgentRunSummary, type FinalDecision, type StartRunRequest } from '../shared/agent.js';
import { DEFAULT_PROMPT_TEMPLATES, STOCK_PROMPT_TEMPLATES } from '../electron/main/agent/prompt-policy.js';

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

describe('M26 prompt 命名空间与股票编辑器作用域隔离', () => {
  const TREND_DIGEST = '93e039e96961e019373ddb867419ea637c20d278cbc0538bddef73c3e48bb642';

  it('trend-analysis 默认图 digest 未变（零回归基线）', () => {
    expect(digestGraphSpec(defaultGraphSpec(NOW))).toBe(TREND_DIGEST);
  });

  it('股票 prompt 保存不改变智能体页签 active 包', () => {
    const runtime = makeRuntime(newDb(), new MockProvider());
    const trendBefore = expectOk(runtime.getPrompts({ graphId: 'trend-analysis' })).pack;
    expect(trendBefore.graphId).toBe('trend-analysis');
    expect(trendBefore.version).toBe(0);

    const stockBefore = expectOk(runtime.getPrompts({ graphId: 'stock-analysis' })).pack;
    expect(stockBefore.graphId).toBe('stock-analysis');
    expect(stockBefore.version).toBe(0);

    const stockSaved = expectOk(
      runtime.savePrompts({
        graphId: 'stock-analysis',
        prompts: { evidence: 'STOCK-SCOPED：围绕 {{subject.label}} 取证。' }
      })
    ).pack;
    expect(stockSaved.graphId).toBe('stock-analysis');
    expect(stockSaved.version).toBeGreaterThan(0);

    const trendAfter = expectOk(runtime.getPrompts({ graphId: 'trend-analysis' })).pack;
    expect(trendAfter.version).toBe(trendBefore.version);
    expect(trendAfter.digest).toBe(trendBefore.digest);
    expect(trendAfter.prompts).toEqual({});

    const stockAfter = expectOk(runtime.getPrompts({ graphId: 'stock-analysis' })).pack;
    expect(stockAfter.version).toBe(stockSaved.version);
    expect(stockAfter.prompts.evidence).toContain('STOCK-SCOPED');
  });

  it('股票与趋势默认模板按作用域独立，保存默认文案不会在对方侧产生 override', () => {
    const runtime = makeRuntime(newDb(), new MockProvider());
    const trend = expectOk(runtime.getPrompts({ graphId: 'trend-analysis' })).pack;
    const stock = expectOk(runtime.getPrompts({ graphId: 'stock-analysis' })).pack;

    // 每个角色的默认文案都属于各自作用域，且互不相同。
    for (const role of AGENT_PROMPT_ROLES) {
      expect(trend.defaults[role]).toBe(DEFAULT_PROMPT_TEMPLATES[role]);
      expect(stock.defaults[role]).toBe(STOCK_PROMPT_TEMPLATES[role]);
      expect(stock.defaults[role]).not.toBe(trend.defaults[role]);
    }

    // 保存股票默认文案：股票侧 isDefault 且无 prompts；趋势侧无任何 override。
    const stockDefaultSaved = expectOk(
      runtime.savePrompts({ graphId: 'stock-analysis', prompts: { ...STOCK_PROMPT_TEMPLATES } })
    ).pack;
    expect(stockDefaultSaved.isDefault).toBe(true);
    expect(stockDefaultSaved.prompts).toEqual({});
    expect(expectOk(runtime.getPrompts({ graphId: 'trend-analysis' })).pack.prompts).toEqual({});

    // 保存趋势默认文案：趋势侧无 override，不误判成股票文案。
    const trendDefaultSaved = expectOk(
      runtime.savePrompts({ graphId: 'trend-analysis', prompts: { ...DEFAULT_PROMPT_TEMPLATES } })
    ).pack;
    expect(trendDefaultSaved.isDefault).toBe(true);
    expect(trendDefaultSaved.prompts).toEqual({});
    expect(expectOk(runtime.getPrompts({ graphId: 'stock-analysis' })).pack.isDefault).toBe(true);

    // 反向误判检查：趋势默认 judge 写入股票命名空间，应当视为 override（不是股票默认）。
    const crossScope = expectOk(
      runtime.savePrompts({
        graphId: 'stock-analysis',
        prompts: { judge: DEFAULT_PROMPT_TEMPLATES.judge }
      })
    ).pack;
    expect(crossScope.prompts.judge).toBe(DEFAULT_PROMPT_TEMPLATES.judge);
    expect(expectOk(runtime.getPrompts({ graphId: 'trend-analysis' })).pack.prompts).toEqual({});
  });

  it('未知 prompt 命名空间被拒绝，不会误写全局包', () => {
    const runtime = makeRuntime(newDb(), new MockProvider());
    const get = runtime.getPrompts({ graphId: 'unknown-graph' });
    expect(get.ok).toBe(false);
    const save = runtime.savePrompts({ graphId: 'unknown-graph', prompts: { final: 'X' } });
    expect(save.ok).toBe(false);
    if (!save.ok) expect(save.code).toBe('E_VALIDATION');
    expect(expectOk(runtime.getPrompts({ graphId: 'trend-analysis' })).pack.version).toBe(0);
  });

  it('空/空白/缺失 graphId 不会静默落到 trend-analysis', () => {
    const runtime = makeRuntime(newDb(), new MockProvider());
    for (const graphId of ['', '   ', null as unknown as string, undefined]) {
      const get = runtime.getPrompts({ graphId } as { graphId: string });
      expect(get.ok).toBe(false);
      if (!get.ok) expect(get.code).toBe('E_VALIDATION');
      const save = runtime.savePrompts({ graphId, prompts: { final: 'X' } } as {
        graphId: string;
        prompts: { final: string };
      });
      expect(save.ok).toBe(false);
      if (!save.ok) expect(save.code).toBe('E_VALIDATION');
    }
    // IPC 完全不带 payload 时同样拒绝。
    expect(runtime.getPrompts().ok).toBe(false);
    expect(
      runtime.savePrompts({ prompts: { final: 'X' } } as unknown as AgentPromptsSaveRequest).ok
    ).toBe(false);
    expect(runtime.restoreDefaultGraph().ok).toBe(false);
    expect(expectOk(runtime.getPrompts({ graphId: 'trend-analysis' })).pack.version).toBe(0);
  });

  it('股票 run 绑定股票 active 包；改股票 prompt 后旧 run 回放仍用启动时快照', async () => {
    const db = newDb();
    importSample(db);
    const runtime = makeRuntime(db, new MockProvider());
    runtime.ensureDefaultGraph(stockGraphSpec(NOW));

    const packA = expectOk(
      runtime.savePrompts({
        graphId: 'stock-analysis',
        prompts: { evidence: 'STOCK-A：围绕 {{subject.label}} 取证。' }
      })
    ).pack;
    const started = expectOk(await runtime.startRun(request()));
    await runtime.waitForRun(started.runId);
    const paused = expectOk(runtime.getRun(started.runId));
    expect(paused.prompt?.version).toBe(packA.version);
    expect(paused.prompt?.prompts.evidence).toContain('STOCK-A');

    const packB = expectOk(
      runtime.savePrompts({
        graphId: 'stock-analysis',
        prompts: { evidence: 'STOCK-B：围绕 {{subject.label}} 取证。' }
      })
    ).pack;
    expect(packB.version).toBeGreaterThan(packA.version);

    const replay = expectOk(runtime.getRun(started.runId));
    expect(replay.status).toBe('interrupted');
    expect(replay.prompt?.version).toBe(packA.version);
    expect(replay.prompt?.digest).toBe(packA.digest);
    expect(replay.prompt?.prompts.evidence).toContain('STOCK-A');
    expect(replay.prompt?.prompts.evidence).not.toContain('STOCK-B');

    // 审批恢复仍用运行启动时的快照，不被中途编辑影响。
    expectOk(
      await runtime.resumeRun({ runId: started.runId, resolution: { type: 'approve' } })
    );
    await runtime.waitForRun(started.runId);
    const done = expectOk(runtime.getRun(started.runId));
    expect(done.status).toBe('completed');
    expect(done.prompt?.version).toBe(packA.version);
    expect(done.prompt?.prompts.evidence).toContain('STOCK-A');
    expect(done.prompt?.prompts.evidence).not.toContain('STOCK-B');

    // 新 run 才绑定当前 active（STOCK-B）。
    const started2 = expectOk(await runtime.startRun(request()));
    await runtime.waitForRun(started2.runId);
    const next = expectOk(runtime.getRun(started2.runId));
    expect(next.prompt?.version).toBe(packB.version);
    expect(next.prompt?.prompts.evidence).toContain('STOCK-B');

    // 智能体页签的 active 包始终未被污染。
    expect(expectOk(runtime.getPrompts({ graphId: 'trend-analysis' })).pack.version).toBe(0);
  });

  it('股票图编辑只产生股票版本；trend-analysis active 图不变', () => {
    const runtime = makeRuntime(newDb(), new MockProvider());
    runtime.ensureDefaultGraph(defaultGraphSpec(NOW));
    runtime.ensureDefaultGraph(stockGraphSpec(NOW));

    const trendSpec = expectOk(runtime.getGraph('trend-analysis'));
    const trendDigest = digestGraphSpec(trendSpec);
    expect(trendDigest).toBe(TREND_DIGEST);

    const stockSpec = expectOk(runtime.getGraph('stock-analysis'));
    const saved = expectOk(
      runtime.saveGraph({ spec: { ...stockSpec, name: `${stockSpec.name}·编辑版` }, publish: true })
    );
    expect(saved.graphId).toBe('stock-analysis');
    expect(saved.version).toBe(stockSpec.version + 1);

    const stockNow = expectOk(runtime.getGraph('stock-analysis'));
    expect(stockNow.version).toBe(saved.version);
    expect(stockNow.name).toContain('编辑版');

    const trendNow = expectOk(runtime.getGraph('trend-analysis'));
    expect(trendNow.version).toBe(trendSpec.version);
    expect(digestGraphSpec(trendNow)).toBe(trendDigest);
  });

  it('股票图恢复默认只影响股票命名空间', () => {
    const runtime = makeRuntime(newDb(), new MockProvider());
    runtime.ensureDefaultGraph(defaultGraphSpec(NOW));
    runtime.ensureDefaultGraph(stockGraphSpec(NOW));
    const stockSpec = expectOk(runtime.getGraph('stock-analysis'));
    expectOk(
      runtime.saveGraph({ spec: { ...stockSpec, name: `${stockSpec.name}·编辑版` }, publish: true })
    );

    const restored = expectOk(runtime.restoreDefaultGraph('stock-analysis'));
    expect(restored.graphId).toBe('stock-analysis');
    expect(restored.version).toBe(stockSpec.version);
    expect(restored.isActive).toBe(true);
    expect(restored.spec.nodes).toEqual(stockGraphSpec(NOW).nodes);
    expect(restored.spec.edges).toEqual(stockGraphSpec(NOW).edges);

    const trendNow = expectOk(runtime.getGraph('trend-analysis'));
    expect(digestGraphSpec(trendNow)).toBe(TREND_DIGEST);
  });
});
