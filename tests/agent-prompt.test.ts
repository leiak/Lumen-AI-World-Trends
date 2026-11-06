import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { MockProvider, type AiProvider, type ChatMessage } from '../electron/main/ai/provider.js';
import { AgentRuntime } from '../electron/main/agent/runtime.js';
import { defaultGraphSpec } from '../electron/main/agent/spec.js';
import {
  DEFAULT_PROMPT_TEMPLATES,
  renderPromptTemplate,
  validatePromptText,
  type PromptRenderVars
} from '../electron/main/agent/prompt-policy.js';
import type {
  AgentIpcResponse,
  AgentPromptsSaveRequest,
  AgentPromptRole,
  GraphSpec
} from '../shared/agent.js';

const NOW = '2026-11-03T10:00:00.000Z';
const SUBJECT = { key: 'topic:China', label: 'China', kind: 'topic' as const };

const MARK_A = 'CUSTOM-EVIDENCE-A：你是「世界趋势取证分析师」，围绕 {{subject.label}} 做热度取证。';
const MARK_B = 'CUSTOM-EVIDENCE-B：你是「世界趋势取证分析师」，只关注 {{subject.key}} 的动量变化。';

const SAMPLE_VARS: PromptRenderVars = {
  subject: { key: 'topic:example', label: '示例对象', kind: 'topic' },
  asOf: '2026-11-03T00:00:00.000Z',
  round: 2,
  memoryContext: '历史教训。'.repeat(400),
  evidenceSummary: '取证摘要。'.repeat(400)
};

let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs();
});

function newDb(): Database {
  const db = new SQL.Database();
  migrate(db);
  return db;
}

function expectOk<T>(res: AgentIpcResponse<T>): T {
  if (!res.ok) throw new Error(`expected ok, got ${res.code}: ${res.message}`);
  return res.data;
}

function makeRuntime(db: Database, provider: AiProvider, ids?: string[]): AgentRuntime {
  let i = 0;
  return new AgentRuntime({
    db,
    provider,
    mockProvider: new MockProvider(),
    persist: () => {},
    now: () => NOW,
    newRunId: () => ids?.[i++] ?? `run_prompt_${i}`
  });
}

function startRequest(forceMock: boolean): Parameters<AgentRuntime['startRun']>[0] {
  return {
    graphId: 'trend-analysis',
    subject: SUBJECT,
    asOf: NOW,
    options: { forceMock }
  };
}

function systemOf(messages: ChatMessage[]): string {
  return messages.find((m) => m.role === 'system')?.content ?? '';
}

describe('角色 prompt 保存前校验', () => {
  it('拒绝空/仅空白 prompt，issue 带 role 与 offset', () => {
    const empty = validatePromptText('evidence', '');
    expect(empty).toHaveLength(1);
    expect(empty[0]).toMatchObject({ code: 'E_VALIDATION', role: 'evidence', offset: 0 });
    const blank = validatePromptText('judge', '  \n\t  ');
    expect(blank[0].role).toBe('judge');
    expect(blank[0].offset).toBe(0);
  });

  it('单角色 800 字符上限：800 通过，801 拒绝并定位到上限偏移', () => {
    expect(validatePromptText('bull', 'a'.repeat(800))).toHaveLength(0);
    const over = validatePromptText('bull', 'a'.repeat(801));
    expect(over).toHaveLength(1);
    expect(over[0].role).toBe('bull');
    expect(over[0].offset).toBe(800);
    expect(over[0].message).toContain('800');
  });

  it('拒绝控制字符、双向覆盖符并给出精确偏移', () => {
    const control = validatePromptText('bear', 'hello\u0007world');
    expect(control[0]).toMatchObject({ role: 'bear', offset: 5 });
    expect(control[0].message).toContain('控制字符');
    const bidi = validatePromptText('bear', 'a\u202Eb');
    expect(bidi[0]).toMatchObject({ role: 'bear', offset: 1 });
  });

  it('占位符严格白名单：未知/非法/嵌套/不完整一律拒绝', () => {
    const unknown = validatePromptText('evidence', '看 {{env.ARK_API_KEY}}');
    expect(unknown[0]).toMatchObject({ role: 'evidence', offset: unknown[0].offset });
    expect(unknown[0].message).toContain('不允许的占位符');

    const block = validatePromptText('evidence', '{{#if flag}}x{{/if}}');
    expect(block.length).toBeGreaterThanOrEqual(1);
    expect(block.every((i) => i.role === 'evidence')).toBe(true);

    const nested = validatePromptText('evidence', '{{{{subject.key}}}}');
    expect(nested.some((i) => i.message.includes('嵌套') || i.message.includes('不完整'))).toBe(true);

    const incomplete = validatePromptText('evidence', '{{subject.key}');
    expect(incomplete.some((i) => i.message.includes('不完整'))).toBe(true);

    const ok = validatePromptText(
      'judge',
      '{{subject.label}} {{subject.key}} {{asOf}} {{round}} {{memory.lessons}} {{evidence.summary}}'
    );
    expect(ok).toHaveLength(0);
  });

  it('含模板样本渲染超过 1200 字符时拒绝', () => {
    const heavy = '{{memory.lessons}}'.repeat(9); // 模板 162 字符，样本渲染约 2160 字符
    expect(heavy.length).toBeLessThan(800);
    const issues = validatePromptText('planner', heavy);
    expect(issues).toHaveLength(1);
    expect(issues[0].role).toBe('planner');
    expect(issues[0].offset).toBe(0);
    expect(issues[0].message).toContain('1200');
  });
});

