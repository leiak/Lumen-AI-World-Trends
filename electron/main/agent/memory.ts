import type { Database } from 'sql.js';
import type {
  AgentSubject,
  DecisionStatus,
  FinalDecision,
  MemoryBaseline,
  MemoryDecisionView,
  MemoryInjection,
  MemoryListResponse,
  MemoryOutcome,
  MemoryRecord,
  MemorySettleDetail,
  MemorySettleResponse,
  MemoryStats,
  TrendRating
} from '../../../shared/agent.js';
import type { StockBaseline, StockFact, StockOutcome } from '../../../shared/stock-agent.js';
import { STOCK_DEFAULT_BENCHMARK, STOCK_SUBJECT_PREFIX } from '../../../shared/stock-agent.js';
import { listStockFacts } from '../stocks/facts.js';
import { dateOnly, tPlusSettleAfter } from '../stocks/calendar.js';

const DAY_MS = 86_400_000;

/** 默认结算窗口与最少样本；可在 settleDueMemory 的 options 中覆盖。 */
export const DEFAULT_HORIZON_DAYS = 7;
export const DEFAULT_MIN_ARTICLES = 3;

export interface SettleOptions {
  now?: string;
  minArticles?: number;
  windowDays?: number;
}

interface WindowMetrics {
  windowStart: string;
  windowEnd: string;
  articleCount: number;
  hotRank: number | null;
  momentum: number;
}

function isoTime(value: string): number {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function rows(db: Database, sql: string, params: Array<string | number> = []): Array<Record<string, unknown>> {
  const res = db.exec(sql, params);
  if (res.length === 0) return [];
  const { columns, values } = res[0];
  return values.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
}

function scalar(db: Database, sql: string, params: Array<string | number> = []): unknown {
  return rows(db, sql, params)[0]?.value;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function clampWindowDays(value: number | undefined): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_HORIZON_DAYS;
  return Math.min(30, Math.max(1, n));
}

/** lookback 可长于结算窗口（最多 365 天），与 windowDays 的 30 天上限分开。 */
function clampLookbackDays(value: number | undefined): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return 90;
  return Math.min(365, Math.max(1, n));
}

/** 话题在 [start, end] 内的文章量、排名与动量；结束时间严格封顶，避免未来数据。 */
export function computeWindowMetrics(
  db: Database,
  subjectLabel: string,
  endIso: string,
  windowDays: number
): WindowMetrics {
  const days = clampWindowDays(windowDays);
  const endMs = isoTime(endIso);
  const startMs = endMs - days * DAY_MS;
  const windowStart = toIso(startMs);
  const windowEnd = toIso(endMs);

  const subjectCount = Number(
    scalar(
      db,
      `SELECT COUNT(*) AS value FROM article_entity ae
       JOIN entity e ON e.id = ae.entity_id
       WHERE e.name = ? AND ae.crawled_at >= ? AND ae.crawled_at <= ?`,
      [subjectLabel, windowStart, windowEnd]
    ) ?? 0
  );

  let hotRank: number | null = null;
  if (subjectCount > 0) {
    const counts = rows(
      db,
      `SELECT entity_id, COUNT(*) AS c FROM article_entity
       WHERE crawled_at >= ? AND crawled_at <= ? GROUP BY entity_id`,
      [windowStart, windowEnd]
    ).map((r) => Number(r.c ?? 0));
    const greater = counts.filter((c) => c > subjectCount).length;
    hotRank = greater + 1;
  }

  const bucketMs = Math.max(1, (endMs - startMs) / 8);
  let firstHalf = 0;
  let secondHalf = 0;
  for (let i = 0; i < 8; i++) {
    const bStart = toIso(startMs + i * bucketMs);
    const bEnd = i === 7 ? windowEnd : toIso(startMs + (i + 1) * bucketMs);
    const c = Number(
      scalar(
        db,
        `SELECT COUNT(*) AS value FROM article_entity ae
         JOIN entity e ON e.id = ae.entity_id
         WHERE e.name = ? AND ae.crawled_at >= ? AND ae.crawled_at < ?`,
        [subjectLabel, bStart, bEnd]
      ) ?? 0
    );
    if (i < 4) firstHalf += c;
    else secondHalf += c;
  }

  return {
    windowStart,
    windowEnd,
    articleCount: subjectCount,
    hotRank,
    momentum: secondHalf - firstHalf
  };
}

