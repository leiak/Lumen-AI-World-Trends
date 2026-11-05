/** 股票 AI 分析（M26）的跨进程契约。
 *  独立于「世界趋势智能体」：独立的图 id、独立的事实层、独立的结算口径。
 *  只放类型与常量，不放运行时实现；主进程与 renderer 共用。 */

export type StockFactLayer = 'market' | 'fundamentals' | 'disclosures' | 'news';

export const STOCK_FACT_LAYERS: StockFactLayer[] = [
  'market',
  'fundamentals',
  'disclosures',
  'news'
];

export const STOCK_LAYER_LABELS: Record<StockFactLayer, string> = {
  market: '行情',
  fundamentals: '财报',
  disclosures: '公告/披露',
  news: '舆情'
};

/** 一条可被裁决引用、可被数字闸门核验的本地事实。 */
export interface StockFact {
  factId: string;
  symbol: string;
  layer: StockFactLayer;
  /** 指标名，如 close / net_profit_yoy / announcement_sentiment。 */
  metric: string;
  /** 数值事实；文本事实（如公告标题）为 null。 */
  value: number | null;
  valueText: string | null;
  unit: string | null;
  /** 报告期或所属区间，如 2026Q2。 */
  period: string | null;
  /** 事实的发布时间（含水印，不可晚于抓取时间）。 */
  publishedAt: string;
  /** 事实可被分析引用的生效时间；asOf 截断以此为准。 */
  effectiveAt: string;
  source: string;
  rawText?: string;
}

export type StockFactLayerStatusValue = 'ok' | 'partial' | 'missing';

export interface StockLayerStatus {
  layer: StockFactLayer;
  status: StockFactLayerStatusValue;
  factCount: number;
  /** 该维度缺失/不完整的具体原因；缺失必须在 UI 与裁决中显式标注。 */
  gaps: string[];
}

export interface StockFactsView {
  symbol: string;
  asOf: string;
  facts: StockFact[];
  layers: StockLayerStatus[];
}

export interface StockFactsQuery {
  symbol: string;
  asOf?: string;
}

export interface StockFactsImportRequest {
  csv: string;
  /** CSV 中未写 symbol 时的兜底。 */
  symbol?: string;
  /** true 时先删除该 symbol 在该 layer 的旧事实（默认按 fact_id 幂等 upsert）。 */
  replace?: boolean;
}

export interface StockFactsImportResponse {
  imported: number;
  skipped: number;
  errors: Array<{ line: number; message: string }>;
  view: StockFactsView;
}

export interface StockFactAddRequest {
  fact: StockFactInput;
}

export interface StockFactInput {
  symbol: string;
  layer: StockFactLayer;
  metric: string;
  value?: number | null;
  valueText?: string | null;
  unit?: string;
  period?: string;
  publishedAt: string;
  effectiveAt?: string;
  source: string;
  rawText?: string;
}

export interface StockMarketSyncRequest {
  symbol: string;
  asOf?: string;
}

export interface StockMarketSyncResponse {
  symbol: string;
  wrote: number;
  /** 行情来源：db_snapshot / provider / none。 */
  from: 'db_snapshot' | 'provider' | 'none';
  view: StockFactsView;
}

export interface StockSampleResponse {
  symbol: string;
  csv: string;
}

export type StockFactorId =
  | 'earnings_surprise'
  | 'guidance_change'
  | 'event_driven'
  | 'sector_market_beta'
  | 'liquidity_sentiment';

export const STOCK_FACTOR_LABELS: Record<StockFactorId, string> = {
  earnings_surprise: '业绩超预期',
  guidance_change: '指引变化',
  event_driven: '事件驱动',
  sector_market_beta: '板块/市场 Beta',
  liquidity_sentiment: '流动性/情绪'
};

export interface StockFactor {
  id: StockFactorId;
  label: string;
  layer: StockFactLayer;
  contribution: 'positive' | 'negative' | 'neutral';
  /** 归因权重 0-1，只表示相对重要性。 */
  weight: number;
  mechanism: string;
  /** 支撑该因子的本地事实 id；数字闸门按这些事实核验。 */
  factIds: string[];
}

/** 裁决附带的股票归因分解。 */
export interface StockAttribution {
  factors: StockFactor[];
  /** 本次分析中缺失、已显式降级的维度。 */
  missingLayers: StockFactLayer[];
  assumptions: string[];
  /** 方向幅度档位（相对基准超额收益的粗粒度分档）。 */
  magnitude: 'small' | 'medium' | 'large';
  benchmarkSymbol: string;
  /** 裁决正文引用的事实 id（去重）。 */
  referencedFactIds: string[];
}

/** 事实核查（数字闸门）结果。 */
export interface StockFactCheckResult {
  ok: boolean;
  /** 从结论叙事字段中抽出的数字。 */
  checkedNumbers: string[];
  /** 未能在本地事实表匹配的数字。 */
  unverifiedNumbers: string[];
  referencedFactIds: string[];
  toleranceBps: number;
  reason: string;
}

/** T+5 交易日结算结果；T+1/T+20 仅作诊断。 */
export interface StockOutcome {
  horizon: 'T+5';
  entryDate: string;
  exitDate: string | null;
  entryClose: number | null;
  exitClose: number | null;
  stockReturnPct: number | null;
  benchmarkSymbol: string;
  benchmarkReturnPct: number | null;
  /** 股票收益 - 基准收益；判定口径。 */
  excessReturnPct: number | null;
  verdict: 'hit' | 'miss' | 'inconclusive';
  diagnostics: { t1: number | null; t20: number | null };
  reason: string;
}

/** 决策时的股票基准快照（写进 agent_decision.baseline_json）。 */
export interface StockBaseline {
  capturedAt: string;
  asOf: string;
  entryDate: string | null;
  entryClose: number | null;
  benchmarkSymbol: string;
  benchmarkEntryClose: number | null;
}

/** 股票默认图 id 与主体前缀。 */
export const STOCK_GRAPH_ID = 'stock-analysis';
export const STOCK_SUBJECT_PREFIX = 'stock:';
export const STOCK_DEFAULT_BENCHMARK = 'sh000300';

export function stockSubjectKey(symbol: string): string {
  return `${STOCK_SUBJECT_PREFIX}${symbol.trim().toLowerCase()}`;
}

/** A 股代码归一化：6/5/9 开头视为 A 股；只接受 6 位数字。 */
export function normalizeAStockSymbol(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  const m = s.match(/^(sh|sz)?(\d{6})$/);
  if (!m) return null;
  const digits = m[2];
  if (!/^(6|5|9|0|3)/.test(digits)) return null;
  if (digits.startsWith('6')) return `sh${digits}`;
  return `sz${digits}`;
}
