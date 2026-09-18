export interface StockQuote {
  symbol: string;
  name: string;
  price: number;
  prevClose: number;
  change: number;
  changePct: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  amount?: number;
  tradedAt: string;
  // 财务指标（M22 新增，HK/US 字段缺失时为 undefined）
  pe?: number;
  pb?: number;
  marketCap?: number;
  turnoverPct?: number;
  amplitudePct?: number;
  volumeRatio?: number;
}

export interface StockKPoint {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

export interface StocksView {
  updatedAt: string;
  quotes: StockQuote[];
  note?: string;
}

export interface StockHistoryResult {
  symbol: string;
  points: StockKPoint[];
  note?: string;
}

export interface StockWatchItem {
  symbol: string;
  name: string;
  market: string;
  groupId?: number | null;
}

export interface StocksWatchView {
  items: StockWatchItem[];
}

export interface StockGroup {
  id: number;
  name: string;
  sort: number;
}

export interface StocksGroupsView {
  items: StockGroup[];
}

export type AlertKind = 'price_above' | 'price_below' | 'pct_above' | 'pct_below';

export interface StockAlert {
  id: number;
  symbol: string;
  kind: AlertKind;
  threshold: number;
  enabled: boolean;
  lastFiredAt: string | null;
  createdAt: string;
}

export interface StocksAlertsView {
  items: StockAlert[];
}

export type KlinePeriod = 'day' | 'week' | 'month';

export const MARKET_INDEX_SYMBOLS = [
  'sh000001',
  'sh000300',
  'sz399001',
  'sz399006',
  'hkHSI',
  'hkHSCEI',
  'usDJI',
  'usIXIC',
  'usINX'
] as const;
