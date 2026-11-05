import type {
  DebateTurn,
  EvidenceDimension,
  EvidenceReport,
  FinalDecision,
  InvestmentPlan,
  JsonObject,
  ObservationPlan,
  RiskStance,
  RiskTurn,
  RunUsage,
  TrendRating
} from '../../../shared/agent.js';
import type {
  StockAttribution,
  StockFactLayer,
  StockFactor,
  StockFactorId
} from '../../../shared/stock-agent.js';
import { STOCK_FACT_LAYERS, STOCK_FACTOR_LABELS } from '../../../shared/stock-agent.js';

const RATING_SET = new Set<TrendRating>([
  'strong_up',
  'up',
  'neutral',
  'down',
  'strong_down',
  'review'
]);

/** 只认显式标签（“评级：xxx”或 rating=xxx），避免正文普通词误命中。 */
const RATING_TEXT: Array<[RegExp, TrendRating]> = [
  [/评级\s*[:：]\s*(强升温|strong_up)|rating\s*[:=]\s*"?strong_up/i, 'strong_up'],
  [/评级\s*[:：]\s*(强降温|strong_down)|rating\s*[:=]\s*"?strong_down/i, 'strong_down'],
  [/评级\s*[:：]\s*(升温|上行|up)|rating\s*[:=]\s*"?up/i, 'up'],
  [/评级\s*[:：]\s*(降温|下行|down)|rating\s*[:=]\s*"?down/i, 'down'],
  [/评级\s*[:：]\s*(平稳|中性|neutral)|rating\s*[:=]\s*"?neutral/i, 'neutral'],
  [/评级\s*[:：]\s*(待复核|review)|rating\s*[:=]\s*"?review/i, 'review']
];

/** 用括号配平扫描第一个 JSON 对象，避免贪婪正则吃掉多余内容。 */
export function extractFirstJsonObject(text: string): JsonObject | null {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, i + 1));
          return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? (parsed as JsonObject)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function unknownKeys(obj: JsonObject, allowed: string[]): string[] {
  const set = new Set(allowed);
  return Object.keys(obj).filter((k) => !set.has(k));
}

function isFiniteNumber(v: unknown, min: number, max: number): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function clipText(v: unknown, max = 3000): string {
  if (typeof v !== 'string') return '';
  return v.length > max ? v.slice(0, max) : v;
}

export function parseEvidenceReport(text: string, expected: EvidenceDimension): EvidenceReport | null {
  const obj = extractFirstJsonObject(text);
  if (!obj) return null;
  const extra = unknownKeys(obj, ['dimension', 'summary', 'signals', 'dataGaps', 'confidence']);
  if (extra.length > 0) return null;
  if (typeof obj.dimension !== 'string') return null;
  // 维度以节点配置为准，防止模型写错维度落到别的 key。
  const signalsRaw = obj.signals;
  if (!Array.isArray(signalsRaw)) return null;
  const signals: EvidenceReport['signals'] = [];
  for (const s of signalsRaw) {
    if (!isRecord(s)) return null;
    if (unknownKeys(s, ['claim', 'direction', 'strength', 'sourceIds']).length > 0) return null;
    if (typeof s.claim !== 'string' || s.claim.trim().length === 0) return null;
    if (s.direction !== 'up' && s.direction !== 'down' && s.direction !== 'flat') return null;
    if (s.strength !== 1 && s.strength !== 2 && s.strength !== 3) return null;
    if (!isStringArray(s.sourceIds)) return null;
    signals.push({
      claim: clipText(s.claim, 500),
      direction: s.direction,
      strength: s.strength,
      sourceIds: s.sourceIds.slice(0, 20)
    });
  }
  if (!isStringArray(obj.dataGaps)) return null;
  if (!isFiniteNumber(obj.confidence, 0, 1)) return null;
  if (typeof obj.summary !== 'string') return null;
  return {
    dimension: expected,
    summary: clipText(obj.summary, 1000),
    signals,
    dataGaps: obj.dataGaps.slice(0, 20),
    confidence: obj.confidence as number
  };
}

export function parseDebateTurn(text: string, stance: 'bull' | 'bear'): DebateTurn | null {
  const obj = extractFirstJsonObject(text);
  if (!obj) return null;
  const extra = unknownKeys(obj, ['stance', 'argument', 'rebuttals', 'evidenceRefs', 'confidence']);
  if (extra.length > 0) return null;
  const arg = obj.argument;
  if (typeof arg !== 'string' || arg.trim().length === 0) return null;
  if (!isStringArray(obj.evidenceRefs)) return null;
  if (!isFiniteNumber(obj.confidence, 0, 1)) return null;
  const rebuttalsRaw = obj.rebuttals;
  if (!Array.isArray(rebuttalsRaw)) return null;
  const rebuttals: DebateTurn['rebuttals'] = [];
  for (const r of rebuttalsRaw) {
    if (!isRecord(r)) return null;
    if (unknownKeys(r, ['target', 'point']).length > 0) return null;
    if (typeof r.target !== 'string' || typeof r.point !== 'string') return null;
    rebuttals.push({ target: clipText(r.target, 200), point: clipText(r.point, 500) });
  }
  return {
    stance,
    argument: clipText(arg, 1500),
    rebuttals,
    evidenceRefs: obj.evidenceRefs.slice(0, 20),
    confidence: obj.confidence as number
  };
}

export function parseRiskTurn(text: string, stance: RiskStance): RiskTurn | null {
  const obj = extractFirstJsonObject(text);
  if (!obj) return null;
  const extra = unknownKeys(obj, ['stance', 'challenge', 'mitigations', 'residualRisks', 'confidence']);
  if (extra.length > 0) return null;
  if (typeof obj.challenge !== 'string' || obj.challenge.trim().length === 0) return null;
  if (!isStringArray(obj.mitigations) || !isStringArray(obj.residualRisks)) return null;
  if (!isFiniteNumber(obj.confidence, 0, 1)) return null;
  return {
    stance,
    challenge: clipText(obj.challenge, 1500),
    mitigations: obj.mitigations.slice(0, 12),
    residualRisks: obj.residualRisks.slice(0, 12),
    confidence: obj.confidence as number
  };
}

export function parseObservationPlan(text: string): ObservationPlan | null {
  const obj = extractFirstJsonObject(text);
  if (!obj) return null;
  const extra = unknownKeys(obj, ['action', 'summary', 'triggers', 'invalidations', 'reviewInDays']);
  if (extra.length > 0) return null;
  if (
    obj.action !== 'watch' &&
    obj.action !== 'alert' &&
    obj.action !== 'escalate' &&
    obj.action !== 'dismiss'
  ) {
    return null;
  }
  if (typeof obj.summary !== 'string' || obj.summary.trim().length === 0) return null;
  if (!isStringArray(obj.triggers) || !isStringArray(obj.invalidations)) return null;
  if (
    typeof obj.reviewInDays !== 'number' ||
    !Number.isInteger(obj.reviewInDays) ||
    obj.reviewInDays < 1 ||
    obj.reviewInDays > 30
  ) {
    return null;
  }
  return {
    action: obj.action,
    summary: clipText(obj.summary, 1000),
    triggers: obj.triggers.slice(0, 8),
    invalidations: obj.invalidations.slice(0, 8),
    reviewInDays: obj.reviewInDays
  };
}

const DECISION_KEYS = new Set([
  'rating',
  'confidence',
  'horizonDays',
  'thesis',
  'keyRisks',
  'nextCheckAt',
  'reviewRequired',
  'reviewReason'
]);

/** 人工编辑：只允许覆盖 FinalDecision 的字段，逐字段严格校验，绝不接受未知键。
 *  返回 null 表示补丁非法，由 runtime 映射为 E_VALIDATION。 */
export function mergeDecisionPatch(base: FinalDecision, patch: JsonObject): FinalDecision | null {
  for (const key of Object.keys(patch)) {
    if (!DECISION_KEYS.has(key)) return null;
  }
  const merged: Record<string, unknown> = { ...base, ...patch };
  if (typeof merged.rating !== 'string' || !RATING_SET.has(merged.rating as TrendRating)) return null;
  if (!isFiniteNumber(merged.confidence, 0, 1)) return null;
  if (
    typeof merged.horizonDays !== 'number' ||
    !Number.isInteger(merged.horizonDays) ||
    merged.horizonDays < 3 ||
    merged.horizonDays > 30
  ) {
    return null;
  }
  if (typeof merged.thesis !== 'string' || merged.thesis.trim().length === 0) return null;
  if (!isStringArray(merged.keyRisks)) return null;
  if (typeof merged.nextCheckAt !== 'string' || !Number.isFinite(Date.parse(merged.nextCheckAt))) {
    return null;
  }
  if (merged.reviewReason !== undefined && typeof merged.reviewReason !== 'string') return null;
  const rating = merged.rating as TrendRating;
  return {
    rating,
    confidence: merged.confidence as number,
    horizonDays: merged.horizonDays,
    thesis: clipText(merged.thesis, 3000),
    keyRisks: merged.keyRisks.slice(0, 20),
    nextCheckAt: merged.nextCheckAt,
    reviewRequired: rating === 'review' ? true : Boolean(merged.reviewRequired),
    reviewReason:
      rating === 'review'
        ? (merged.reviewReason as string | undefined) ?? 'approval_edit_review'
        : undefined,
    ...(base.stock ? { stock: base.stock } : {})
  };
}

export function parseFinalDecision(text: string): FinalDecision | null {
  const obj = extractFirstJsonObject(text);
  if (!obj) return null;
  const extra = unknownKeys(obj, [
    'rating',
    'confidence',
    'horizonDays',
    'thesis',
    'keyRisks',
    'nextCheckAt',
    'reviewRequired',
    'reviewReason'
  ]);
  if (extra.length > 0) return null;
  if (typeof obj.rating !== 'string' || !RATING_SET.has(obj.rating as TrendRating)) return null;
  if (!isFiniteNumber(obj.confidence, 0, 1)) return null;
  if (typeof obj.horizonDays !== 'number' || !Number.isInteger(obj.horizonDays) || obj.horizonDays < 3 || obj.horizonDays > 30) {
    return null;
  }
  if (typeof obj.thesis !== 'string' || obj.thesis.trim().length === 0) return null;
  if (!isStringArray(obj.keyRisks)) return null;
  if (typeof obj.nextCheckAt !== 'string' || !Number.isFinite(Date.parse(obj.nextCheckAt))) return null;
  if (typeof obj.reviewRequired !== 'boolean') return null;
  if (obj.reviewReason !== undefined && typeof obj.reviewReason !== 'string') return null;
  const rating = obj.rating as TrendRating;
  return {
    rating,
    confidence: obj.confidence as number,
    horizonDays: obj.horizonDays,
    thesis: clipText(obj.thesis, 3000),
    keyRisks: obj.keyRisks.slice(0, 20),
    nextCheckAt: obj.nextCheckAt,
    reviewRequired: rating === 'review' ? true : obj.reviewRequired,
    reviewReason: obj.reviewReason as string | undefined
  };
}

/** M26：股票裁决除 FinalDecision 外还必须带结构化的归因分解。
 *  归因不合法视为结构化输出失败，由上层降级为 review（不猜测）。 */
export function parseStockDecision(text: string): FinalDecision | null {
  const obj = extractFirstJsonObject(text);
  if (!obj) return null;
  const base = parseFinalDecision(JSON.stringify({ ...obj, stock: undefined }));
  if (!base) return null;
  const stock = parseStockAttribution(obj.stock);
  if (!stock) return null;
  return { ...base, stock };
}

const FACTOR_IDS: StockFactorId[] = [
  'earnings_surprise',
  'guidance_change',
  'event_driven',
  'sector_market_beta',
  'liquidity_sentiment'
];

function isLayer(v: unknown): v is StockFactLayer {
  return typeof v === 'string' && (STOCK_FACT_LAYERS as string[]).includes(v);
}

function parseStockAttribution(raw: unknown): StockAttribution | null {
  if (!isRecord(raw)) return null;
  const factorsRaw = raw.factors;
  if (!Array.isArray(factorsRaw) || factorsRaw.length === 0 || factorsRaw.length > 5) return null;
  const factors: StockFactor[] = [];
  for (const item of factorsRaw) {
    if (!isRecord(item)) return null;
    if (typeof item.id !== 'string' || !FACTOR_IDS.includes(item.id as StockFactorId)) return null;
    if (!isLayer(item.layer)) return null;
    if (item.contribution !== 'positive' && item.contribution !== 'negative' && item.contribution !== 'neutral') {
      return null;
    }
    if (!isFiniteNumber(item.weight, 0, 1)) return null;
    if (typeof item.mechanism !== 'string' || item.mechanism.trim().length === 0) return null;
    if (!isStringArray(item.factIds)) return null;
    const id = item.id as StockFactorId;
    factors.push({
      id,
      label:
        typeof item.label === 'string' && item.label.trim()
          ? clipText(item.label, 60)
          : STOCK_FACTOR_LABELS[id],
      layer: item.layer,
      contribution: item.contribution,
      weight: item.weight as number,
      mechanism: clipText(item.mechanism, 800),
      factIds: item.factIds.slice(0, 20)
    });
  }
  const missingLayersRaw = raw.missingLayers;
  if (!Array.isArray(missingLayersRaw) || !missingLayersRaw.every(isLayer)) return null;
  if (!isStringArray(raw.assumptions)) return null;
  if (raw.magnitude !== 'small' && raw.magnitude !== 'medium' && raw.magnitude !== 'large') return null;
  if (typeof raw.benchmarkSymbol !== 'string' || !raw.benchmarkSymbol.trim()) return null;
  if (!isStringArray(raw.referencedFactIds)) return null;
  const missingLayers = Array.from(new Set(missingLayersRaw)) as StockFactLayer[];
  return {
    factors,
    missingLayers,
    assumptions: raw.assumptions.slice(0, 10).map((a) => clipText(a, 500)),
    magnitude: raw.magnitude,
    benchmarkSymbol: raw.benchmarkSymbol.trim(),
    referencedFactIds: Array.from(new Set(raw.referencedFactIds)).slice(0, 50)
  };
}

/** 文本兜底：仅在正文出现唯一显式评级标签时采纳；多标签冲突返回 null。 */
export function ratingFromText(text: string): TrendRating | null {
  const found = new Set<TrendRating>();
  for (const [re, rating] of RATING_TEXT) {
    if (re.test(text)) found.add(rating);
  }
  if (found.size !== 1) return null;
  return Array.from(found)[0];
}

/** 解析失败一律 review，绝不默认成 neutral。 */
export function reviewDecision(
  horizonDays = 7,
  now = new Date(),
  reason = 'structured_output_failed'
): FinalDecision {
  return {
    rating: 'review',
    confidence: 0,
    horizonDays,
    thesis: '结构化输出失败，需人工复核',
    keyRisks: [],
    nextCheckAt: new Date(now.getTime() + 24 * 3600 * 1000).toISOString(),
    reviewRequired: true,
    reviewReason: reason
  };
}

export function decisionFromText(raw: string, horizonDays = 7): FinalDecision | null {
  const rating = ratingFromText(raw);
  if (!rating) return null;
  if (rating === 'review') {
    return reviewDecision(horizonDays, new Date(), 'model_requested_review');
  }
  return {
    rating,
    confidence: 0.5,
    horizonDays,
    thesis: clipText(raw, 1000),
    keyRisks: [],
    nextCheckAt: new Date(Date.now() + horizonDays * 24 * 3600 * 1000).toISOString(),
    reviewRequired: false,
    reviewReason: 'text_fallback'
  };
}

export function planFromDecision(decision: FinalDecision): InvestmentPlan {
  const direction =
    decision.rating === 'strong_up' || decision.rating === 'up'
      ? 'up'
      : decision.rating === 'strong_down' || decision.rating === 'down'
        ? 'down'
        : 'neutral';
  return {
    direction,
    thesis: decision.thesis,
    drivers: [],
    invalidation: decision.keyRisks,
    horizonDays: decision.horizonDays
  };
}

export function emptyUsage(): RunUsage {
  return { calls: 0, promptChars: 0, completionChars: 0 };
}

/** 结构化优先、失败重试 1 次的通用流程。 */
export async function generateStructured<T>(
  generate: (messages: import('../ai/provider.js').ChatMessage[]) => Promise<string>,
  messages: import('../ai/provider.js').ChatMessage[],
  parse: (text: string) => T | null,
  retryHint: string
): Promise<{ value: T | null; raw: string; attempts: number }> {
  let raw = await generate(messages);
  let value = parse(raw);
  if (value) return { value, raw, attempts: 1 };
  const retryMessages: import('../ai/provider.js').ChatMessage[] = [
    ...messages,
    { role: 'assistant', content: raw.slice(0, 4000) },
    { role: 'user', content: retryHint }
  ];
  raw = await generate(retryMessages);
  value = parse(raw);
  return { value, raw, attempts: 2 };
}
