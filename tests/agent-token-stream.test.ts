import { beforeAll, describe, expect, it } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { MockProvider } from '../electron/main/ai/provider.js';
import { AgentRuntime } from '../electron/main/agent/runtime.js';
import { defaultGraphSpec } from '../electron/main/agent/spec.js';
import type { AgentIpcResponse, EventsPage, RunEventEnvelope } from '../shared/agent.js';

const NOW = '2026-11-03T10:00:00.000Z';
const SUBJECT = { key: 'topic:China', label: 'China', kind: 'topic' as const };
const TOKEN_CAP = 8000;

let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs();
});

function expectOk<T>(res: AgentIpcResponse<T>): T {
  if (!res.ok) throw new Error(`expected ok, got ${res.code}: ${res.message}`);
  return res.data;
}

async function runToCompleted(db: Database, runId: string): Promise<AgentRuntime> {
  const runtime = new AgentRuntime({
    db,
    provider: new MockProvider(),
    mockProvider: new MockProvider(),
    persist: () => {},
    now: () => NOW,
    newRunId: () => runId
  });
  runtime.ensureDefaultGraph(defaultGraphSpec(NOW));
  const started = expectOk(
    await runtime.startRun({
      graphId: 'trend-analysis',
      subject: SUBJECT,
      asOf: NOW,
      options: { forceMock: true }
    })
  );
  await runtime.waitForRun(started.runId);
  const resumed = await runtime.resumeRun({
    runId: started.runId,
    resolution: { type: 'approve' }
  });
  expect(resumed.ok).toBe(true);
  await runtime.waitForRun(started.runId);
  expect(expectOk(runtime.getRun(started.runId)).status).toBe('completed');
  return runtime;
}

