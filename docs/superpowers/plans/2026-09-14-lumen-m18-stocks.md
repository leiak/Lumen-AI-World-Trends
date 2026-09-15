# M18 股票行情 Tab 实现计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增「股票」Tab：爬取公开免费行情数据（腾讯行情 qt.gtimg.cn 实时报价 + ifzq.gtimg.cn 日 K，无需 API Key、零新依赖）并本地缓存，展示指数/A股/港股/美股快照表与 ECharts K 线图，离线可看上次缓存。

**Architecture:** 主进程新增 `stocks/provider.ts`（`StockProvider` 接口 + `TencentStockProvider`（axios + GBK 解码 TextDecoder(‘gbk’) + 解析函数可单测）+ `MockStockProvider`（离线确定性假数据，供测试/兜底））、`stocks/watchlist.ts`（内置 8 指数 + A/HK/US 约 30 标的）与 `db/stocks.ts`（新表 `stock_quote` / `stock_kline`，schema v7）。IPC 新增 `stocks:list`（读缓存）/ `stocks:refresh`（拉取+落库，失败回退缓存）/ `stocks:history`（读缓存，无则拉取+落库，payload `{symbol}`）。渲染层新增 `src/components/StocksTab.tsx`：报价表（名称/代码/最新价/涨跌/涨跌幅，红涨绿跌）+ K 线（candlestick + 成交量，ECharts dataZoom），App 导航加入「股票」。

**Tech Stack:** Electron main (Node/TS), axios, TextDecoder(GBK), sql.js, ECharts, React, vitest。

**Spec:** `docs/superpowers/specs/2026-09-14-lumen-world-trends-design.md`（§桌面看板）。

## Global Constraints
- **零新增依赖**（无 iconv，GBK 用内置 TextDecoder）。
- 行情源为公网免费接口，仅主进程 Node 请求（无 CORS）；测试全部用 fixture/mock，不发网络。
- schema 加 v7（新表），契约经 `shared/contracts.ts` 收口（新增 3 通道）。
- i18n 新增 `nav.stocks` / `stocks.*`（16 键 × 2，`i18n.test` 校验集合一致）。

---

### Task 1: 数据层（TDD）

**Files:**
- Create: `shared/stocks.ts`（`StockQuote` / `StockKPoint` / `StocksView` / `StockHistoryResult`）
- Create: `electron/main/stocks/watchlist.ts`（默认标的表）
- Test: `tests/stocks-provider.test.ts`（解析 fixture：报价行 / K 线 JSON / Mock）

- [x] Step 1 失败测试：quote 行解析（字段位：名/价/昨收/涨跌额/涨跌幅/高低/时间）、K 线 JSON 解析、Mock 确定性。
- [x] Step 2 实现 `provider.ts`（parseQuoteLine / parseKlineResponse / TencentProvider / MockProvider）。
- [x] Step 3 `tsc` 通过、单测转绿。

### Task 2: 本地缓存（TDD）

**Files:**
- Modify: `electron/main/db/migrate.ts`（schema v7：`stock_quote` / `stock_kline`）
- Create: `electron/main/db/stocks.ts`（save/loadQuotes / save/loadKline / latestCacheTime）
- Test: `tests/stocks-cache.test.ts`

- [x] Step 4 失败测试：quotes round-trip、kline round-trip、空库回退、最新时间。
- [x] Step 5 实现缓存模块 + 迁移。
- [x] Step 6 单测转绿。

### Task 3: IPC + Tab UI

**Files:**
- Modify: `shared/contracts.ts` + `electron/main/ipc/register.ts` + `electron/main/index.ts`
- Create: `src/components/StocksTab.tsx`；Modify: `src/App.tsx`、`src/i18n/dict.ts`、`src/styles.css`

- [x] Step 7 契约/注册/handler：`stocks:list` / `stocks:refresh`（失败回退缓存）/ `stocks:history`。
- [x] Step 8 StocksTab：导航「股票」、报价表（红涨绿跌）、刷新、点击行 → K 线 candlestick + 成交量；空缓存自动刷新。
- [x] Step 9 全量验证：`npm test` + `tsc` + `npm run build` + `LUMEN_SMOKE=1`。
- [x] Step 10 README（特性/看板/导航/结构/IPC/测试）+ commit `feat: M18 stocks tab with cached quotes & kline`。
