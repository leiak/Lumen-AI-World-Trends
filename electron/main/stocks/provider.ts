import axios from 'axios';
import type { KlinePeriod, StockKPoint, StockQuote } from '../../../shared/stocks.js';

const QUOTE_ENDPOINT = 'https://qt.gtimg.cn/q=';
const KLINE_ENDPOINT = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';

export function decodeGbk(buf: Uint8Array): string {
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return new TextDecoder('latin1').decode(buf);
  }
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function parseQuoteLine(line: string): StockQuote | null {
  const eq = line.indexOf('=');
  if (eq < 0) return null;
  const symbol = line.slice(2, eq);
  const a = line.indexOf('"', eq);
  const b = line.lastIndexOf('"');
  if (a < 0 || b <= a) return null;
  const f = line.slice(a + 1, b).split('~');
  const price = num(f[3]) || num(f[4]);
  const prevClose = num(f[4]);
  let change = num(f[31]);
  let changePct = num(f[32]);
  if (price > 0 && prevClose > 0 && change === 0 && price !== prevClose) {
    change = price - prevClose;
    changePct = (change / prevClose) * 100;
  }
  return {
    symbol,
    name: f[1] || symbol,
    price,
    prevClose,
    change,
    changePct,
    open: f[5] ? num(f[5]) : undefined,
    high: f[33] ? num(f[33]) : undefined,
    low: f[34] ? num(f[34]) : undefined,
    volume: f[6] ? num(f[6]) : undefined,
    amount: f[37] ? num(f[37]) : undefined,
    tradedAt: f[30] ?? ''
  };
}

export function parseKlineResponse(
  payload: unknown,
  symbol: string,
  period: KlinePeriod = 'day'
): StockKPoint[] {
  const entry = (payload as {
    data?: Record<string, Record<string, string[][] | undefined>>;
  })?.data?.[symbol];
  const rows = entry?.[`qfq${period}`] ?? entry?.[period] ?? [];
  return rows
    .map((r) => ({
      date: String(r[0] ?? ''),
      open: num(r[1]),
      close: num(r[2]),
      high: num(r[3]),
      low: num(r[4]),
      volume: num(r[5])
    }))
    .filter((p) => p.date && p.close > 0);
}

export interface StockProvider {
  fetchQuotes(symbols: string[]): Promise<StockQuote[]>;
  fetchKline(symbol: string, days?: number, period?: KlinePeriod): Promise<StockKPoint[]>;
}

export class TencentStockProvider implements StockProvider {
  private readonly http = axios.create({
    timeout: 8000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Lumen' }
  });

  async fetchQuotes(symbols: string[]): Promise<StockQuote[]> {
    const res = await this.http.get(QUOTE_ENDPOINT + symbols.join(','), {
      responseType: 'arraybuffer'
    });
    const text = decodeGbk(new Uint8Array(res.data as ArrayBuffer));
    const quotes: StockQuote[] = [];
    for (const line of text.split('\n')) {
      if (!line.includes('=') || !line.includes('"')) continue;
      const q = parseQuoteLine(line.trim());
      if (q) quotes.push(q);
    }
    return quotes;
  }

  async fetchKline(symbol: string, days = 60, period: KlinePeriod = 'day'): Promise<StockKPoint[]> {
    const res = await this.http.get(KLINE_ENDPOINT, {
      params: { param: `${symbol},${period},,,${days},qfq` }
    });
    return parseKlineResponse(res.data, symbol, period);
  }
}

export class MockStockProvider implements StockProvider {
  private base(symbol: string): number {
    let h = 7;
    for (const ch of symbol) h = (h * 31 + ch.charCodeAt(0)) % 9973;
    return 20 + (h % 4000);
  }

  async fetchQuotes(symbols: string[]): Promise<StockQuote[]> {
    return symbols.map((symbol) => {
      const price = this.base(symbol);
      const prevClose = price - 1.2;
      return {
        symbol,
        name: `Mock ${symbol}`,
        price,
        prevClose,
        change: price - prevClose,
        changePct: 0.5,
        high: price + 5,
        low: price - 4,
        volume: 100000,
        amount: 99999,
        tradedAt: '20260915150000'
      };
    });
  }

  async fetchKline(symbol: string, days = 60, period: KlinePeriod = 'day'): Promise<StockKPoint[]> {
    const base = this.base(symbol);
    const start = new Date(Date.UTC(2026, 6, 1));
    const out: StockKPoint[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      if (period === 'week') d.setUTCDate(start.getUTCDate() + i * 7);
      else if (period === 'month') d.setUTCDate(start.getUTCDate() + i * 30);
      else d.setUTCDate(start.getUTCDate() + i);
      const close = base + Math.sin(i / 3) * 10;
      out.push({
        date: d.toISOString().slice(0, 10),
        open: close - 1,
        close,
        high: close + 2,
        low: close - 2,
        volume: 1000 + i * 50
      });
    }
    return out;
  }
}

export function createStockProvider(env: NodeJS.ProcessEnv = process.env): StockProvider {
  return env.LUMEN_STOCK_PROVIDER === 'mock'
    ? new MockStockProvider()
    : new TencentStockProvider();
}
