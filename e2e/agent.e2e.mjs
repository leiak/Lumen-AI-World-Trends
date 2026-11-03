/**
 * P5-1 真实点击 E2E（Playwright Electron）。
 *
 * 与 `npm test`（vitest unit/integration）分离：本脚本不依赖 test runner，
 * 用 `_electron.launch` 启动打包后的应用，走真实 IPC + 真实 sql.js 持久化。
 *
 * 运行：npm run e2e
 */
import { _electron as electron } from 'playwright-core';
import initSqlJs from 'sql.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
let failures = 0;

async function scenario(name, fn) {
  const startedAt = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - startedAt });
    console.log(`  PASS  ${name} (${Date.now() - startedAt}ms)`);
  } catch (err) {
    failures += 1;
    results.push({ name, ok: false, ms: Date.now() - startedAt, error: err?.message ?? String(err) });
    console.log(`  FAIL  ${name}: ${err?.message ?? err}`);
  }
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

async function launch(userDataDir, mockDelayMs = 60) {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: ROOT,
    env: {
      ...process.env,
      // 仅 E2E：让 Mock 输出有可观察的耗时，稳定命中 running 态；不影响生产/单测。
      LUMEN_MOCK_DELAY_MS: String(mockDelayMs)
    },
    timeout: 30000
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="nav-agent"]', { timeout: 20000 });
  // 任何原生确认框都自动接受：E2E 不测原生弹窗本身，只测点击后的业务结果。
  page.on('dialog', (d) => void d.accept());
  return { app, page };
}

/** 关闭应用；close 卡住时兜底 kill，避免单场景超时拖垮整轮 E2E。 */
async function closeApp(app) {
  try {
    await Promise.race([
      app.close().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 8000))
    ]);
  } finally {
    try {
      app.process()?.kill();
    } catch {
      /* 已退出 */
    }
  }
}

async function openAgent(page) {
  await page.click('[data-testid="nav-agent"]');
  await page.waitForSelector('[data-testid="agent-start"]', { timeout: 20000 });
}

async function runStatus(page) {
  return page.locator('[data-testid="agent-run-state"]').getAttribute('data-status');
}

async function waitStatus(page, status, timeout = 30000) {
  await page.waitForFunction(
    (want) =>
      document.querySelector('[data-testid="agent-run-state"]')?.getAttribute('data-status') === want,
    status,
    { timeout, polling: 25 }
  );
}

/** 事件/条件等待：不 sleep，只等 UI 条件成立。 */
async function waitCount(page, selector, min, timeout = 20000) {
  await page.waitForFunction(
    ([sel, n]) => document.querySelectorAll(sel).length >= n,
    [selector, min],
    { timeout, polling: 25 }
  );
}

function readDb(dbPath) {
  // 仅用于断言持久化事实（run 状态 / 图版本 / seq）；不参与业务逻辑。
  return fs.readFileSync(dbPath);
}

let SQLPromise = null;

