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
}

export interface StocksWatchView {
  items: StockWatchItem[];
}

export type KlinePeriod = 'day' | 'week' | 'month';