describe('prompt 版本包与 run 绑定', () => {
  it('保存生成不可变版本/摘要；重复保存复用版本；非法保存不产生新版本', () => {
    const db = newDb();
    const runtime = makeRuntime(db, new MockProvider());
    runtime.ensureDefaultGraph(defaultGraphSpec(NOW));

    const initial = expectOk(runtime.getPrompts({ graphId: 'trend-analysis' })).pack;
    expect(initial.version).toBe(0);
    expect(initial.isDefault).toBe(true);
    expect(initial.prompts).toEqual({});

    const v1 = expectOk(
      runtime.savePrompts({ graphId: 'trend-analysis', prompts: { evidence: MARK_A } })
    ).pack;
    expect(v1.version).toBe(1);
    expect(v1.isDefault).toBe(false);
    expect(v1.prompts.evidence).toBe(MARK_A);
    expect(v1.digest).not.toBe(initial.digest);

    const same = expectOk(
      runtime.savePrompts({ graphId: 'trend-analysis', prompts: { evidence: MARK_A } })
    ).pack;
    expect(same.version).toBe(1);
    expect(same.digest).toBe(v1.digest);

    const invalid = runtime.savePrompts({
      graphId: 'trend-analysis',
      prompts: { evidence: 'a'.repeat(801), bull: '{{env.ARK_API_KEY}}' }
    } as AgentPromptsSaveRequest);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.code).toBe('E_VALIDATION');
      const issues = (invalid.details as { issues?: Array<{ role: string; offset?: number }> }).issues ?? [];
      expect(issues.map((i) => i.role).sort()).toEqual(['bull', 'evidence']);
      expect(issues.every((i) => typeof i.offset === 'number')).toBe(true);
    }
    const afterInvalid = expectOk(runtime.getPrompts({ graphId: 'trend-analysis' })).pack;
    expect(afterInvalid.version).toBe(1);

    const unknownRole = runtime.savePrompts({
      graphId: 'trend-analysis',
      prompts: { oracle: 'x' }
    } as unknown as AgentPromptsSaveRequest);
    expect(unknownRole.ok).toBe(false);
    if (!unknownRole.ok) expect(unknownRole.message).toContain('未知 prompt 角色');
    db.close();
  });

  it('新 run 使用新 prompt，旧 run 回放保持启动时的 prompt 与摘要', async () => {
    const db = newDb();
    const captured: ChatMessage[][] = [];
    const recording: AiProvider = {
      name: 'mock',
      async generate(messages: ChatMessage[]) {
        captured.push(messages);
        return new MockProvider().generate(messages);
      }
    };
    const runtime = makeRuntime(db, recording, ['run_prompt_a', 'run_prompt_b']);
    runtime.ensureDefaultGraph(defaultGraphSpec(NOW));

    const packA = expectOk(
      runtime.savePrompts({ graphId: 'trend-analysis', prompts: { evidence: MARK_A } })
    ).pack;
    // forceMock=false 才会走注入的 recording provider，从而断言 prompt 文本真实进入调用。
    const runA = expectOk(await runtime.startRun(startRequest(false))).runId;
    await runtime.waitForRun(runA);
    const detailA = expectOk(runtime.getRun(runA));
    expect(detailA.status).toBe('interrupted');
    expect(detailA.prompt?.version).toBe(packA.version);
    expect(detailA.prompt?.digest).toBe(packA.digest);
    expect(detailA.prompt?.prompts.evidence).toBe(MARK_A);

    const evidenceCallsA = captured.filter((m) => systemOf(m).includes('CUSTOM-EVIDENCE-A'));
    expect(evidenceCallsA.length).toBeGreaterThan(0);
    expect(systemOf(evidenceCallsA[0]!)).toContain('China');
    expect(systemOf(evidenceCallsA[0]!)).toContain('只输出一个 JSON 对象');

    const packB = expectOk(
      runtime.savePrompts({ graphId: 'trend-analysis', prompts: { evidence: MARK_B } })
    ).pack;
    expect(packB.version).toBe(packA.version + 1);
    expect(packB.digest).not.toBe(packA.digest);

    // 历史 run 的 detail 来自 run 自身的 prompt_json，不随后续编辑串味。
    const replayA = expectOk(runtime.getRun(runA));
    expect(replayA.prompt?.version).toBe(packA.version);
    expect(replayA.prompt?.prompts.evidence).toBe(MARK_A);

    captured.length = 0;
    const runB = expectOk(await runtime.startRun(startRequest(false))).runId;
    await runtime.waitForRun(runB);
    const detailB = expectOk(runtime.getRun(runB));
    expect(detailB.prompt?.version).toBe(packB.version);
    expect(detailB.prompt?.digest).toBe(packB.digest);
    expect(detailB.prompt?.prompts.evidence).toBe(MARK_B);
    const evidenceCallsB = captured.filter((m) => systemOf(m).includes('CUSTOM-EVIDENCE-B'));
    expect(evidenceCallsB.length).toBeGreaterThan(0);
    expect(captured.some((m) => systemOf(m).includes('CUSTOM-EVIDENCE-A'))).toBe(false);

    const summaries = expectOk(runtime.listRuns({ limit: 10 }));
    const summaryA = summaries.find((r) => r.runId === runA);
    const summaryB = summaries.find((r) => r.runId === runB);
    expect(summaryA?.promptVersion).toBe(packA.version);
    expect(summaryA?.promptDigest).toBe(packA.digest);
    expect(summaryB?.promptVersion).toBe(packB.version);
    expect(summaryB?.promptDigest).toBe(packB.digest);

    // 恢复默认：提交默认模板等价于删除覆盖，生成新版本包且 isDefault。
    const restored = expectOk(
      runtime.savePrompts({
        graphId: 'trend-analysis',
        prompts: { evidence: DEFAULT_PROMPT_TEMPLATES.evidence }
      })
    ).pack;
    expect(restored.version).toBe(packB.version + 1);
    expect(restored.isDefault).toBe(true);
    expect(restored.prompts).toEqual({});
    expect(expectOk(runtime.getRun(runB)).prompt?.prompts.evidence).toBe(MARK_B);
    db.close();
  });
});

describe('prompt 渲染只做字符串替换', () => {
  it('占位符按白名单替换，用户文本中的 {{...}} 原样保留', () => {
    const vars: PromptRenderVars = {
      subject: { key: 'topic:{{env.ARK_API_KEY}}', label: '{{system}}', kind: 'topic' },
      asOf: NOW,
      round: 2,
      memoryContext: 'm',
      evidenceSummary: 'e'
    };
    const out = renderPromptTemplate('L={{subject.label}} K={{subject.key}} A={{asOf}} R={{round}}', vars);
    expect(out).toContain('K=topic:{{env.ARK_API_KEY}}');
    expect(out).toContain('L={{system}}');
    expect(out).toContain(`A=${NOW}`);
    expect(out).toContain('R=2');
  });

  it('渲染结果硬截断到 1200 字符', () => {
    const out = renderPromptTemplate('{{evidence.summary}}', {
      ...SAMPLE_VARS,
      evidenceSummary: 'x'.repeat(5000)
    });
    expect(out.length).toBe(1200);
  });
});
