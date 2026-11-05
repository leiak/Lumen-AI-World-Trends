/** A 股交易日历（P0 最小实现）。
 *  交易日判定：周一至周五且不在内置休市表中。P0 只覆盖样例与近期年份，
 *  真实数据以抓取到的 K 线日期序列为准（结算按 K 线序号，不按自然日）。 */

/** 2025-2027 主要休市日（元旦 / 春节 / 清明 / 劳动 / 端午 / 中秋 / 国庆）。
 *  仅用于“asOf 之后第 N 个交易日”的近似推进；实际结算以库内 K 线序号为准。 */
const CN_HOLIDAYS = new Set([
  '2025-01-01',
  '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', '2025-02-03', '2025-02-04',
  '2025-04-04', '2025-05-01', '2025-05-05', '2025-06-02', '2025-10-01', '2025-10-02',
  '2025-10-03', '2025-10-06', '2025-10-07',
  '2026-01-01', '2026-01-02',
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',
  '2026-04-06', '2026-05-01', '2026-05-04', '2026-06-19', '2026-09-25',
  '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
  '2027-01-01', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11', '2027-02-12',
  '2027-04-05', '2027-05-03', '2027-06-09', '2027-10-01'
]);

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** YYYY-MM-DD；只取日期部分，避免时区把当天算成前一天。 */
export function dateOnly(value: string): string {
  return value.slice(0, 10);
}

export function isTradingDay(date: string, holidays: Set<string> = CN_HOLIDAYS): boolean {
  const d = dateOnly(date);
  const ms = Date.parse(`${d}T00:00:00Z`);
  if (!Number.isFinite(ms)) return false;
  const dow = new Date(ms).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !holidays.has(d);
}

/** 从 date 的下一天起，找第 n 个交易日（n>=1）。 */
export function nextTradingDays(date: string, n: number, holidays: Set<string> = CN_HOLIDAYS): string[] {
  const out: string[] = [];
  const start = Date.parse(`${dateOnly(date)}T00:00:00Z`);
  if (!Number.isFinite(start)) return out;
  let cursor = start;
  while (out.length < Math.max(0, n)) {
    cursor += 86_400_000;
    const d = new Date(cursor);
    const iso = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    if (isTradingDay(iso, holidays)) out.push(iso);
  }
  return out;
}

/** 把 asOf 之后的第 5 个交易日换算成自然日上界；仅用于 settle 触发时间。 */
export function tPlusSettleAfter(asOf: string, n = 5): string {
  const dates = nextTradingDays(asOf, n);
  if (dates.length === 0) return asOf;
  return `${dates[dates.length - 1]}T23:59:59.000Z`;
}
