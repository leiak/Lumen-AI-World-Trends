# M20 股票叠加进世界/趋势分析 实现计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 M18/M19 本地缓存的股票行情叠进分析视图：① 趋势 Tab 新增「大盘与热点联动」卡 —— 指数日K 收盘线（右轴）叠加在 Top 热点热度线（左轴）同一时间轴上，双 Y 轴观察市场与新闻热度同异动（红涨绿跌）；② 世界 Tab 顶部新增「全球市场冷暖」卡 —— 从行情缓存展示 9 大指数当日涨跌幅 chips。

**Architecture:** 纯渲染层 + 共享常量，**零新 IPC / schema 变更**：新增 `shared/stocks.ts` 常量 `MARKET_INDEX_SYMBOLS`（上证/沪深300/深成/创业板/恒生/国企/道指/纳指/标普）与 `src/stocks/overlay.ts` 纯函数 `buildOverlaySeries(buckets, kline)`（把趋势桶 ISO `bucketStart` 的日期前缀 `slice(0,10)` 对齐 K 线日期，缺交易日留 null 断线，x 标签复用趋势桶 `slice(5,16)`）。TrendsTab 用现有 `topics:list` + `stocks:list`（指数当日 quote）+ `stocks:history`（日K）做双 Y 轴 ECharts；WorldTab 用 `stocks:list` 渲染市场冷暖 chips。

**Tech Stack:** React render layer, ECharts, vitest。零新依赖。

**Spec:** `docs/superpowers/specs/2026-09-14-lumen-world-trends-design.md`（§趋势 / 世界）。

## Global Constraints
- **零新依赖、零 IPC**；复用 `stocks:history`（period=day，60 点）与 `stocks:list` 缓存。
- 对齐规则：趋势桶按日期前缀匹配 K 线交易日，无交易日 → null（节假日/周末断线属预期）。
- i18n 新增 `trends.market.*`（3 键）+ `world.market.*`（2 键）× 2，`i18n.test` 校验。

---

### Task 1: 叠线辅助函数（TDD）

**Files:**
- Modify: `shared/stocks.ts`（`MARKET_INDEX_SYMBOLS`）
- Create: `src/stocks/overlay.ts`（`buildOverlaySeries`）
- Test: `tests/trends-overlay.test.ts`

- [x] Step 1 失败测试：对齐/缺日 null/空桶/空K线。
- [x] Step 2 实现 `overlay.ts` 与常量。
- [x] Step 3 单测转绿、`tsc` 通过。

### Task 2: 趋势 Tab「大盘与热点联动」

**Files:** Modify `src/components/TrendsTab.tsx`、`src/i18n/dict.ts`、`src/styles.css`

- [x] Step 4 指数 chips（当日涨跌）切换；`stocks:history {symbol,period}` 拉日K；双 Y 轴折线（热度 + 收盘，缺日断线）。
- [x] Step 5 无数据兜底文案；i18n 3 键 ×2。

### Task 3: 世界 Tab「全球市场冷暖」

**Files:** Modify `src/components/WorldTab.tsx`

- [x] Step 6 顶部市场冷暖卡：9 指数当日涨跌幅 chips（红涨绿跌，`stocks:list` 缓存），空缓存提示。

### Task 4: 验证与文档

- [x] Step 7 全量 `npm test` + `tsc` + `npm run build` + `LUMEN_SMOKE=1`。
- [x] Step 8 README 更新 + commit `feat: M20 overlay stock market into trends & world`。
