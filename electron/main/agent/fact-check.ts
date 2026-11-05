import type { FinalDecision } from '../../../shared/agent.js';
import type { StockFact, StockFactCheckResult } from '../../../shared/stock-agent.js';

const FACT_REF = /\[fact:([a-zA-Z0-9_\-:]+)\]/g;
const YEAR = /(?:19|20)\d{2}/;
const DATE = /\d{4}-\d{2}-\d{2}/g;
const NUM = /[-+]?(\d+(?:\.\d+)?|\.\d+)/g;

/** 抽取叙事文本中的数字（去掉日期与 fact 引用标记；纯年份不算量化断言）。 */
export function extractNumbers(text: string): string[] {
  // 先剥离 fact 引用再剥离日期：fact_id 内部含日期（如 ..._2026-10-29_20261029），
  // 反过来会让引用标记被日期替换打断，残留 id 片段被误判为“未匹配数字”。
  const stripped = text.replace(FACT_REF, ' ').replace(DATE, ' ');
  const out: string[] = [];
  for (const m of stripped.matchAll(NUM)) {
    const token = m[0];
    if (YEAR.test(token) && token.replace(/[-+]/, '').length === 4) continue;
    out.push(token);
  }
  return out;
}

export function extractFactRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(FACT_REF)) out.push(m[1]);
  return out;
}

/** 事实值池：数值事实 + valueText 内的数字（文本事实里出现的数字同样有据可查）。 */
export function factNumberPool(facts: StockFact[]): number[] {
  const pool: number[] = [];
  for (const f of facts) {
    if (typeof f.value === 'number' && Number.isFinite(f.value)) pool.push(f.value);
    if (f.valueText) {
      for (const token of extractNumbers(f.valueText)) {
        const n = Number(token);
        if (Number.isFinite(n)) pool.push(n);
      }
    }
    if (f.rawText) {
      for (const token of extractNumbers(f.rawText)) {
        const n = Number(token);
        if (Number.isFinite(n)) pool.push(n);
      }
    }
  }
  return pool;
}

function within(n: number, pool: number[], toleranceBps: number): boolean {
  const tol = Math.max(1e-9, toleranceBps / 10000);
  return pool.some((v) => {
    const base = Math.max(Math.abs(v), 1);
    return Math.abs(n - v) <= base * tol;
  });
}

function narrativeTexts(decision: FinalDecision): string[] {
  const texts: string[] = [decision.thesis, ...(decision.keyRisks ?? [])];
  const stock = decision.stock;
  if (stock) {
    for (const f of stock.factors) texts.push(f.mechanism, f.label);
    texts.push(...(stock.assumptions ?? []));
  }
  return texts;
}

/**
 * 数字闸门：裁决叙事里出现的每个数字都必须能在本地事实表匹配；
 * 无法匹配或引用了不存在的事实 id，一律判定失败（由调用方强制 review）。
 */
export function checkDecisionNumbers(
  decision: FinalDecision,
  facts: StockFact[],
  toleranceBps: number
): StockFactCheckResult {
  const pool = factNumberPool(facts);
  const factIds = new Set(facts.map((f) => f.factId));
  const checked = new Set<string>();
  const unverified = new Set<string>();
  const refs = new Set<string>();

  for (const text of narrativeTexts(decision)) {
    const body = text ?? '';
    for (const id of extractFactRefs(body)) {
      refs.add(id);
      if (!factIds.has(id)) unverified.add(`[fact:${id}]`);
    }
    for (const token of extractNumbers(body)) {
      checked.add(token);
      const n = Number(token);
      if (!Number.isFinite(n) || !within(n, pool, toleranceBps)) unverified.add(token);
    }
  }
  for (const id of decision.stock?.referencedFactIds ?? []) {
    refs.add(id);
    if (!factIds.has(id)) unverified.add(`[fact:${id}]`);
  }

  const ok = unverified.size === 0 && refs.size > 0;
  const reason = unverified.size > 0
    ? `存在未匹配数字：${[...unverified].slice(0, 6).join(', ')}`
    : refs.size === 0
      ? '裁决未引用任何本地事实，无法核验'
      : '全部数字均已匹配本地事实表';
  return {
    ok,
    checkedNumbers: [...checked],
    unverifiedNumbers: [...unverified],
    referencedFactIds: [...refs],
    toleranceBps,
    reason
  };
}