/** 决策时基准：使用 asOf 及之前的 7 天窗口。 */
export function computeBaseline(
  db: Database,
  subjectLabel: string,
  asOf: string,
  windowDays = DEFAULT_HORIZON_DAYS
): MemoryBaseline {
  const m = computeWindowMetrics(db, subjectLabel, asOf, windowDays);
  return {
    capturedAt: new Date().toISOString(),
    asOf,
    windowDays: clampWindowDays(windowDays),
    articleCount: m.articleCount,
    hotRank: m.hotRank,
    momentum: m.momentum
  };
}

/** 完成/驳回后补齐待结算记录所需的基准快照；review 不进入结算。 */
export function archiveDecisionBaseline(
  db: Database,
  persist: () => void,
  input: {
    runId: string;
    subject: AgentSubject;
    asOf: string;
    decision: FinalDecision;
  }
): void {
  if (input.decision.rating === 'review') return;
  if (input.subject.kind === 'stock') {
    archiveStockBaseline(db, persist, input);
    return;
  }
  const windowDays = clampWindowDays(input.decision.horizonDays);
  const baseline = computeBaseline(db, input.subject.label, input.asOf, windowDays);
  const resolveAfter =
    isoTime(input.decision.nextCheckAt) > isoTime(input.asOf)
      ? input.decision.nextCheckAt
      : toIso(isoTime(input.asOf) + windowDays * DAY_MS);
  db.exec(
    `UPDATE agent_decision SET baseline_json = ?, resolve_after = ?
     WHERE run_id = ? AND status = 'pending'`,
    [JSON.stringify(baseline), resolveAfter, input.runId]
  );
  persist();
}

function stockSymbolOfKey(subjectKey: string): string {
  return subjectKey.startsWith(STOCK_SUBJECT_PREFIX)
    ? subjectKey.slice(STOCK_SUBJECT_PREFIX.length)
    : subjectKey;
}

function closeSeries(facts: StockFact[]): StockFact[] {
  return facts.filter((f) => f.layer === 'market' && f.metric === 'close' && typeof f.value === 'number');
}

function lastAtOrBefore(facts: StockFact[], date: string): StockFact | null {
  const cutoff = dateOnly(date);
  let found: StockFact | null = null;
  for (const f of facts) {
    if (dateOnly(f.effectiveAt) <= cutoff) found = f;
    else break;
  }
  return found;
}

function indexAtOrBefore(facts: StockFact[], date: string): number {
  const cutoff = dateOnly(date);
  let idx = -1;
  for (let i = 0; i < facts.length; i++) {
    if (dateOnly(facts[i].effectiveAt) <= cutoff) idx = i;
    else break;
  }
  return idx;
}

/** M26：股票基准快照。结算触发时间按 asOf 之后的第 5 个交易日（自然日上界）。 */
function archiveStockBaseline(
  db: Database,
  persist: () => void,
  input: { runId: string; subject: AgentSubject; asOf: string; decision: FinalDecision }
): void {
  const symbol = stockSymbolOfKey(input.subject.key);
  const market = closeSeries(listStockFacts(db, symbol, input.asOf));
  const entry = market.length > 0 ? market[market.length - 1] : null;
  const benchmarkFacts = closeSeries(listStockFacts(db, STOCK_DEFAULT_BENCHMARK, input.asOf));
  const benchEntry = benchmarkFacts.length > 0 ? benchmarkFacts[benchmarkFacts.length - 1] : null;
  const baseline: StockBaseline = {
    capturedAt: new Date().toISOString(),
    asOf: input.asOf,
    entryDate: entry ? dateOnly(entry.effectiveAt) : null,
    entryClose: entry && typeof entry.value === 'number' ? entry.value : null,
    benchmarkSymbol: STOCK_DEFAULT_BENCHMARK,
    benchmarkEntryClose: benchEntry && typeof benchEntry.value === 'number' ? benchEntry.value : null
  };
  const resolveAfter = tPlusSettleAfter(input.asOf, 5);
  db.exec(
    `UPDATE agent_decision SET baseline_json = ?, resolve_after = ?
     WHERE run_id = ? AND status = 'pending'`,
    [JSON.stringify(baseline), resolveAfter, input.runId]
  );
  persist();
}

