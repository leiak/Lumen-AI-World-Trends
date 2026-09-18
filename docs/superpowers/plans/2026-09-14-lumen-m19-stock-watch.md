# M19 股票增强：自选股 + 周月K + 自动刷新 实现计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 M18 股票 Tab 基础上增强：① 自选股可管理（默认表 33 个标的，支持增删任意 A/港/美股代码，落库持久化）；② K 线支持 日K/周K/月K 三档；③ 主进程每 5 分钟自动刷新行情（`STOCK_REFRESH_MINUTES` 可调），渲染层轮询读缓存。

**Architecture:** schema v8：新增 `stock_watch`（symbol PK + name + market + sort），重建 `stock_kline`（新增 `period` 列，PK (symbol, period, date)，旧缓存作废重抓）。`db/stocks.ts` 增加 seed/load/add/removeWatch 与带 period 的 save/loadKline。`provider.ts` 的 `fetchKline`/`parseKlineResponse` 支持 period（响应键 `qfqday`/`qfqweek`/`qfqmonth`，已实测）。IPC 新增 `stocks:watch`（读）、`stocks:add`（先拉行情校验代码存在再入库）、`stocks:remove`；`stocks:history` 增 period 参数；`stocks:refresh` 改用入库自选股列表。主进程 `whenReady` 后 `seedDefaultWatch` 兜底 + `setInterval` 每 5 分钟刷新。UI：StocksTab 加「添加代码」输入行与每行移除按钮、K 线卡 日/周/月 周期切换、30s 轮询 `stocks:list` 展示自动刷新结果。

**Tech Stack:** Electron main (Node/TS), sql.js, axios, React, vitest。

**Spec:** `docs/superpowers/specs/2026-09-14-lumen-world-trends-design.md`（§股票）。

## Global Constraints
- **零新增依赖**；自选股为空时刷新回退 `DEFAULT_WATCHLIST`。
- `stocks:add` 必须经行情接口校验（代码无效返回错误），防脏数据。
- 契约收口 `shared/contracts.ts`（新增 3 通道，扩展 1 通道 payload）。
- i18n 新增 `stocks.watch.*` / `stocks.period.*` / `stocks.auto`（9 键 × 2，`i18n.test` 校验）。

---

### Task 1: 数据层（TDD）

**Files:**
- Modify: `shared/stocks.ts`（`KlinePeriod` / `StockHistoryRequest`）
- Modify: `electron/main/db/migrate.ts`（v8）
- Modify: `electron/main/stocks/provider.ts`（period）
- Modify/Test: `tests/stocks-provider.test.ts`、`tests/stocks-cache.test.ts`

- [x] Step 1 失败测试：watch 种子/增删/持久化；kline 按 period 存取；parseKlineResponse 周月键。
- [x] Step 2 实现 v8 迁移 + db 函数 + provider period。
- [x] Step 3 单测转绿、`tsc` 通过。

### Task 2: IPC + 主进程

**Files:**
- Modify: `shared/contracts.ts`、`electron/main/ipc/register.ts`、`electron/main/index.ts`

- [x] Step 4 `stocks:watch/add/remove`；`stocks:history` 增 period；`stocks:refresh` 读自选股。
- [x] Step 5 `seedDefaultWatch` + 5 分钟自动刷新定时器（`STOCK_REFRESH_MINUTES`）。

### Task 3: StocksTab UI

**Files:**
- Modify: `src/components/StocksTab.tsx`、`src/i18n/dict.ts`、`src/styles.css`

- [x] Step 6 添加/移除自选输入行；K 线卡日/周/月切换；30s 轮询列表；自动刷新提示。
- [x] Step 7 全量验证：`npm test` + `tsc` + `npm run build` + `LUMEN_SMOKE=1`。
- [x] Step 8 README 更新 + commit `feat: M19 stock watchlist, weekly/monthly kline & auto refresh`。