describe('P5 token 级流式', () => {
  it('Mock 分块流：分片顺序完整，拼合等于最终文本', async () => {
    const provider = new MockProvider();
    const messages = [
      { role: 'system' as const, content: '你是取证分析师' },
      { role: 'user' as const, content: '分析 China 热度' }
    ];
    const full = await provider.generate(messages);
    const chunks: string[] = [];
    const streamed = await provider.generateStream!(messages, (d) => chunks.push(d));
    expect(streamed).toBe(full);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(full);
    expect(chunks.every((c) => c.length <= 24)).toBe(true);
  });

  it('node.token：seq 连续、先 started 后 token 再 completed、增量可拼成完整 JSON', async () => {
    const db = new SQL.Database();
    migrate(db);
    const runtime = await runToCompleted(db, 'run_token_order');
    const page = expectOk(runtime.getEvents({ runId: 'run_token_order', afterSeq: 0 }));

    const seqs = page.events.map((e) => e.seq);
    expect(seqs[0]).toBe(1);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1] + 1);
    expect(page.nextSeq).toBe(seqs[seqs.length - 1]);
    expect(page.events[page.events.length - 1].event.type).toBe('run.completed');

    const tokens = page.events.filter((e) => e.event.type === 'node.token');
    expect(tokens.length).toBeGreaterThan(10);

    // 按节点+尝试聚合：token 必须在 started 之后、completed 之前。
    const grouped = new Map<string, RunEventEnvelope[]>();
    for (const e of tokens) {
      const ev = e.event as Extract<RunEventEnvelope['event'], { type: 'node.token' }>;
      const key = `${ev.nodeId}:${ev.attempt ?? 1}`;
      grouped.set(key, [...(grouped.get(key) ?? []), e]);
    }
    for (const [key, list] of grouped) {
      const [nodeId, attemptRaw] = key.split(':');
      const attempt = Number(attemptRaw);
      const started = page.events.find(
        (e) => e.event.type === 'node.started' && e.event.nodeId === nodeId && e.event.attempt === attempt
      );
      const completed = page.events.find(
        (e) =>
          (e.event.type === 'node.completed' || e.event.type === 'node.failed') &&
          e.event.nodeId === nodeId &&
          // node.completed/failed 不带 attempt，用 final 之外节点的单次执行近似
          e.seq > (started?.seq ?? 0)
      );
      expect(started, `缺少 ${key} 的 node.started`).toBeTruthy();
      expect(completed, `缺少 ${key} 的节点终态事件`).toBeTruthy();
      expect(list[0].seq).toBeGreaterThan(started!.seq);
      expect(list.every((e) => e.seq < completed!.seq)).toBe(true);
    }

    // Mock 输出均为 JSON：取 evidence 首轮，拼合分片应可完整解析。
    const evidenceText = grouped
      .get('evidence:1')
      ?.map((e) => (e.event as { delta: string }).delta)
      .join('');
    expect(evidenceText).toBeTruthy();
    expect(JSON.parse(evidenceText!)).toMatchObject({ dimension: 'heat' });

    // 单次调用 token 总量封顶 8000 字符。
    for (const [key, list] of grouped) {
      const chars = list.reduce((n, e) => n + (e.event as { delta: string }).delta.length, 0);
      expect(chars, `${key} token 字符数超上限`).toBeLessThanOrEqual(TOKEN_CAP);
    }
    db.close();
  });

  it('afterSeq 增量补拉：分页无重复无缺失，nextSeq 可续拉', async () => {
    const db = new SQL.Database();
    migrate(db);
    const runtime = await runToCompleted(db, 'run_token_after_seq');
    const all = expectOk(runtime.getEvents({ runId: 'run_token_after_seq', afterSeq: 0 }));

    const collected: RunEventEnvelope[] = [];
    let afterSeq = 0;
    for (let guard = 0; guard < 200; guard++) {
      const page: EventsPage = expectOk(
        runtime.getEvents({ runId: 'run_token_after_seq', afterSeq })
      );
      if (page.events.length === 0) break;
      collected.push(...page.events);
      afterSeq = page.nextSeq;
      if (afterSeq >= all.nextSeq) break;
    }
    expect(collected.map((e) => e.seq)).toEqual(all.events.map((e) => e.seq));
    expect(collected.map((e) => e.event.type)).toEqual(all.events.map((e) => e.event.type));

    // 已到达末尾后继续补拉：不返回旧事件。
    const tail = expectOk(
      runtime.getEvents({ runId: 'run_token_after_seq', afterSeq: all.nextSeq })
    );
    expect(tail.events).toHaveLength(0);
    expect(tail.nextSeq).toBe(all.nextSeq);
    db.close();
  });

  it('token 聚合落库：事件行数远小于字符数，且节点输出仍保存完整文本', async () => {
    const db = new SQL.Database();
    migrate(db);
    const runtime = await runToCompleted(db, 'run_token_growth');
    const page = expectOk(runtime.getEvents({ runId: 'run_token_growth', afterSeq: 0 }));
    const tokens = page.events.filter((e) => e.event.type === 'node.token');
    const totalChars = tokens.reduce(
      (n, e) => n + (e.event as { delta: string }).delta.length,
      0
    );
    expect(totalChars).toBeGreaterThan(200);
    // 80 字符聚合：行数 ≤ 字符数/20（远小于“每 token 一行”）。
    expect(tokens.length).toBeLessThanOrEqual(Math.ceil(totalChars / 20));

    // 节点输出（完整文本）不因 token 截断而丢失。
    const detail = expectOk(runtime.getRun('run_token_growth'));
    const evidence = detail.nodes.find((n) => n.nodeId === 'evidence');
    expect(evidence?.output).toBeTruthy();
    expect(JSON.stringify(evidence?.output).length).toBeGreaterThan(100);
    db.close();
  });

  it('真实点击前的基础校验：无 generateStream 的 provider 走非流式且不产生 token 事件', async () => {
    const db = new SQL.Database();
    migrate(db);
    const plain = {
      name: 'plain',
      generate: (messages: { role: string; content: string }[]) => new MockProvider().generate(messages as never)
    };
    const runtime = new AgentRuntime({
      db,
      provider: plain,
      mockProvider: plain,
      persist: () => {},
      now: () => NOW,
      newRunId: () => 'run_no_stream'
    });
    runtime.ensureDefaultGraph(defaultGraphSpec(NOW));
    const started = expectOk(
      await runtime.startRun({
        graphId: 'trend-analysis',
        subject: SUBJECT,
        asOf: NOW,
        options: { forceMock: true }
      })
    );
    await runtime.waitForRun(started.runId);
    expect(expectOk(runtime.getRun(started.runId)).status).toBe('interrupted');
    const page = expectOk(runtime.getEvents({ runId: started.runId, afterSeq: 0 }));
    expect(page.events.some((e) => e.event.type === 'node.token')).toBe(false);
    expectOk(await runtime.cancelRun(started.runId, 'user'));
    db.close();
  });
});