function judgeStockReturn(
  rating: TrendRating,
  excessPct: number
): { hit: boolean; reason: string } {
  if (rating === 'neutral') {
    const hit = Math.abs(excessPct) <= 2;
    return {
      hit,
      reason: `T+5 相对基准超额收益 ${excessPct.toFixed(2)}%，中性判断${hit ? '成立（未显著偏离基准）' : '落空（显著偏离基准）'}`
    };
  }
  const bullish = rating === 'up' || rating === 'strong_up';
  const hit = bullish ? excessPct > 0 : excessPct < 0;
  return {
    hit,
    reason: `T+5 相对基准超额收益 ${excessPct.toFixed(2)}%，${bullish ? '看多' : '看空'}判断${hit ? '命中' : '落空'}`
  };
}

function pct(a: number, b: number): number {
  return Number((((b - a) / a) * 100).toFixed(4));
}

/** M26：股票结算 —— 主口径 T+5（按 K 线序号），T+1/T+20 仅诊断。 */
function settleStockDecision(
  db: Database,
  persist: () => void,
  row: DecisionRow,
  now: string
): MemorySettleDetail {
  const symbol = stockSymbolOfKey(row.subject_key);
  const baseline = parseJson<StockBaseline | undefined>(row.baseline_json, undefined);
  const market = closeSeries(listStockFacts(db, symbol, now));
  const bench = closeSeries(listStockFacts(db, STOCK_DEFAULT_BENCHMARK, now));
  const entryDate = baseline?.entryDate ?? null;

  const insufficient = (reason: string): MemorySettleDetail => {
    const outcome: MemoryOutcome = {
      windowStart: row.as_of,
      windowEnd: now,
      articleCount: 0,
      hotRank: null,
      momentum: 0,
      articleDelta: 0,
      hotRankDelta: null,
      momentumDelta: 0,
      verdict: 'inconclusive',
      hit: null,
      reason,
      stock: {
        horizon: 'T+5',
        entryDate: entryDate ?? '',
        exitDate: null,
        entryClose: baseline?.entryClose ?? null,
        exitClose: null,
        stockReturnPct: null,
        benchmarkSymbol: baseline?.benchmarkSymbol ?? STOCK_DEFAULT_BENCHMARK,
        benchmarkReturnPct: null,
        excessReturnPct: null,
        verdict: 'inconclusive',
        diagnostics: { t1: null, t20: null },
        reason
      }
    };
    const reflection = `无法结算「${row.subject_label}」：${reason}。已标记 insufficient，不计入命中率。`;
    db.exec(
      `UPDATE agent_decision SET status = 'insufficient', resolved_at = ?, outcome_json = ?, reflection = ?
       WHERE id = ? AND status = 'pending'`,
      [now, JSON.stringify(outcome), reflection, row.id]
    );
    persist();
    return { decisionId: row.id, subjectKey: row.subject_key, status: 'insufficient', message: reason };
  };

  if (!baseline || baseline.entryClose === null || !entryDate) {
    return insufficient('缺少股票基准快照（决策时没有可用收盘价）');
  }
  const entryIdx = indexAtOrBefore(market, entryDate);
  if (entryIdx < 0) return insufficient('结算窗口内找不到入场日收盘价');
  const exitIdx = entryIdx + 5;
  if (exitIdx >= market.length) {
    return insufficient(`T+5 交易日数据不足（仅 ${market.length - entryIdx - 1} 个后续收盘价）`);
  }
  const exit = market[exitIdx];
  const entryClose = Number(baseline.entryClose);
  const exitClose = Number(exit.value);
  const stockReturnPct = pct(entryClose, exitClose);

  const benchEntry = lastAtOrBefore(bench, entryDate);
  const benchIdx = benchEntry ? indexAtOrBefore(bench, entryDate) : -1;
  const benchExitIdx = benchIdx >= 0 ? benchIdx + 5 : -1;
  const benchExit = benchExitIdx >= 0 && benchExitIdx < bench.length ? bench[benchExitIdx] : null;
  const benchmarkReturnPct =
    benchEntry && benchExit && typeof benchEntry.value === 'number' && typeof benchExit.value === 'number'
      ? pct(benchEntry.value, benchExit.value)
      : null;
  const excessReturnPct = benchmarkReturnPct === null ? null : Number((stockReturnPct - benchmarkReturnPct).toFixed(4));

  const t1Idx = entryIdx + 1;
  const t20Idx = entryIdx + 20;
  const t1 = t1Idx < market.length ? pct(entryClose, Number(market[t1Idx].value)) : null;
  const t20 = t20Idx < market.length ? pct(entryClose, Number(market[t20Idx].value)) : null;

  if (excessReturnPct === null) {
    return insufficient('基准（sh000300）T+5 收盘价缺失，无法计算超额收益');
  }

  const judged = judgeStockReturn(row.rating, excessReturnPct);
  const outcome: StockOutcome = {
    horizon: 'T+5',
    entryDate,
    exitDate: dateOnly(exit.effectiveAt),
    entryClose,
    exitClose,
    stockReturnPct,
    benchmarkSymbol: baseline.benchmarkSymbol ?? STOCK_DEFAULT_BENCHMARK,
    benchmarkReturnPct,
    excessReturnPct,
    verdict: judged.hit ? 'hit' : 'miss',
    diagnostics: { t1, t20 },
    reason: judged.reason
  };
  const memoryOutcome: MemoryOutcome = {
    windowStart: row.as_of,
    windowEnd: outcome.exitDate ?? now,
    articleCount: 0,
    hotRank: null,
    momentum: 0,
    articleDelta: 0,
    hotRankDelta: null,
    momentumDelta: 0,
    verdict: judged.hit ? 'hit' : 'miss',
    hit: judged.hit,
    reason: judged.reason,
    stock: outcome
  };
  const reflection =
    `在 ${row.as_of} 对「${row.subject_label}」给出 ${row.rating}（T+5 交易日窗口）。` +
    `结算：${outcome.entryDate} 收盘 ${outcome.entryClose} → ${outcome.exitDate} 收盘 ${outcome.exitClose}，` +
    `个股 ${stockReturnPct.toFixed(2)}%，基准 ${benchmarkReturnPct === null ? '—' : benchmarkReturnPct.toFixed(2)}%，超额 ${excessReturnPct.toFixed(2)}%。` +
    `判为${judged.hit ? '命中' : '落空'}。`;
  const existingMemory = Number(
    scalar(db, `SELECT COUNT(*) AS value FROM agent_memory WHERE decision_id = ?`, [row.id]) ?? 0
  );
  if (existingMemory > 0) {
    return { decisionId: row.id, subjectKey: row.subject_key, status: 'already_settled', message: '记忆已存在，幂等跳过' };
  }
  const memoryId = `mem_${row.id}`;
  db.exec(
    `INSERT OR IGNORE INTO agent_memory
      (id, decision_id, subject_key, as_of, resolved_at, rating, horizon_days, outcome_json, reflection, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      memoryId,
      row.id,
      row.subject_key,
      row.as_of,
      now,
      row.rating,
      5,
      JSON.stringify(memoryOutcome),
      reflection,
      now
    ]
  );
  db.exec(
    `UPDATE agent_decision SET status = 'settled', resolved_at = ?, outcome_json = ?, reflection = ?
     WHERE id = ? AND status = 'pending'`,
    [now, JSON.stringify(memoryOutcome), reflection, row.id]
  );
  persist();
  return {
    decisionId: row.id,
    subjectKey: row.subject_key,
    status: 'settled',
    message: judged.hit ? '结算完成：命中' : '结算完成：落空'
  };
}

interface DecisionRow extends Record<string, unknown> {
  id: string;
  run_id: string;
  subject_key: string;
  subject_label: string;
  as_of: string;
  rating: TrendRating;
  confidence: number;
  horizon_days: number;
  thesis: string;
  status: DecisionStatus;
  resolve_after: string | null;
  resolved_at: string | null;
  outcome_json: string | null;
  reflection: string | null;
  baseline_json: string | null;
  created_at: string;
}

function decisionRows(db: Database, where: string, params: Array<string | number> = []): DecisionRow[] {
  return rows(db, `SELECT * FROM agent_decision ${where}`, params) as unknown as DecisionRow[];
}

function toDecisionView(row: DecisionRow): MemoryDecisionView {
  return {
    id: row.id,
    runId: row.run_id,
    subjectKey: row.subject_key,
    subjectLabel: row.subject_label,
    asOf: row.as_of,
    rating: row.rating,
    horizonDays: row.horizon_days,
    resolveAfter: row.resolve_after ?? row.as_of,
    status: row.status,
    baseline: parseJson<MemoryBaseline | undefined>(row.baseline_json, undefined),
    outcome: parseJson<MemoryOutcome | undefined>(row.outcome_json, undefined),
    reflection: row.reflection ?? undefined,
    resolvedAt: row.resolved_at ?? undefined,
    createdAt: row.created_at
  };
}

function memoryRows(db: Database, filter = ''): MemoryRecord[] {
  return rows(db, `SELECT * FROM agent_memory ${filter} ORDER BY resolved_at DESC`).map((r) => ({
    id: String(r.id),
    decisionId: String(r.decision_id),
    subjectKey: String(r.subject_key),
    asOf: String(r.as_of),
    resolvedAt: String(r.resolved_at),
    rating: r.rating as TrendRating,
    horizonDays: Number(r.horizon_days),
    outcome: parseJson<MemoryOutcome>(r.outcome_json, {
      windowStart: String(r.as_of),
      windowEnd: String(r.resolved_at),
      articleCount: 0,
      hotRank: null,
      momentum: 0,
      articleDelta: 0,
      hotRankDelta: null,
      momentumDelta: 0,
      verdict: 'inconclusive',
      hit: null,
      reason: 'missing_outcome'
    }),
    reflection: String(r.reflection),
    createdAt: String(r.created_at)
  }));
}

/**
 * 记忆作用域：trend 为原有智能体口径（topic/country/event），stock 为股票口径。
 * 不传时保持旧行为（全量返回），供旧调用方兼容。
 */
export type MemoryScope = 'trend' | 'stock';

function scopeFilter(scope?: MemoryScope): string {
  if (scope === 'stock') return `subject_key LIKE 'stock:%'`;
  if (scope === 'trend') return `subject_key NOT LIKE 'stock:%'`;
  return '';
}

function andWhere(base: string, extra: string): string {
  if (!extra) return base;
  return `${base} AND ${extra}`;
}

export function listMemoryView(db: Database, scope?: MemoryScope): MemoryListResponse {
  const filter = scopeFilter(scope);
  const pending = decisionRows(
    db,
    `WHERE ${andWhere(`status = 'pending'`, filter)} ORDER BY resolve_after ASC`
  ).map(toDecisionView);
  const insufficient = decisionRows(
    db,
    `WHERE ${andWhere(`status = 'insufficient'`, filter)} ORDER BY resolved_at DESC LIMIT 50`
  ).map(toDecisionView);
  const allSettled = memoryRows(db, filter ? `WHERE ${filter}` : '');
  const settled = allSettled.slice(0, 100);
  const stats: MemoryStats = {
    pending: pending.length,
    settled: allSettled.length,
    insufficient: insufficient.length,
    hits: allSettled.filter((m) => m.outcome.verdict === 'hit').length,
    misses: allSettled.filter((m) => m.outcome.verdict === 'miss').length,
    inconclusive: allSettled.filter((m) => m.outcome.verdict === 'inconclusive').length,
    hitRate: 0
  };
  const decided = stats.hits + stats.misses;
  stats.hitRate = decided > 0 ? stats.hits / decided : 0;
  return { pending, settled, insufficient, stats };
}

function rankDelta(baseline: MemoryBaseline, outcome: WindowMetrics): number | null {
  if (baseline.hotRank === null || outcome.hotRank === null) return null;
  return baseline.hotRank - outcome.hotRank;
}

function judge(rating: TrendRating, delta: number): { hit: boolean; reason: string } {
  if (rating === 'strong_up') {
    return delta >= 2
      ? { hit: true, reason: `强烈看多且热度排名上升 ${delta} 位（≥2）` }
      : { hit: false, reason: `强烈看多但热度排名仅变化 ${delta} 位（<2）` };
  }
  if (rating === 'up') {
    return delta > 0
      ? { hit: true, reason: `看多且热度排名上升 ${delta} 位` }
      : { hit: false, reason: `看多但热度排名未上升（变化 ${delta} 位）` };
  }
  if (rating === 'strong_down') {
    return delta <= -2
      ? { hit: true, reason: `强烈看空且热度排名下降 ${Math.abs(delta)} 位（≥2）` }
      : { hit: false, reason: `强烈看空但热度排名仅变化 ${delta} 位（<2）` };
  }
  if (rating === 'down') {
    return delta < 0
      ? { hit: true, reason: `看空且热度排名下降 ${Math.abs(delta)} 位` }
      : { hit: false, reason: `看空但热度排名未下降（变化 ${delta} 位）` };
  }
  return Math.abs(delta) <= 1
    ? { hit: true, reason: `中性判断成立，热度排名基本稳定（变化 ${delta} 位）` }
    : { hit: false, reason: `中性判断落空，热度排名明显变化 ${delta} 位` };
}

function buildReflection(input: {
  label: string;
  asOf: string;
  rating: TrendRating;
  horizonDays: number;
  baseline: MemoryBaseline;
  outcome: WindowMetrics;
  hit: boolean;
  reason: string;
}): string {
  const b = input.baseline;
  const o = input.outcome;
  const dRank = rankDelta(b, o);
  const lesson = input.hit
    ? '该判断与后续热度走向一致，可复用当时的主要依据，但需继续关注动量反转。'
    : '该判断与后续热度走向相反，下次应更重视排名与动量的反向信号，并缩短复核窗口。';
  const neutralLesson =
    input.rating === 'neutral'
      ? input.hit
        ? '中性判断成立；缺乏动量时不必强行给出方向性评级。'
        : '本应更早给出方向性判断；下次应提高对动量变化的权重。'
      : lesson;
  return (
    `在 ${input.asOf} 对「${input.label}」给出 ${input.rating}（${input.horizonDays} 天窗口）。` +
    `结算：热度排名 ${b.hotRank ?? '—'}→${o.hotRank ?? '—'}（变化 ${dRank ?? '—'}），` +
    `文章量 ${b.articleCount}→${o.articleCount}（${o.articleCount - b.articleCount >= 0 ? '+' : ''}${o.articleCount - b.articleCount}），` +
    `动量 ${b.momentum}→${o.momentum}。判为${input.hit ? '命中' : '落空'}：${input.reason}。教训：${neutralLesson}`
  );
}

function insufficientOutcome(
  metrics: WindowMetrics,
  baseline: MemoryBaseline | undefined,
  reason: string
): MemoryOutcome {
  return {
    windowStart: metrics.windowStart,
    windowEnd: metrics.windowEnd,
    articleCount: metrics.articleCount,
    hotRank: metrics.hotRank,
    momentum: metrics.momentum,
    articleDelta: metrics.articleCount - (baseline?.articleCount ?? 0),
    hotRankDelta: baseline ? rankDelta(baseline, metrics) : null,
    momentumDelta: metrics.momentum - (baseline?.momentum ?? 0),
    verdict: 'inconclusive',
    hit: null,
    reason
  };
}

/** 结算单条决策；未到期、review、已结算都幂等返回而不改写数据。 */
export function settleDecisionById(
  db: Database,
  persist: () => void,
  decisionId: string,
  options: SettleOptions = {}
): MemorySettleDetail {
  const now = options.now ?? new Date().toISOString();
  const minArticles = Math.max(1, Math.floor(options.minArticles ?? DEFAULT_MIN_ARTICLES));
  const row = decisionRows(db, `WHERE id = ?`, [decisionId])[0];
  if (!row) {
    return { decisionId, subjectKey: '', status: 'not_found', message: '决策不存在' };
  }
  if (row.status === 'settled' || row.status === 'insufficient') {
    return { decisionId, subjectKey: row.subject_key, status: 'already_settled', message: '该记录已结算，幂等跳过' };
  }
  if (row.status === 'review') {
    return { decisionId, subjectKey: row.subject_key, status: 'not_settleable', message: 'review 决策不参与结算' };
  }
  if (!row.resolve_after || isoTime(row.resolve_after) > isoTime(now)) {
    return { decisionId, subjectKey: row.subject_key, status: 'not_due', message: '结算窗口尚未到期' };
  }

  if (row.subject_key.startsWith(STOCK_SUBJECT_PREFIX)) {
    return settleStockDecision(db, persist, row, now);
  }

  const windowDays = clampWindowDays(options.windowDays ?? row.horizon_days);
  const baseline = parseJson<MemoryBaseline | undefined>(row.baseline_json, undefined);
  const metrics = computeWindowMetrics(db, row.subject_label, row.resolve_after, windowDays);
  const insufficientReason =
    baseline === undefined
      ? '缺少结算基准快照'
      : baseline.articleCount < minArticles
        ? `基准窗口文章量不足（${baseline.articleCount} < ${minArticles}）`
        : metrics.articleCount < minArticles
          ? `结算窗口文章量不足（${metrics.articleCount} < ${minArticles}）`
          : metrics.hotRank === null
            ? '结算窗口话题未出现在实体表'
            : '';

  if (insufficientReason) {
    const outcome = insufficientOutcome(metrics, baseline, insufficientReason);
    const reflection = `无法结算「${row.subject_label}」：${insufficientReason}。已标记 insufficient，不计入命中率。`;
    db.exec(
      `UPDATE agent_decision SET status = 'insufficient', resolved_at = ?, outcome_json = ?, reflection = ?
       WHERE id = ? AND status = 'pending'`,
      [now, JSON.stringify(outcome), reflection, decisionId]
    );
    persist();
    return { decisionId, subjectKey: row.subject_key, status: 'insufficient', message: insufficientReason };
  }

  const base = baseline as MemoryBaseline;
  const delta = rankDelta(base, metrics) as number;
  const judged = judge(row.rating, delta);
  const outcome: MemoryOutcome = {
    windowStart: metrics.windowStart,
    windowEnd: metrics.windowEnd,
    articleCount: metrics.articleCount,
    hotRank: metrics.hotRank,
    momentum: metrics.momentum,
    articleDelta: metrics.articleCount - base.articleCount,
    hotRankDelta: delta,
    momentumDelta: metrics.momentum - base.momentum,
    verdict: judged.hit ? 'hit' : 'miss',
    hit: judged.hit,
    reason: judged.reason
  };
  const reflection = buildReflection({
    label: row.subject_label,
    asOf: row.as_of,
    rating: row.rating,
    horizonDays: windowDays,
    baseline: base,
    outcome: metrics,
    hit: judged.hit,
    reason: judged.reason
  });
  const existingMemory = Number(
    scalar(db, `SELECT COUNT(*) AS value FROM agent_memory WHERE decision_id = ?`, [decisionId]) ?? 0
  );
  if (existingMemory > 0) {
    return { decisionId, subjectKey: row.subject_key, status: 'already_settled', message: '记忆已存在，幂等跳过' };
  }
  const memoryId = `mem_${decisionId}`;
  db.exec(
    `INSERT OR IGNORE INTO agent_memory
      (id, decision_id, subject_key, as_of, resolved_at, rating, horizon_days, outcome_json, reflection, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      memoryId,
      decisionId,
      row.subject_key,
      row.as_of,
      now,
      row.rating,
      windowDays,
      JSON.stringify(outcome),
      reflection,
      now
    ]
  );
  db.exec(
    `UPDATE agent_decision SET status = 'settled', resolved_at = ?, outcome_json = ?, reflection = ?
     WHERE id = ? AND status = 'pending'`,
    [now, JSON.stringify(outcome), reflection, decisionId]
  );
  persist();
  return {
    decisionId,
    subjectKey: row.subject_key,
    status: 'settled',
    message: judged.hit ? '结算完成：命中' : '结算完成：落空'
  };
}

