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

async function launch(userDataDir, mockDelayMs = 60, extraEnv = {}) {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: ROOT,
    env: {
      ...process.env,
      // 仅 E2E：让 Mock 输出有可观察的耗时，稳定命中 running 态；不影响生产/单测。
      LUMEN_MOCK_DELAY_MS: String(mockDelayMs),
      ...extraEnv
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
  console.log('P6 E2E — Electron + Playwright\n');
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

  // ————————————————————————————————————————————————————————————————
  await scenario('S7 条件边编辑：非法目标被定位拒绝；修正后保存并真实路由到该 edgeId', async () => {
    const dirF = tmpDir('lumen-e2e-f');
    const dbF = path.join(dirF, 'lumen.db');
    let runIdF = '';
    const { app, page } = await launch(dirF);
    try {
      await openAgent(page);
      const beforeVersion = await page.getAttribute('[data-testid="agent-graph-version"]', 'data-version');
      await page.click('[data-testid="agent-edit-toggle"]');
      await page.waitForSelector('[data-testid="agent-editor-panel"]', { timeout: 20000 });
      await page.waitForSelector('[data-testid="agent-route-preview"]', { timeout: 20000 });

      // 保存前路由预览 → 点击定位到具体条件边。
      await page.click('[data-testid="agent-route-item"][data-edge-id="e-bull-bear"]');
      await page.waitForSelector('[data-testid="agent-edge-inspector"][data-edge-id="e-bull-bear"]', {
        timeout: 20000
      });
      const routeLabel = (await page.textContent('[data-testid="agent-edge-route-label"]')) ?? '';
      if (!routeLabel.includes('辩论：第 2 轮后')) throw new Error(`路由标签不可读：${routeLabel}`);

      // 非法目标（bull 条件边指向 judge）必须被拒并带 edgeId 定位。
      await page.selectOption('[data-testid="agent-edge-target"]', 'judge');
      await page.click('[data-testid="agent-editor-save"]');
      await page.waitForSelector('[data-testid="agent-editor-locate-edge"][data-edge-id="e-bull-bear"]', {
        timeout: 20000
      });
      const edgeError = (await page.textContent('[data-testid="agent-edge-error"]')) ?? '';
      if (!edgeError.includes('对立方')) throw new Error(`边级错误未定位到目标白名单：${edgeError}`);
      const stillDirty = await page.getAttribute('[data-testid="agent-edge-inspector"]', 'data-edge-id');
      if (stillDirty !== 'e-bull-bear') throw new Error('非法保存后未保留边选择/定位');

      // 修正目标后保存成功，图版本推进，错误清空。
      await page.selectOption('[data-testid="agent-edge-target"]', 'bear');
      await page.click('[data-testid="agent-editor-save"]');
      await page.waitForFunction(
        (prev) => {
          const el = document.querySelector('[data-testid="agent-graph-version"]');
          return !!el && el.getAttribute('data-version') !== prev;
        },
        beforeVersion,
        { timeout: 30000, polling: 25 }
      );
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="agent-editor-locate-edge"]').length === 0,
        null,
        { timeout: 20000, polling: 25 }
      );
      await page.click('[data-testid="agent-edit-toggle"]');

      // 真实运行：条件边必须进入 route.taken（落库断言具体 edgeId）。
      await page.waitForSelector('[data-testid="agent-start"]:not([disabled])', { timeout: 20000 });
      await page.click('[data-testid="agent-start"]');
      await page.waitForSelector('[data-testid="agent-approval"]', { timeout: 30000 });
      runIdF = (await page.textContent('[data-testid="agent-run-id"]')).trim();
    } finally {
      await closeApp(app);
    }

    const routes = await queryDb(dbF, (db) => {
      const r = db.exec(
        `SELECT payload_json FROM agent_run_event WHERE run_id = '${runIdF}' AND type = 'route.taken'`
      );
      return (r[0]?.values ?? []).map((v) => JSON.parse(v[0]));
    });
    const bullRoute = routes.find((e) => e.event?.from === 'bull');
    if (!bullRoute || bullRoute.event.edgeId !== 'e-bull-bear') {
      throw new Error(`route.taken 未指向保存的条件边：${JSON.stringify(routes.map((e) => e.event))}`);
    }
    if (!String(bullRoute.event.condition).includes('辩论：第 2 轮后')) {
      throw new Error(`route.taken 条件标签不可读：${bullRoute.event.condition}`);
    }
  });

  // ————————————————————————————————————————————————————————————————
  await scenario('S8 prompt 编辑：非法占位符定位拒绝；版本绑定且旧 run 回放不串味', async () => {
    const dirG = tmpDir('lumen-e2e-g');
    const dbG = path.join(dirG, 'lumen.db');
    let runIdG = '';
    let v1 = 0;
    let v2 = 0;
    const { app, page } = await launch(dirG);
    try {
      await openAgent(page);
      await page.click('[data-testid="agent-prompt-toggle"]');
      await page.waitForSelector('[data-testid="agent-prompt-editor"]', { timeout: 20000 });
      if (!(await page.textContent('[data-testid="agent-prompt-risk"]'))?.trim()) {
        throw new Error('prompt 编辑器缺少显式风险提示');
      }
      const startVersion = Number(
        await page.getAttribute('[data-testid="agent-prompt-version"]', 'data-version')
      );

      // 非法占位符：保存被拒，issue 可点击定位（role/offset）。
      await page.fill('[data-testid="agent-prompt-textarea-evidence"]', '{{env.ARK_API_KEY}}');
      if ((await page.getAttribute('[data-testid="agent-prompt-dirty"]', 'data-dirty')) !== '1') {
        throw new Error('编辑后未进入未保存态');
      }
      await page.click('[data-testid="agent-prompt-save"]');
      await page.waitForSelector('[data-testid="agent-prompt-issue"][data-role="evidence"]', {
        timeout: 20000
      });
      const issueText = (await page.textContent('[data-testid="agent-prompt-issue"]')) ?? '';
      if (!issueText.includes('不允许的占位符')) throw new Error(`占位符错误未定位：${issueText}`);
      const afterInvalid = Number(
        await page.getAttribute('[data-testid="agent-prompt-version"]', 'data-version')
      );
      if (afterInvalid !== startVersion) throw new Error('非法保存不应产生新版本');

      // 合法自定义 prompt 保存为 v1。
      const markerA = 'E2E-PROMPT-MARKER-A：你是「世界趋势取证分析师」，围绕 {{subject.label}} 取证。';
      await page.fill('[data-testid="agent-prompt-textarea-evidence"]', markerA);
      await page.click('[data-testid="agent-prompt-save"]');
      await page.waitForFunction(
        (prev) => {
          const el = document.querySelector('[data-testid="agent-prompt-version"]');
          return !!el && Number(el.getAttribute('data-version')) > prev;
        },
        startVersion,
        { timeout: 20000, polling: 25 }
      );
      if ((await page.getAttribute('[data-testid="agent-prompt-dirty"]', 'data-dirty')) !== '0') {
        throw new Error('保存成功后未清除未保存态');
      }
      v1 = Number(await page.getAttribute('[data-testid="agent-prompt-version"]', 'data-version'));
      await page.click('[data-testid="agent-prompt-close"]');

      await page.waitForSelector('[data-testid="agent-start"]:not([disabled])', { timeout: 20000 });
      await page.click('[data-testid="agent-start"]');
      await page.waitForSelector('[data-testid="agent-approval"]', { timeout: 30000 });
      runIdG = (await page.textContent('[data-testid="agent-run-id"]')).trim();
      const runPromptVersion = await page
        .locator('[data-testid="agent-run-prompt-version"]')
        .first()
        .getAttribute('data-version');
      if (Number(runPromptVersion) !== v1) throw new Error(`run 应绑定 v${v1}，实际 v${runPromptVersion}`);

      // 再次编辑为 v2：当前 run 回放仍必须使用 v1。
      await page.click('[data-testid="agent-prompt-toggle"]');
      await page.waitForSelector('[data-testid="agent-prompt-textarea-evidence"]', { timeout: 20000 });
      const markerB = 'E2E-PROMPT-MARKER-B：你是「世界趋势取证分析师」，只关注 {{subject.key}} 动量。';
      await page.fill('[data-testid="agent-prompt-textarea-evidence"]', markerB);
      await page.click('[data-testid="agent-prompt-save"]');
      await page.waitForFunction(
        (prev) => {
          const el = document.querySelector('[data-testid="agent-prompt-version"]');
          return !!el && Number(el.getAttribute('data-version')) > prev;
        },
        v1,
        { timeout: 20000, polling: 25 }
      );
      v2 = Number(await page.getAttribute('[data-testid="agent-prompt-version"]', 'data-version'));
      await page.click('[data-testid="agent-prompt-close"]');

      await page.click(`[data-testid="agent-run-row"][data-run-id="${runIdG}"]`);
      await page.waitForSelector('[data-testid="agent-approval"]', { timeout: 20000 });
      const replayVersion = await page
        .locator('[data-testid="agent-run-prompt-version"]')
        .first()
        .getAttribute('data-version');
      if (Number(replayVersion) !== v1) {
        throw new Error(`旧 run 回放串味：应为 v${v1}，实际 v${replayVersion}`);
      }
    } finally {
      await closeApp(app);
    }

    await queryDb(dbG, (db) => {
      const run = db.exec(
        `SELECT prompt_version, prompt_digest, prompt_json FROM agent_run WHERE run_id = '${runIdG}'`
      );
      const row = run[0]?.values[0];
      if (!row) throw new Error('run 记录缺少 prompt 绑定列');
      if (Number(row[0]) !== v1) throw new Error(`落库 prompt_version 应为 ${v1}，实际 ${row[0]}`);
      if (!String(row[2]).includes('E2E-PROMPT-MARKER-A')) throw new Error('落库 prompt_json 不是启动时版本');
      const packs = db.exec(`SELECT version, digest, is_active FROM agent_prompt_pack ORDER BY version`);
      const rows = packs[0]?.values ?? [];
      const active = rows.find((r) => Number(r[2]) === 1);
      if (!active || Number(active[0]) !== v2) throw new Error(`活动 prompt 版本应为 v${v2}`);
      const bound = rows.find((r) => Number(r[0]) === v1);
      if (!bound || row[1] !== bound[1]) throw new Error('run prompt_digest 与绑定版本包摘要不一致');
    });
  });

  // ————————————————————————————————————————————————————————————————
  // P7：任意断点续跑。进程 A 在 planner 执行中被强杀（非审批挂起），
  // 进程 B 启动后从 checkpoint 恢复；恢复不会重跑已完成节点，且仍遵守 final 审批闸门。
  await scenario('S9 中途强杀→重启→checkpoint 恢复→审批→completed（已完成节点不重跑）', async () => {
    const dirP = tmpDir('lumen-e2e-p');
    const dbP = path.join(dirP, 'lumen.db');
    let runIdP = '';

    // immediate：每个 checkpoint/write 同步落盘，强杀时进度不丢。
    // persist 间隔调大：避免后台定时 export，制造可预测的崩溃点。
    const a = await launch(dirP, 500, {
      LUMEN_CHECKPOINT_FLUSH: 'immediate',
      LUMEN_PERSIST_INTERVAL_MS: '600000'
    });
    try {
      await openAgent(a.page);
      await a.page.waitForSelector('[data-testid="agent-start"]:not([disabled])', { timeout: 20000 });
      await a.page.click('[data-testid="agent-start"]');
      // 等 planner 真正处于 running：此前 memory/evidence/辩论/judge 均已落库。
      await a.page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="agent-node-planner"]')
            ?.getAttribute('data-status') === 'running',
        null,
        { timeout: 30000, polling: 20 }
      );
      runIdP = (await a.page.textContent('[data-testid="agent-run-id"]')).trim();
      // 等一次同步 export 完成后强杀（此刻没有后台定时 export，窗口安全）。
      await new Promise((r) => setTimeout(r, 80));
      a.app.process()?.kill();
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      await closeApp(a.app);
    }

    const before = await queryDb(dbP, (db) => {
      const run = db.exec(
        `SELECT status, recovery_json, calls FROM agent_run WHERE run_id = '${runIdP}'`
      );
      const nodes = db.exec(
        `SELECT node_id, attempt, status, ended_at FROM agent_node_result WHERE run_id = '${runIdP}'`
      );
      const seq = db.exec(`SELECT MAX(seq) AS m FROM agent_run_event WHERE run_id = '${runIdP}'`);
      const cp = db.exec(`SELECT COUNT(*) AS n FROM agent_run_checkpoint WHERE run_id = '${runIdP}'`);
      const row = run[0]?.values[0] ?? [];
      return {
        status: row[0],
        recovery: row[1],
        calls: Number(row[2] ?? 0),
        nodes: (nodes[0]?.values ?? []).map((v) => ({
          nodeId: v[0],
          attempt: Number(v[1]),
          status: v[2],
          endedAt: v[3]
        })),
        maxSeq: Number(seq[0]?.values[0]?.[0] ?? 0),
        checkpoints: Number(cp[0]?.values[0]?.[0] ?? 0)
      };
    });
    if (before.status !== 'running') throw new Error(`强杀后应保留 running：${before.status}`);
    if (before.checkpoints < 1) throw new Error('强杀后磁盘上应有 checkpoint');
    if (before.nodes.filter((n) => n.status === 'succeeded').length < 4) {
      throw new Error('崩溃点过早：已成功节点不足以验证“不重跑”');
    }

    const b = await launch(dirP, 300, {
      LUMEN_CHECKPOINT_FLUSH: 'immediate',
      LUMEN_PERSIST_INTERVAL_MS: '600000'
    });
    try {
      await openAgent(b.page);
      const rowSel = `[data-testid="agent-run-row"][data-run-id="${runIdP}"]`;
      await b.page.waitForSelector(rowSel, { timeout: 20000 });
      const st = await b.page.getAttribute(rowSel, 'data-status');
      if (st !== 'interrupted') throw new Error(`启动恢复应标记 interrupted，实际 ${st}`);
      await b.page.click(rowSel);
      // 可恢复卡片（而非审批卡片）出现。
      await b.page.waitForSelector('[data-testid="agent-recovery"]', { timeout: 20000 });
      if (await b.page.isVisible('[data-testid="agent-approval"]')) {
        throw new Error('checkpoint 恢复不应展示审批卡');
      }
      const cpId = await b.page.getAttribute('[data-testid="agent-recovery"]', 'data-checkpoint-id');
      if (!cpId) throw new Error('恢复卡片缺少 checkpointId');
      await b.page.click('[data-testid="agent-recovery-resume"]');
      // 续跑会再次走到 final 审批闸门（P5 行为不被 P7 破坏）。
      await b.page.waitForSelector('[data-testid="agent-approval"]', { timeout: 30000 });
      await b.page.click('[data-testid="agent-approve"]');
      await waitStatus(b.page, 'completed', 30000);
      const rating = await b.page.getAttribute('[data-testid="agent-rating"]', 'data-rating');
      if (!rating) throw new Error('恢复完成后结论卡缺少评级');
    } finally {
      await closeApp(b.app);
    }

    const after = await queryDb(dbP, (db) => {
      const run = db.exec(
        `SELECT status, suspend_json, recovery_json, calls FROM agent_run WHERE run_id = '${runIdP}'`
      );
      const nodes = db.exec(
        `SELECT node_id, attempt, status, ended_at FROM agent_node_result WHERE run_id = '${runIdP}'`
      );
      const seq = db.exec(
        `SELECT seq, payload_json FROM agent_run_event WHERE run_id = '${runIdP}' ORDER BY seq`
      );
      const cp = db.exec(`SELECT COUNT(*) AS n FROM agent_run_checkpoint WHERE run_id = '${runIdP}'`);
      const row = run[0]?.values[0] ?? [];
      return {
        status: row[0],
        suspend: row[1],
        recovery: row[2],
        calls: Number(row[3] ?? 0),
        nodes: (nodes[0]?.values ?? []).map((v) => ({
          nodeId: v[0],
          attempt: Number(v[1]),
          status: v[2],
          endedAt: v[3]
        })),
        events: (seq[0]?.values ?? []).map((v) => ({ seq: Number(v[0]), payload: v[1] })),
        checkpoints: Number(cp[0]?.values[0]?.[0] ?? 0)
      };
    });
    if (after.status !== 'completed') throw new Error(`进程 B 完成后状态应为 completed：${after.status}`);
    if (after.suspend !== null || after.recovery !== null) throw new Error('完成后 suspend/recovery 未清理');
    if (after.checkpoints !== 0) throw new Error('完成后 checkpoint 未清理');
    if (after.calls <= before.calls) throw new Error('用量未累加（重启后 calls 未增长）');

    // 已成功节点：崩溃前的 (nodeId, attempt) 记录必须原样保留，且不新增 attempt。
    const beforeSucceeded = new Map(
      before.nodes
        .filter((n) => n.status === 'succeeded')
        .map((n) => [`${n.nodeId}:${n.attempt}`, n.status])
    );
    for (const [key] of beforeSucceeded) {
      const found = after.nodes.find((n) => key === `${n.nodeId}:${n.attempt}`);
      if (!found || found.status !== 'succeeded') {
        throw new Error(`已完成节点 ${key} 在恢复后丢失/被改写`);
      }
    }
    const beforeNodeCount = new Map();
    for (const n of before.nodes) beforeNodeCount.set(n.nodeId, (beforeNodeCount.get(n.nodeId) ?? 0) + 1);
    for (const n of after.nodes) {
      const wasComplete = [...beforeSucceeded.keys()].some((k) => k.startsWith(`${n.nodeId}:`));
      const beforeCount = beforeNodeCount.get(n.nodeId) ?? 0;
      const afterCount = after.nodes.filter((x) => x.nodeId === n.nodeId).length;
      if (wasComplete && afterCount > beforeCount) {
        throw new Error(`已完成节点 ${n.nodeId} 在恢复后新增了执行记录：${beforeCount} → ${afterCount}`);
      }
    }

    // seq 跨重启连续；run.resumed 出现在重启后；同一 (nodeId, attempt) 的 started 只有一次。
    const seqs = after.events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      if (seqs[i] !== seqs[i - 1] + 1) throw new Error(`seq 不连续：${seqs[i - 1]} → ${seqs[i]}`);
    }
    if (seqs[0] !== 1) throw new Error(`seq 应从 1 开始，实际 ${seqs[0]}`);
    if (after.events.length <= before.maxSeq) throw new Error('重启后没有新增事件');
    const startedKeys = new Map();
    for (const e of after.events) {
      let parsed;
      try {
        parsed = JSON.parse(e.payload);
      } catch {
        continue;
      }
      if (parsed.event?.type !== 'node.started') continue;
      const key = `${parsed.event.nodeId}#${parsed.event.attempt}`;
      startedKeys.set(key, (startedKeys.get(key) ?? 0) + 1);
    }
    // 崩溃前已成功的节点：同一 (nodeId, attempt) 的 started 只能有 1 次。
    // 崩溃瞬间仍在执行的节点不属于“已完成”，允许以同 attempt 重启并再次 started。
    const completedBefore = new Set(
      [...beforeSucceeded.keys()].map((k) => k.replace(':', '#'))
    );
    for (const [key, count] of startedKeys) {
      if (completedBefore.has(key) && count !== 1) {
        throw new Error(`已完成节点 ${key} 的 started 事件出现 ${count} 次`);
      }
    }
    const resumed = after.events.find((e) => {
      try {
        return JSON.parse(e.payload).event?.type === 'run.resumed';
      } catch {
        return false;
      }
    });
    if (!resumed || resumed.seq <= before.maxSeq) throw new Error('run.resumed 未出现在重启后的新 seq');
  });

  // ————————————————————————————————————————————————————————————————
  // M26：独立「股票AI分析」页签。导入内置样例 → 全链路 → 数字闸门 → 审批 → completed。
  await scenario('S10 股票AI分析页签：样例导入→运行→数字闸门→审批→completed', async () => {
    const dirH = tmpDir('lumen-e2e-h');
    const dbH = path.join(dirH, 'lumen.db');
    const { app, page } = await launch(dirH, 120);
    try {
      await page.click('[data-testid="nav-stock-agent"]');
      await page.waitForSelector('[data-testid="stock-start"]', { timeout: 20000 });
      await page.click('[data-testid="stock-import-sample"]');
      // 四层事实都应为 ok（样例包含行情/财报/公告/舆情）。
      await page.waitForFunction(
        () => {
          const els = [...document.querySelectorAll('[data-testid="stock-coverage"] [data-status]')];
          return els.length === 4 && els.every((e) => e.getAttribute('data-status') === 'ok');
        },
        null,
        { timeout: 20000, polling: 25 }
      );
      const layers = await page.$$eval('[data-testid="stock-coverage"] [data-status]', (els) =>
        els.map((e) => `${e.getAttribute('data-layer')}:${e.getAttribute('data-status')}`)
      );
      if (layers.join(',') !== 'market:ok,fundamentals:ok,disclosures:ok,news:ok') {
        throw new Error(`事实覆盖度异常：${layers.join(',')}`);
      }

      await page.click('[data-testid="stock-start"]');
      await page.waitForSelector('[data-testid="stock-approval"]', { timeout: 30000 });
      if ((await page.getAttribute('[data-testid="stock-run-state"]', 'data-status')) !== 'interrupted') {
        throw new Error('股票分析审批挂起后状态不是 interrupted');
      }
      if ((await page.getAttribute('[data-testid="stock-fact-check"]', 'data-ok')) !== 'true') {
        throw new Error('股票结论未通过数字闸门');
      }
      const rating = await page.getAttribute(
        '[data-testid="stock-conclusion"] .rating-badge',
        'data-rating'
      );
      if (!rating || rating === 'review') throw new Error(`四层齐备时不应是 ${rating}`);

      await page.click('[data-testid="stock-approve"]');
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="stock-run-state"]')?.getAttribute('data-status') ===
          'completed',
        null,
        { timeout: 30000, polling: 25 }
      );
      const doneRating = await page.getAttribute(
        '[data-testid="stock-conclusion"] .rating-badge',
        'data-rating'
      );
      if (!doneRating) throw new Error('completed 后股票结论卡缺少评级');
      // 智能体页签的历史不能被股票 run 污染。
      await page.click('[data-testid="nav-agent"]');
      await page.waitForSelector('[data-testid="agent-start"]', { timeout: 20000 });
      const agentRows = await page.$$eval('[data-testid="agent-run-row"]', (els) => els.length);
      if (agentRows !== 0) throw new Error(`股票页签运行污染了智能体历史：${agentRows} 行`);
    } finally {
      await closeApp(app);
    }

    const facts = await queryDb(dbH, (db) => {
      const run = db.exec(
        `SELECT run_id, graph_id, subject_kind, status FROM agent_run WHERE graph_id = 'stock-analysis' ORDER BY started_at DESC LIMIT 1`
      );
      const row = run[0]?.values[0] ?? null;
      const nodes = db.exec(
        `SELECT node_id, status FROM agent_node_result WHERE run_id = '${row?.[0] ?? ''}'`
      );
      const facts = db.exec(`SELECT COUNT(*) FROM stock_fact`);
      const gate = db.exec(
        `SELECT output_json FROM agent_node_result
         WHERE run_id = '${row?.[0] ?? ''}' AND node_id = 'fact_check'
         ORDER BY attempt DESC LIMIT 1`
      );
      const decision = db.exec(
        `SELECT status, baseline_json FROM agent_decision WHERE run_id = '${row?.[0] ?? ''}'`
      );
      return {
        row,
        nodes: (nodes[0]?.values ?? []).map((v) => ({ nodeId: v[0], status: v[1] })),
        factCount: Number(facts[0]?.values[0]?.[0] ?? 0),
        gate: gate[0]?.values[0]?.[0] ?? null,
        decision: decision[0]?.values[0] ?? null
      };
    });
    if (!facts.row) throw new Error('库中没有 stock-analysis 运行记录');
    if (facts.row[2] !== 'stock' || facts.row[3] !== 'completed') {
      throw new Error(`股票 run 落库异常：kind=${facts.row[2]} status=${facts.row[3]}`);
    }
    if (facts.factCount < 20) throw new Error(`stock_fact 写入过少：${facts.factCount}`);
    if (facts.nodes.filter((n) => n.nodeId === 'fact_check').length !== 1) {
      throw new Error('fact_check 节点应恰好执行一次');
    }
    if (facts.nodes.filter((n) => n.nodeId === 'judge').length !== 1) {
      throw new Error('judge 节点在审批恢复后被重跑');
    }
    if (!facts.gate || !facts.gate.includes('"ok":true')) throw new Error('fact_check 事件未记录通过');
    if (!facts.decision || facts.decision[0] !== 'pending' || !facts.decision[1]) {
      throw new Error('股票决策未留下 pending 基准快照（记忆结算缺少依据）');
    }
  });

  // ————————————————————————————————————————————————————————————————
  // M26 P0 收尾：股票页签开放图/prompt 编辑，且作用域严格隔离到 stock-analysis。
  await scenario('S11 股票页签图/prompt 编辑：只影响股票命名空间，智能体零串味', async () => {
    const dirI = tmpDir('lumen-e2e-i');
    const dbI = path.join(dirI, 'lumen.db');
    const TREND_DIGEST =
      '93e039e96961e019373ddb867419ea637c20d278cbc0538bddef73c3e48bb642';
    const { app, page } = await launch(dirI, 80);
    let stockSavedVersion = 0;
    try {
      await page.click('[data-testid="nav-stock-agent"]');
      await page.waitForSelector('[data-testid="stock-start"]', { timeout: 20000 });

      // 打开股票图编辑器：默认应加载 stock-analysis（含 fact_check 节点）。
      await page.click('[data-testid="stock-edit-toggle"]');
      await page.waitForSelector('[data-testid="agent-editor-panel"]', { timeout: 20000 });
      if (!(await page.locator('[data-testid="agent-node-fact_check"]').count())) {
        throw new Error('股票编辑器未加载 stock-analysis 图（缺少 fact_check 节点）');
      }
      // React Flow 节点在 fitView 缩放下可能被画布容器遮挡，直接向节点派发 click。
      await page.$eval('[data-testid="agent-node-market"]', (el) => {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      });
      await page.waitForSelector('[data-testid="agent-editor-inspector"]', { timeout: 20000 });
      const labelInput = page.locator('[data-testid="agent-editor-inspector"] input').first();
      await labelInput.fill('E2E-股票行情取证');
      if ((await page.getAttribute('[data-testid="agent-editor-status"]', 'data-dirty')) !== '1') {
        throw new Error('股票图编辑后未进入未保存态');
      }
      await page.click('[data-testid="agent-editor-save"]');
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="agent-editor-status"]')?.getAttribute('data-dirty') ===
          '0',
        null,
        { timeout: 20000, polling: 25 }
      );

      // 股票 prompt 编辑：作用域 data-graph-id 必须是 stock-analysis。
      await page.click('[data-testid="stock-edit-toggle"]');
      await page.click('[data-testid="stock-prompt-toggle"]');
      await page.waitForSelector('[data-testid="agent-prompt-editor"]', { timeout: 20000 });
      const promptScope = await page.getAttribute(
        '[data-testid="agent-prompt-editor"]',
        'data-graph-id'
      );
      if (promptScope !== 'stock-analysis') {
        throw new Error(`股票 prompt 编辑器作用域错误：${promptScope}`);
      }
      const stockStartVersion = Number(
        await page.getAttribute('[data-testid="agent-prompt-version"]', 'data-version')
      );
      await page.fill(
        '[data-testid="agent-prompt-textarea-evidence"]',
        'E2E-STOCK-PROMPT：围绕 {{subject.label}} 取证。'
      );
      await page.click('[data-testid="agent-prompt-save"]');
      await page.waitForFunction(
        (prev) => {
          const el = document.querySelector('[data-testid="agent-prompt-version"]');
          return !!el && Number(el.getAttribute('data-version')) > prev;
        },
        stockStartVersion,
        { timeout: 20000, polling: 25 }
      );
      stockSavedVersion = Number(
        await page.getAttribute('[data-testid="agent-prompt-version"]', 'data-version')
      );
      await page.click('[data-testid="agent-prompt-close"]');

      // 回到智能体页签：默认图 v4 与 prompt 均未被股票编辑污染。
      await page.click('[data-testid="nav-agent"]');
      await page.waitForSelector('[data-testid="agent-start"]', { timeout: 20000 });
      const trendVersion = await page.getAttribute('[data-testid="agent-graph-version"]', 'data-version');
      const trendDigest = await page.getAttribute('[data-testid="agent-graph-version"]', 'data-digest');
      if (Number(trendVersion) !== 4 || trendDigest !== TREND_DIGEST) {
        throw new Error(`智能体默认图被污染：v${trendVersion}/${trendDigest}`);
      }
      await page.click('[data-testid="agent-prompt-toggle"]');
      await page.waitForSelector('[data-testid="agent-prompt-editor"]', { timeout: 20000 });
      const agentPromptScope = await page.getAttribute(
        '[data-testid="agent-prompt-editor"]',
        'data-graph-id'
      );
      const agentPromptVersion = Number(
        await page.getAttribute('[data-testid="agent-prompt-version"]', 'data-version')
      );
      if (agentPromptScope !== 'trend-analysis' || agentPromptVersion !== 0) {
        throw new Error(`智能体 prompt 被污染：${agentPromptScope} v${agentPromptVersion}`);
      }

      // 再切回股票页签：fresh mount 仍必须落到 stock-analysis，且版本未被页面复用覆盖。
      await page.click('[data-testid="nav-stock-agent"]');
      await page.waitForSelector('[data-testid="stock-start"]', { timeout: 20000 });
      await page.click('[data-testid="stock-prompt-toggle"]');
      await page.waitForSelector('[data-testid="agent-prompt-editor"]', { timeout: 20000 });
      const stockScopeAgain = await page.getAttribute(
        '[data-testid="agent-prompt-editor"]',
        'data-graph-id'
      );
      const stockVersionAgain = Number(
        await page.getAttribute('[data-testid="agent-prompt-version"]', 'data-version')
      );
      if (stockScopeAgain !== 'stock-analysis' || stockVersionAgain !== stockSavedVersion) {
        throw new Error(`股票 prompt 页面状态串味：${stockScopeAgain} v${stockVersionAgain}`);
      }
    } finally {
      await closeApp(app);
    }

    await queryDb(dbI, (db) => {
      const graphs = db.exec(
        `SELECT graph_id, version, is_active, digest FROM agent_graph
         WHERE graph_id IN ('trend-analysis','stock-analysis') AND is_active = 1
         ORDER BY graph_id`
      );
      const graphRows = graphs[0]?.values ?? [];
      if (graphRows.length !== 2) throw new Error(`active 图数量异常：${graphRows.length}`);
      const trend = graphRows.find((r) => r[0] === 'trend-analysis');
      const stock = graphRows.find((r) => r[0] === 'stock-analysis');
      if (!trend) throw new Error('缺少 trend-analysis 图记录');
      if (Number(trend[1]) !== 4 || Number(trend[2]) !== 1) {
        throw new Error(`trend-analysis 版本/active 异常：v${trend[1]} active=${trend[2]}`);
      }
      if (trend[3] !== TREND_DIGEST) throw new Error(`trend-analysis digest 变化：${trend[3]}`);
      if (!stock || Number(stock[1]) !== 2 || Number(stock[2]) !== 1) {
        throw new Error(`stock-analysis 未生成独立 v2：${JSON.stringify(stock)}`);
      }

      const packs = db.exec(`SELECT graph_id, version, is_active, prompts_json FROM agent_prompt_pack`);
      const packRows = packs[0]?.values ?? [];
      if (packRows.length !== 1) throw new Error(`prompt 包数量异常：${packRows.length}`);
      const pack = packRows[0];
      if (pack[0] !== 'stock-analysis' || Number(pack[2]) !== 1) {
        throw new Error(`prompt 包作用域/active 异常：${JSON.stringify(pack)}`);
      }
      if (Number(pack[1]) !== stockSavedVersion) {
        throw new Error(`股票 prompt 版本落库不一致：v${pack[1]} vs UI v${stockSavedVersion}`);
      }
      if (!String(pack[3]).includes('E2E-STOCK-PROMPT')) {
        throw new Error('股票 prompt 未落库');
      }
    });
  });

  console.log('');
  const passed = results.filter((r) => r.ok).length;
  console.log(`E2E 结果：${passed}/${results.length} 通过`);
  if (failures > 0) {
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.error}`);
    process.exitCode = 1;
  }
  // Playwright 在异常场景下可能残留连接句柄，导致脚本跑完不退出；显式收尾。
  setTimeout(() => process.exit(process.exitCode ?? 0), 1000);
}

main().catch((err) => {
  console.error('E2E 执行失败：', err);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 1000);
});
