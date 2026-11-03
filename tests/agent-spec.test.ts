import { describe, it, expect } from 'vitest';
import { defaultGraphSpec, validateGraphSpec } from '../electron/main/agent/spec.js';
import { extractFirstJsonObject, parseFinalDecision, ratingFromText, reviewDecision } from '../electron/main/agent/structured.js';
import type { GraphSpec } from '../shared/agent.js';

const NOW = '2026-11-03T10:00:00.000Z';

describe('GraphSpec 校验', () => {
  it('默认十节点图合法：memory + 风控三方 + planner/final + 两类条件边', () => {
    const spec = defaultGraphSpec(NOW);
    const res = validateGraphSpec(spec);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.spec.nodes.map((n) => n.type).sort()).toEqual([
        'bear',
        'bull',
        'evidence',
        'final',
        'judge',
        'memory',
        'planner',
        'risk_aggressive',
        'risk_conservative',
        'risk_neutral'
      ]);
      expect(res.spec.edges.length).toBe(11);
      expect(res.spec.settings.runTimeoutMs).toBe(600000);
      expect(res.spec.settings.maxCostUsd).toBe(0.3);
      expect(res.spec.settings.maxDebateRounds).toBe(2);
      expect(res.spec.settings.maxRiskRounds).toBe(1);
      expect(res.spec.settings.recursionLimit).toBe(40);
      expect(
        res.spec.edges.filter((e) => e.condition?.kind === 'debate_rounds')
      ).toHaveLength(2);
      expect(res.spec.edges.filter((e) => e.condition?.kind === 'risk_rounds')).toHaveLength(3);
      const final = res.spec.nodes.find((n) => n.type === 'final');
      expect(final?.config).toEqual({ type: 'final', requireApproval: true });
      const memory = res.spec.nodes.find((n) => n.type === 'memory');
      expect(memory?.config).toEqual({ type: 'memory', lookbackDays: 90, maxLessons: 5 });
      expect(res.spec.edges.find((e) => e.id === 'e-start-memory')?.target).toBe('memory');
      expect(res.spec.edges.find((e) => e.id === 'e-memory-evidence')?.target).toBe('evidence');
    }
  });

  it('拒绝白名单之外的节点类型', () => {
    const spec = defaultGraphSpec(NOW) as GraphSpec & { nodes: Array<Record<string, unknown>> };
    const copy = JSON.parse(JSON.stringify(spec)) as GraphSpec;
    (copy.nodes[0] as unknown as Record<string, unknown>).type = 'oracle';
    const res = validateGraphSpec(copy);
    expect(!res.ok && res.code).toBe('E_NODE_TYPE_UNKNOWN');
  });

  it('拒绝未知字段、环路与缺少终端', () => {
    const base = JSON.parse(JSON.stringify(defaultGraphSpec(NOW))) as GraphSpec & Record<string, unknown>;
    base.unknown = true;
    expect(validateGraphSpec(base).ok).toBe(false);

    // 静态环：judge→evidence 与 evidence→judge；辩论条件回边不在此列。
    const cyclic = JSON.parse(JSON.stringify(defaultGraphSpec(NOW))) as GraphSpec;
    cyclic.edges.push({ id: 'e-cycle', source: 'judge', target: 'evidence' });
    cyclic.edges.push({ id: 'e-cycle-back', source: 'evidence', target: 'judge' });
    const res = validateGraphSpec(cyclic);
    expect(!res.ok && res.code).toBe('E_GRAPH_INVALID');

    const noJudge = JSON.parse(JSON.stringify(defaultGraphSpec(NOW))) as GraphSpec;
    noJudge.nodes = noJudge.nodes.filter((n) => n.type !== 'judge');
    noJudge.edges = noJudge.edges.filter((e) => e.source !== 'judge' && e.target !== 'judge');
    const res2 = validateGraphSpec(noJudge);
    expect(!res2.ok && res2.code).toBe('E_GRAPH_INVALID');
  });

  it('拒绝参数越界、未知条件类型与轮数不一致', () => {
    const badTopN = JSON.parse(JSON.stringify(defaultGraphSpec(NOW))) as GraphSpec;
    const ev = badTopN.nodes.find((n) => n.type === 'evidence')!;
    (ev.config as unknown as Record<string, unknown>).topN = 99;
    expect(validateGraphSpec(badTopN).ok).toBe(false);

    const unknownCond = JSON.parse(JSON.stringify(defaultGraphSpec(NOW))) as GraphSpec;
    const bullEdgeForCond = unknownCond.edges.find((e) => e.source === 'bull')!;
    (bullEdgeForCond as unknown as Record<string, unknown>).condition = {
      kind: 'risk_rounds',
      maxRounds: 1,
      whenDone: 'judge'
    };
    const res = validateGraphSpec(unknownCond);
    expect(!res.ok && res.code).toBe('E_GRAPH_INVALID');

    const mismatch = JSON.parse(JSON.stringify(defaultGraphSpec(NOW))) as GraphSpec;
    const bullEdgeMismatch = mismatch.edges.find((e) => e.source === 'bull')!;
    bullEdgeMismatch.condition = { kind: 'debate_rounds', maxRounds: 1, whenDone: 'judge' };
    const res2 = validateGraphSpec(mismatch);
    expect(!res2.ok && res2.code).toBe('E_VALIDATION');

    const zeroRounds = JSON.parse(JSON.stringify(defaultGraphSpec(NOW))) as GraphSpec;
    zeroRounds.settings.maxDebateRounds = 0;
    const res3 = validateGraphSpec(zeroRounds);
    expect(!res3.ok && res3.code).toBe('E_VALIDATION');

    const fourRounds = JSON.parse(JSON.stringify(defaultGraphSpec(NOW))) as GraphSpec;
    fourRounds.settings.maxDebateRounds = 4;
    const res4a = validateGraphSpec(fourRounds);
    expect(!res4a.ok && res4a.code).toBe('E_VALIDATION');

    const oneRound = JSON.parse(JSON.stringify(defaultGraphSpec(NOW))) as GraphSpec;
    oneRound.settings.maxDebateRounds = 1;
    oneRound.nodes.find((n) => n.type === 'bull')!.config = { type: 'bull', maxRounds: 1 };
    oneRound.nodes.find((n) => n.type === 'bear')!.config = { type: 'bear', maxRounds: 1 };
    const bullEdge = oneRound.edges.find((e) => e.source === 'bull')!;
    const bearEdge = oneRound.edges.find((e) => e.source === 'bear')!;
    bullEdge.condition = { kind: 'debate_rounds', maxRounds: 1, whenDone: 'judge' };
    bearEdge.condition = { kind: 'debate_rounds', maxRounds: 1, whenDone: 'judge' };
    expect(validateGraphSpec(oneRound).ok).toBe(true);

    const missingReverse = JSON.parse(JSON.stringify(defaultGraphSpec(NOW))) as GraphSpec;
    missingReverse.edges = missingReverse.edges.filter((e) => e.source !== 'bear');
    const res4 = validateGraphSpec(missingReverse);
    expect(!res4.ok && res4.code).toBe('E_GRAPH_INVALID');
  });

  it('whenDone 收紧：辩论只能指 judge，风控只能指 planner/final', () => {
    const debateBad = JSON.parse(JSON.stringify(defaultGraphSpec(NOW))) as GraphSpec;
    const bullEdge = debateBad.edges.find((e) => e.source === 'bull')!;
    bullEdge.condition = { kind: 'debate_rounds', maxRounds: 2, whenDone: 'planner' };
    const res = validateGraphSpec(debateBad);
    expect(!res.ok && res.code).toBe('E_GRAPH_INVALID');

    const riskBad = JSON.parse(JSON.stringify(defaultGraphSpec(NOW))) as GraphSpec;
    const riskEdge = riskBad.edges.find((e) => e.condition?.kind === 'risk_rounds')!;
    (riskEdge.condition as { whenDone: string }).whenDone = 'judge';
    const res2 = validateGraphSpec(riskBad);
    expect(!res2.ok && res2.code).toBe('E_GRAPH_INVALID');

    const riskToFinal = JSON.parse(JSON.stringify(defaultGraphSpec(NOW))) as GraphSpec;
    riskToFinal.edges = riskToFinal.edges.filter(
      (e) => !(e.id === 'e-judge-planner' || e.id === 'e-planner-risk')
    );
    riskToFinal.nodes = riskToFinal.nodes.filter((n) => n.type !== 'planner');
    riskToFinal.edges = riskToFinal.edges.map((e) =>
      e.condition?.kind === 'risk_rounds'
        ? { ...e, condition: { ...e.condition, whenDone: 'final' } }
        : e
    );
    // 没有 planner 作为风控入口，风控节点不可达。
    const res3 = validateGraphSpec(riskToFinal);
    expect(!res3.ok && res3.code).toBe('E_GRAPH_INVALID');
  });

  it('风控参数与唯一 final 校验：轮数 1-3、order 完整、final 唯一终端', () => {
    const zeroRisk = JSON.parse(JSON.stringify(defaultGraphSpec(NOW))) as GraphSpec;
    zeroRisk.settings.maxRiskRounds = 0;
    const res = validateGraphSpec(zeroRisk);
    expect(!res.ok && res.code).toBe('E_VALIDATION');

    const fourRisk = JSON.parse(JSON.stringify(defaultGraphSpec(NOW))) as GraphSpec;
    fourRisk.settings.maxRiskRounds = 4;
    const res2 = validateGraphSpec(fourRisk);
    expect(!res2.ok && res2.code).toBe('E_VALIDATION');

    const threeRisk = JSON.parse(JSON.stringify(defaultGraphSpec(NOW))) as GraphSpec;
    threeRisk.settings.maxRiskRounds = 3;
    for (const n of threeRisk.nodes.filter((x) => x.type.startsWith('risk_'))) {
      (n.config as { maxRounds: number }).maxRounds = 3;
    }
    for (const e of threeRisk.edges) {
      if (e.condition?.kind === 'risk_rounds') e.condition.maxRounds = 3;
    }
    expect(validateGraphSpec(threeRisk).ok).toBe(true);

    const badOrder = JSON.parse(JSON.stringify(defaultGraphSpec(NOW))) as GraphSpec;
    const riskEdge = badOrder.edges.find((e) => e.condition?.kind === 'risk_rounds')!;
    (riskEdge.condition as { order: string[] }).order = ['risk_aggressive', 'risk_aggressive', 'risk_neutral'];
    const res3 = validateGraphSpec(badOrder);
    expect(!res3.ok && res3.code).toBe('E_GRAPH_INVALID');

    const noFinal = JSON.parse(JSON.stringify(defaultGraphSpec(NOW))) as GraphSpec;
    noFinal.nodes = noFinal.nodes.filter((n) => n.type !== 'final');
    noFinal.edges = noFinal.edges.filter((e) => e.source !== 'final' && e.target !== 'final');
    const res4 = validateGraphSpec(noFinal);
    expect(!res4.ok && res4.code).toBe('E_GRAPH_INVALID');

    const twoFinal = JSON.parse(JSON.stringify(defaultGraphSpec(NOW))) as GraphSpec;
    twoFinal.nodes.push({
      ...twoFinal.nodes.find((n) => n.type === 'final')!,
      id: 'final2',
      position: { x: 1400, y: 320 }
    });
    const res5 = validateGraphSpec(twoFinal);
    expect(!res5.ok && res5.code).toBe('E_GRAPH_INVALID');
  });

  it('允许不含风控节点的最小图：judge → final 唯一终端', () => {
    const minimal = JSON.parse(JSON.stringify(defaultGraphSpec(NOW))) as GraphSpec;
    minimal.nodes = minimal.nodes.filter(
      (n) => !n.type.startsWith('risk_') && n.type !== 'planner'
    );
    minimal.edges = minimal.edges.filter(
      (e) =>
        !e.source.startsWith('risk_') &&
        !e.target.startsWith('risk_') &&
        e.source !== 'planner' &&
        e.target !== 'planner'
    );
    minimal.edges.push({ id: 'e-judge-final', source: 'judge', target: 'final' });
    const res = validateGraphSpec(minimal);
    expect(res.ok).toBe(true);
  });

  it('memory 节点参数越界与图级约束', () => {
    const badLookback = JSON.parse(JSON.stringify(defaultGraphSpec(NOW))) as GraphSpec;
    (badLookback.nodes.find((n) => n.type === 'memory')!.config as Record<string, unknown>).lookbackDays = 400;
    expect(validateGraphSpec(badLookback).ok).toBe(false);

    const badLessons = JSON.parse(JSON.stringify(defaultGraphSpec(NOW))) as GraphSpec;
    (badLessons.nodes.find((n) => n.type === 'memory')!.config as Record<string, unknown>).maxLessons = 0;
    expect(validateGraphSpec(badLessons).ok).toBe(false);

    const conditional = JSON.parse(JSON.stringify(defaultGraphSpec(NOW))) as GraphSpec;
    conditional.edges.find((e) => e.source === 'memory')!.condition = {
      kind: 'debate_rounds',
      maxRounds: 2,
      whenDone: 'judge'
    };
    const res = validateGraphSpec(conditional);
    expect(!res.ok && res.code).toBe('E_GRAPH_INVALID');

    const twoMemory = JSON.parse(JSON.stringify(defaultGraphSpec(NOW))) as GraphSpec;
    twoMemory.nodes.push({
      ...twoMemory.nodes.find((n) => n.type === 'memory')!,
      id: 'memory2',
      position: { x: 40, y: 420 }
    });
    twoMemory.edges.push({ id: 'e-memory2-evidence', source: 'memory2', target: 'evidence' });
    const res2 = validateGraphSpec(twoMemory);
    expect(!res2.ok && res2.code).toBe('E_GRAPH_INVALID');
  });
});

describe('结构化解析兜底', () => {
  it('能从夹带文本中提取 JSON 对象', () => {
    const obj = extractFirstJsonObject('说明文字 {"a":1,"b":"} 不是结束"} 尾巴 {');
    expect(obj).toEqual({ a: 1, b: '} 不是结束' });
  });

  it('评级枚举非法时解析失败', () => {
    expect(
      parseFinalDecision(
        '{"rating":"bullish","confidence":0.5,"horizonDays":7,"thesis":"x","keyRisks":[],"nextCheckAt":"2026-11-10T00:00:00.000Z","reviewRequired":false}'
      )
    ).toBeNull();
  });

  it('解析失败回退 review，不默认 neutral；文本只认显式评级标签', () => {
    const review = reviewDecision(7, new Date(NOW));
    expect(review.rating).toBe('review');
    expect(review.reviewRequired).toBe(true);
    expect(ratingFromText('无法判断，市场可能上涨也可能下跌')).toBeNull();
    expect(ratingFromText('评级：强升温')).toBe('strong_up');
    expect(ratingFromText('评级：升温；评级：降温')).toBeNull();
  });
});