/** 扫描所有到期 pending；启动扫描与手动 IPC 共用。 */
export function settleDueMemory(db: Database, persist: () => void, options: SettleOptions = {}): MemorySettleResponse {
  const now = options.now ?? new Date().toISOString();
  const due = decisionRows(
    db,
    `WHERE status = 'pending' AND resolve_after IS NOT NULL AND resolve_after <= ? ORDER BY resolve_after ASC`,
    [now]
  );
  const details: MemorySettleDetail[] = [];
  let settled = 0;
  let insufficient = 0;
  let skipped = 0;
  for (const row of due) {
    const detail = settleDecisionById(db, persist, row.id, { ...options, now });
    details.push(detail);
    if (detail.status === 'settled') settled += 1;
    else if (detail.status === 'insufficient') insufficient += 1;
    else skipped += 1;
  }
  return { now, scanned: due.length, settled, insufficient, skipped, details };
}

/**
 * 只注入 resolved_at <= asOf 的教训（时间正确性核心）。
 * 同主题优先，其次其他主题；数量由节点 config 控制。
 */
export function loadMemoryContext(
  db: Database,
  input: {
    asOf: string;
    subjectKey: string;
    sameLimit?: number;
    otherLimit?: number;
    lookbackDays?: number;
  }
): { context: string; lessons: MemoryInjection[] } {
  const sameLimit = Math.max(0, Math.floor(input.sameLimit ?? 5));
  const otherLimit = Math.max(0, Math.floor(input.otherLimit ?? 3));
  const lookbackDays = clampLookbackDays(input.lookbackDays ?? 90);
  const asOfMs = isoTime(input.asOf);
  const since = toIso(asOfMs - lookbackDays * DAY_MS);
  const all = rows(
    db,
    `SELECT id, decision_id, subject_key, as_of, resolved_at, rating, reflection
     FROM agent_memory
     WHERE resolved_at <= ? AND as_of <= ? AND resolved_at >= ?
     ORDER BY resolved_at DESC`,
    [input.asOf, input.asOf, since]
  ).map((r) => ({
    memoryId: String(r.id),
    decisionId: String(r.decision_id),
    subjectKey: String(r.subject_key),
    asOf: String(r.as_of),
    resolvedAt: String(r.resolved_at),
    rating: r.rating as TrendRating,
    reflection: String(r.reflection)
  }));
  const same = all.filter((m) => m.subjectKey === input.subjectKey).slice(0, sameLimit);
  const other = all.filter((m) => m.subjectKey !== input.subjectKey).slice(0, otherLimit);
  const lessons = [...same, ...other];
  if (lessons.length === 0) {
    return { context: '【历史教训】无（asOf 之前没有已结算记录）', lessons };
  }
  const lines = lessons.map(
    (m) => `- [${m.resolvedAt}] ${m.subjectKey} 评级 ${m.rating}：${m.reflection}`
  );
  return {
    context: `【历史教训（仅 asOf ${input.asOf} 之前已结算，不代表未来）】\n${lines.join('\n')}`,
    lessons
  };
}
