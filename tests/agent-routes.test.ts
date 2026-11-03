import { describe, it, expect } from 'vitest';
import {
  debateRound,
  riskRound,
  routeDebate,
  routeRisk
} from '../electron/main/agent/routes.js';
import type { DebateState, RiskDebateState } from '../shared/agent.js';

const ORDER = ['risk_aggressive', 'risk_conservative', 'risk_neutral'];

function debate(count: number, speaker: 'bull' | 'bear' | null, maxRounds = 2): DebateState {
  return { count, maxRounds, currentRound: debateRound(count), currentSpeaker: speaker, entries: [] };
}

describe('辩论条件路由（纯函数）', () => {
  it('maxRounds=0 边界：立即进入 whenDone', () => {
    expect(routeDebate(undefined, 0, 'judge')).toBe('judge');
    expect(routeDebate(debate(0, null, 0), 0, 'judge')).toBe('judge');
  });

  it('maxRounds=1：从 bull 开始，2 次发言后收敛到 judge', () => {
    expect(routeDebate(undefined, 1, 'judge')).toBe('bull');
    expect(routeDebate(debate(0, null, 1), 1, 'judge')).toBe('bull');
    expect(routeDebate(debate(1, 'bull', 1), 1, 'judge')).toBe('bear');
    expect(routeDebate(debate(2, 'bear', 1), 1, 'judge')).toBe('judge');
  });

  it('2 轮奇偶交替：bull→bear→bull→bear→judge', () => {
    expect(routeDebate(debate(0, null), 2, 'judge')).toBe('bull');
    expect(routeDebate(debate(1, 'bull'), 2, 'judge')).toBe('bear');
    expect(routeDebate(debate(2, 'bear'), 2, 'judge')).toBe('bull');
    expect(routeDebate(debate(3, 'bull'), 2, 'judge')).toBe('bear');
    expect(routeDebate(debate(4, 'bear'), 2, 'judge')).toBe('judge');
  });

  it('轮次边界：负数按 0 处理，超过上限仍收敛', () => {
    expect(routeDebate(debate(0, null), -1, 'judge')).toBe('judge');
    expect(routeDebate(debate(9, 'bull'), 2, 'judge')).toBe('judge');
  });

  it('轮次换算：每两次发言一轮', () => {
    expect(debateRound(0)).toBe(1);
    expect(debateRound(1)).toBe(1);
    expect(debateRound(2)).toBe(2);
    expect(debateRound(3)).toBe(2);
  });
});

function risk(count: number, maxRounds = 1, stance: RiskDebateState['currentStance'] = null): RiskDebateState {
  return { count, maxRounds, currentRound: riskRound(count), currentStance: stance, entries: [] };
}

describe('三方风控条件路由（纯函数）', () => {
  it('1 轮：按 order 轮转 3 次后进入 whenDone', () => {
    expect(routeRisk(undefined, 1, ORDER, 'final')).toBe('risk_aggressive');
    expect(routeRisk(risk(0), 1, ORDER, 'final')).toBe('risk_aggressive');
    expect(routeRisk(risk(1, 1, 'aggressive'), 1, ORDER, 'final')).toBe('risk_conservative');
    expect(routeRisk(risk(2, 1, 'conservative'), 1, ORDER, 'final')).toBe('risk_neutral');
    expect(routeRisk(risk(3, 1, 'neutral'), 1, ORDER, 'final')).toBe('final');
  });

  it('3 轮：9 次发言后收敛，轮次换算每 3 次为 1 轮', () => {
    expect(routeRisk(risk(0, 3), 3, ORDER, 'final')).toBe('risk_aggressive');
    expect(routeRisk(risk(4, 3), 3, ORDER, 'final')).toBe('risk_conservative');
    expect(routeRisk(risk(8, 3), 3, ORDER, 'final')).toBe('risk_neutral');
    expect(routeRisk(risk(9, 3), 3, ORDER, 'final')).toBe('final');
    expect(riskRound(0)).toBe(1);
    expect(riskRound(2)).toBe(1);
    expect(riskRound(3)).toBe(2);
    expect(riskRound(5)).toBe(2);
    expect(riskRound(6)).toBe(3);
  });

  it('边界：0/负数轮立即收敛，order 非法也收敛', () => {
    expect(routeRisk(undefined, 0, ORDER, 'final')).toBe('final');
    expect(routeRisk(risk(0, -1), -1, ORDER, 'final')).toBe('final');
    expect(routeRisk(risk(99), 1, ORDER, 'final')).toBe('final');
    expect(routeRisk(risk(0), 1, ['a'], 'final')).toBe('final');
  });
});