/** 只读打开落盘库，用于跨进程断言（不会写回）。 */
async function queryDb(dbPath, fn) {
  SQLPromise ??= initSqlJs();
  const SQL = await SQLPromise;
  const db = new SQL.Database(readDb(dbPath));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function main() {
  console.log('P5 E2E — Electron + Playwright\n');
  const dirA = tmpDir('lumen-e2e-a');
  const dbA = path.join(dirA, 'lumen.db');

  let runId = '';
  let graphVersion = '';
  let graphDigest = '';
  let nodeResults = [];

  // ————————————————————————————————————————————————————————————————
  await scenario('S1 导航→运行→四态→辩论→审批→completed+评级', async () => {
    const { app, page } = await launch(dirA);
    try {
      await openAgent(page);
      await page.waitForSelector('[data-testid="agent-start"]:not([disabled])', { timeout: 20000 });

      // 初始：所有节点 pending。
      await page.waitForFunction(
        () => {
          const cards = [...document.querySelectorAll('[data-testid^="agent-node-"][data-status]')];
          return cards.length > 0 && cards.every((c) => c.getAttribute('data-status') === 'pending');
        },
        null,
        { timeout: 20000, polling: 25 }
      );

      graphVersion = await page.getAttribute('[data-testid="agent-graph-version"]', 'data-version');
      graphDigest = await page.getAttribute('[data-testid="agent-graph-version"]', 'data-digest');
      if (!graphVersion || !graphDigest) throw new Error('缺少图版本/摘要展示');

      await page.click('[data-testid="agent-start"]');

      // 节点四态中的 running 必须真实出现（Mock 有 60ms/节点，poll 25ms）。
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('[data-testid^="agent-node-"][data-status]')].some(
            (c) => c.getAttribute('data-status') === 'running'
          ),
        null,
        { timeout: 20000, polling: 20 }
      );

      await page.waitForSelector('[data-testid="agent-approval"]', { timeout: 30000 });
      if ((await runStatus(page)) !== 'interrupted') throw new Error('审批挂起后状态不是 interrupted');
      await waitCount(page, '[data-testid="agent-debate-item"]', 2);

      const debateStances = await page.$$eval('[data-testid="agent-debate-item"]', (els) =>
        els.map((e) => e.getAttribute('data-stance'))
      );
      if (!debateStances.includes('bull') || !debateStances.includes('bear')) {
        throw new Error(`辩论缺少 bull/bear：${debateStances.join(',')}`);
      }

      runId = (await page.textContent('[data-testid="agent-run-id"]')).trim();
      if (!/^run_/.test(runId)) throw new Error(`runId 异常：${runId}`);

      await page.click('[data-testid="agent-approve"]');
      await waitStatus(page, 'completed', 30000);

      const rating = await page.getAttribute('[data-testid="agent-rating"]', 'data-rating');
      if (!rating) throw new Error('结论卡缺少评级');
      const doneCount = await page.$$eval(
        '[data-testid^="agent-node-"][data-status]',
        (els) => els.filter((e) => e.getAttribute('data-status') === 'done').length
      );
      if (doneCount < 5) throw new Error(`completed 后 done 节点过少：${doneCount}`);
    } finally {
      await closeApp(app);
    }
  });

  // ————————————————————————————————————————————————————————————————
  await scenario('S2 关闭后重启：历史列表可回看该 run', async () => {
    const { app, page } = await launch(dirA);
    try {
      await openAgent(page);
      await page.waitForSelector(`[data-testid="agent-run-row"][data-run-id="${runId}"]`, {
        timeout: 20000
      });
      const status = await page.getAttribute(
        `[data-testid="agent-run-row"][data-run-id="${runId}"]`,
        'data-status'
      );
      if (status !== 'completed') throw new Error(`历史状态应为 completed，实际 ${status}`);

      await page.click(`[data-testid="agent-run-row"][data-run-id="${runId}"]`);
      await waitStatus(page, 'completed', 20000);
      const historyVersion = await page.getAttribute('[data-testid="agent-graph-version"]', 'data-version');
      if (historyVersion !== graphVersion) {
        throw new Error(`历史回放图版本应为 ${graphVersion}，实际 ${historyVersion}`);
      }

      // 记忆面板手动结算：真实点击 + 回显。
      await page.click('[data-testid="agent-memory-settle"]');
      await page.waitForSelector('[data-testid="agent-memory-settle-note"]', { timeout: 20000 });
      const note = (await page.textContent('[data-testid="agent-memory-settle-note"]')).trim();
      if (!note) throw new Error('结算回显为空');
    } finally {
      await closeApp(app);
    }
  });

  // ————————————————————————————————————————————————————————————————
  await scenario('S3 编辑器：非法图被拒并定位节点；恢复默认 v4', async () => {
    const dirB = tmpDir('lumen-e2e-b');
    const { app, page } = await launch(dirB);
    try {
      await openAgent(page);
      await page.click('[data-testid="agent-edit-toggle"]');
      await page.waitForSelector('[data-testid="agent-editor-panel"]', { timeout: 20000 });

      // 合法结构里再加一个 final → 图级“多余终端”错误，应定位到新节点（id 由编辑器生成）。
      await page.selectOption('[data-testid="agent-editor-add"]', 'final');
      const newFinalId = await page
        .waitForFunction(
          () => {
            const els = [...document.querySelectorAll('[data-testid^="agent-node-"][data-node-type="final"]')];
            const extra = els.find((e) => e.getAttribute('data-testid') !== 'agent-node-final');
            return extra ? extra.getAttribute('data-testid').replace('agent-node-', '') : null;
          },
          null,
          { timeout: 10000, polling: 25 }
        )
        .then((h) => h.jsonValue());
      if (!newFinalId) throw new Error('新增 final 节点未出现在画布');

      await page.click('[data-testid="agent-editor-save"]');
      await page.waitForSelector('[data-testid="agent-editor-issue"]', { timeout: 20000 });

      const issues = await page.$$eval('[data-testid="agent-editor-issue"]', (els) =>
        els.map((e) => ({ code: e.getAttribute('data-code'), nodeId: e.getAttribute('data-node-id') }))
      );
      if (!issues.some((i) => i.nodeId === newFinalId)) {
        throw new Error(`错误未定位到 ${newFinalId}：${JSON.stringify(issues)}`);
      }

      // 点击定位 → 选中该节点，详情标题与编辑器检查器同步。
      await page.click(`[data-testid="agent-editor-locate"][data-node-id="${newFinalId}"]`);
      await page.waitForFunction(
        (id) => document.querySelector('[data-testid="agent-editor-inspector"]')?.textContent?.includes(id),
        newFinalId,
        { timeout: 10000, polling: 25 }
      );

      // 恢复默认：确认弹窗由 launch 的 dialog 处理器自动接受。
      await page.click('[data-testid="agent-editor-restore"]');
      await page.waitForFunction(
        () => {
          const v = document.querySelector('[data-testid="agent-graph-version"]');
          return v && v.getAttribute('data-version') === '4';
        },
        null,
        { timeout: 20000, polling: 25 }
      );

      const dirty = await page.getAttribute('[data-testid="agent-editor-status"]', 'data-dirty');
      if (dirty !== '0') throw new Error('恢复默认后编辑器仍为 dirty');
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="agent-editor-issue"]').length === 0,
        null,
        { timeout: 10000, polling: 25 }
      );
      const nodeCount = await page.$$eval('[data-testid^="agent-node-"]', (els) =>
        els.filter((e) => e.hasAttribute('data-status') || e.hasAttribute('data-terminal')).length
      );
      // 默认 v4：10 个业务节点 + 编辑态 __start__/__end__ = 12
      if (nodeCount !== 12) throw new Error(`恢复默认后节点数应为 12，实际 ${nodeCount}`);
    } finally {
      await closeApp(app);
    }
  });

  // ————————————————————————————————————————————————————————————————
  await scenario('S4 运行中不因未保存改动偷偷跑旧图（编辑器侧拦截）', async () => {
    const dirC = tmpDir('lumen-e2e-c');
    const { app, page } = await launch(dirC);
    try {
      await openAgent(page);
      await page.click('[data-testid="agent-edit-toggle"]');
      await page.waitForSelector('[data-testid="agent-editor-panel"]', { timeout: 20000 });
      await page.selectOption('[data-testid="agent-editor-add"]', 'planner');
      await page.waitForFunction(
        () => document.querySelector('[data-testid="agent-editor-status"]')?.getAttribute('data-dirty') === '1',
        null,
        { timeout: 10000, polling: 25 }
      );
      await page.click('[data-testid="agent-start"]');
      await page.waitForSelector('[data-testid="agent-start-blocked"]', { timeout: 10000 });
      const status = await runStatus(page);
      if (status === 'running') throw new Error('未保存改动时仍发起了运行');
    } finally {
      await closeApp(app);
    }
  });

  // ————————————————————————————————————————————————————————————————
  await scenario('S5 跨进程重启：A 挂起退出 → B 恢复审批 → completed 且节点不重跑', async () => {
    const dirD = tmpDir('lumen-e2e-d');
    const dbD = path.join(dirD, 'lumen.db');
    let runIdD = '';
    const a = await launch(dirD);
    try {
      await openAgent(a.page);
      await a.page.waitForSelector('[data-testid="agent-start"]:not([disabled])', { timeout: 20000 });
      await a.page.click('[data-testid="agent-start"]');
      await a.page.waitForSelector('[data-testid="agent-approval"]', { timeout: 30000 });
      runIdD = (await a.page.textContent('[data-testid="agent-run-id"]')).trim();
    } finally {
      await closeApp(a.app);
    }

    // 进程 A 已退出：库里应保留 interrupted + suspend_json 快照。
    const before = await queryDb(dbD, (db) => {
      const r = db.exec(
        `SELECT status, suspend_json, graph_version FROM agent_run WHERE run_id = '${runIdD}'`
      );
      const nodes = db.exec(
        `SELECT node_id, attempt, status, ended_at FROM agent_node_result WHERE run_id = '${runIdD}'`
      );
      const seq = db.exec(`SELECT MAX(seq) AS m FROM agent_run_event WHERE run_id = '${runIdD}'`);
      const row = r[0]?.values[0] ?? [];
      return {
        status: row[0],
        snapshot: typeof row[1] === 'string' ? JSON.parse(row[1]) : null,
        graphVersion: row[2],
        nodes: (nodes[0]?.values ?? []).map((v) => ({
          nodeId: v[0],
          attempt: v[1],
          status: v[2],
          endedAt: v[3]
        })),
        maxSeq: seq[0]?.values[0]?.[0] ?? 0
      };
    });
    if (before.status !== 'interrupted') throw new Error(`进程 A 退出后状态应为 interrupted：${before.status}`);
    if (!before.snapshot || before.snapshot.v !== 1) throw new Error('挂起快照缺失或版本不符');
    if (before.nodes.filter((n) => n.status === 'skipped').length !== 1) {
      throw new Error('挂起时应只有 final 一个 skipped 节点');
    }

    // 进程 B：同一个 user-data-dir 重新启动，真实点击历史 → 批准 → completed。
    const b = await launch(dirD);
    try {
      await openAgent(b.page);
      const rowSel = `[data-testid="agent-run-row"][data-run-id="${runIdD}"]`;
      await b.page.waitForSelector(rowSel, { timeout: 20000 });
      const st = await b.page.getAttribute(rowSel, 'data-status');
      if (st !== 'interrupted') throw new Error(`进程 B 历史状态应为 interrupted，实际 ${st}`);
      await b.page.click(rowSel);
      await b.page.waitForSelector('[data-testid="agent-approval"]', { timeout: 20000 });
      await b.page.click('[data-testid="agent-approve"]');
      await waitStatus(b.page, 'completed', 30000);
      const rating = await b.page.getAttribute('[data-testid="agent-rating"]', 'data-rating');
      if (!rating) throw new Error('重启恢复后结论卡缺少评级');
    } finally {
      await closeApp(b.app);
    }

    const after = await queryDb(dbD, (db) => {
      const nodes = db.exec(
        `SELECT node_id, attempt, status, ended_at FROM agent_node_result WHERE run_id = '${runIdD}'`
      );
      const seq = db.exec(`SELECT seq FROM agent_run_event WHERE run_id = '${runIdD}' ORDER BY seq`);
      const run = db.exec(`SELECT status, suspend_json FROM agent_run WHERE run_id = '${runIdD}'`);
      return {
        nodes: (nodes[0]?.values ?? []).map((v) => ({
          nodeId: v[0],
          attempt: v[1],
          status: v[2],
          endedAt: v[3]
        })),
        seqs: (seq[0]?.values ?? []).map((v) => v[0]),
        status: run[0]?.values[0]?.[0],
        snapshot: run[0]?.values[0]?.[1] ?? null
      };
    });
    if (after.status !== 'completed') throw new Error(`进程 B 完成后状态应为 completed：${after.status}`);
    if (after.snapshot !== null) throw new Error('完成后挂起快照未清理');

    const finalRows = after.nodes.filter((n) => n.nodeId === 'final');
    if (finalRows.length !== 2) throw new Error(`final 应有 skipped+succeeded 两条，实际 ${finalRows.length}`);
    if (
      !finalRows.some((n) => n.attempt === 1 && n.status === 'skipped') ||
      !finalRows.some((n) => n.attempt === 2 && n.status === 'succeeded')
    ) {
      throw new Error(`final 尝试序列异常：${JSON.stringify(finalRows)}`);
    }
    // 已完成节点不重跑：非 final 节点只保留挂起前唯一一条记录。
    // 以 (nodeId, attempt) 为键：bull/bear 多轮会有多条记录，不能按 nodeId 覆盖。
    const beforeNonFinal = new Map(
      before.nodes
        .filter((n) => n.nodeId !== 'final')
        .map((n) => [`${n.nodeId}:${n.attempt}`, `${n.status}:${n.endedAt ?? ''}`])
    );
    for (const n of after.nodes.filter((x) => x.nodeId !== 'final')) {
      if (beforeNonFinal.get(`${n.nodeId}:${n.attempt}`) !== `${n.status}:${n.endedAt ?? ''}`) {
        throw new Error(`节点 ${n.nodeId}#${n.attempt} 在恢复后被重跑或改写`);
      }
    }
    if (after.nodes.length !== before.nodes.length + 1) {
      throw new Error(`恢复后节点记录数应只多 final 一次：${before.nodes.length} → ${after.nodes.length}`);
    }
    // seq 跨重启单调且连续；run.resumed 必须出现在重启后的新序号上。
    for (let i = 1; i < after.seqs.length; i++) {
      if (after.seqs[i] !== after.seqs[i - 1] + 1) {
        throw new Error(`seq 不连续：${after.seqs[i - 1]} → ${after.seqs[i]}`);
      }
    }
    if (after.seqs[0] !== 1) throw new Error(`seq 应从 1 开始，实际 ${after.seqs[0]}`);
    if (after.seqs.length <= before.maxSeq) throw new Error('重启后没有新增事件');
  });

  // ————————————————————————————————————————————————————————————————
  await scenario('S6 token 流式：运行中节点增量文本可见且持续增长', async () => {
    const dirE = tmpDir('lumen-e2e-e');
    // 调大 Mock 延迟，给“运行中增量文本”一个稳定的可观察窗口。
    const { app, page } = await launch(dirE, 300);
    try {
      await openAgent(page);
      await page.waitForSelector('[data-testid="agent-start"]:not([disabled])', { timeout: 20000 });
      await page.click('[data-testid="agent-start"]');

      // 画布节点上的尾部增量文本。
      await page.waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="agent-node-stream"]');
          return !!el && el.textContent.trim().length > 0;
        },
        null,
        { timeout: 30000, polling: 20 }
      );
      if ((await runStatus(page)) !== 'running') throw new Error('增量文本出现时运行已不在 running 态');

      // 找到正在流式的节点并打开详情，确认完整增量文本而非仅尾部 26 字。
      const streamingNode = await page
        .waitForFunction(
          () => {
            const el = document.querySelector('[data-testid="agent-node-stream"]');
            const node = el?.closest('[data-testid^="agent-node-"]');
            return node?.getAttribute('data-testid') ?? null;
          },
          null,
          { timeout: 10000, polling: 20 }
        )
        .then((h) => h.jsonValue());
      if (!streamingNode) throw new Error('未找到承载增量文本的节点');
      await page.click(`[data-testid="${streamingNode}"]`);
      await page.waitForSelector('[data-testid="agent-node-stream-detail"]', { timeout: 10000 });
      const before = (await page.textContent('[data-testid="agent-node-stream-detail"]')) ?? '';
      await page.waitForFunction(
        (prev) => {
          const el = document.querySelector('[data-testid="agent-node-stream-detail"]');
          return !!el && el.textContent.length > prev.length;
        },
        before,
        { timeout: 10000, polling: 20 }
      );

      // 流式不破坏既有终态：继续跑到审批挂起。
      await page.waitForSelector('[data-testid="agent-approval"]', { timeout: 30000 });
      if ((await runStatus(page)) !== 'interrupted') throw new Error('流式后未正常进入审批挂起');
    } finally {
      await closeApp(app);
    }
  });

  console.log('');
  const passed = results.filter((r) => r.ok).length;
  console.log(`E2E 结果：${passed}/${results.length} 通过`);
  if (failures > 0) {
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.error}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('E2E 执行失败：', err);
  process.exitCode = 1;
});
