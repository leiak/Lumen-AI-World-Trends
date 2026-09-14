# M6 看板实现计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 M1–M5 的能力接入渲染层看板：可点操作（手动采集/构建图谱/生成解读/拉趋势）+ 本地全文检索，并用 ECharts 呈现趋势曲线与世界热点，成为可用的桌面情报台。

**Architecture:** 渲染层 React 以 tab 组织（总览 / 趋势 / 世界 / 检索）；新增 `search:fulltext` IPC；纯函数与主进程逻辑已就绪，仅接线渲染层。可视化用 `echarts`（趋势折线 + 国家横向柱状热量），检索用 SQL `LIKE`。

**Tech Stack:** React, zustand 可选, echarts, TypeScript。

**Spec:** `docs/superpowers/specs/2026-09-14-lumen-world-trends-design.md`

## Global Constraints
- 渲染层只经 `window.lumen`（preload）调用 IPC；preload 已暴露 `invoke/channel+payload` 与 `getEngineStatus`。
- 新增 IPC 载荷约定：`search:fulltext { query: string }` → `IpcResponse<SourceArticle[]>`。
- 可视化数据源：`topics:list`（`TrendsResult`）、`graph:build`（`GraphBuildResult`）、`insights:generate`（`Insight`）。
- 无权重 UI（`zustand` 可选，暂用 props + useState 保持轻量）。
- 不引入路由库，用本地 tab state。

---

### Task 1: 全文检索 IPC

**Files:**
- Modify: `electron/main/graph/repository.ts`（`searchArticles(db, query, limit?)`）
- Modify: `electron/main/ipc/register.ts`（挂 `search:fulltext`，带 payload）
- Modify: `electron/main/index.ts`（注入 `runSearch`）
- Create: `tests/search.test.ts`

**Interfaces:**
- Produces: `searchArticles(db, query: string, limit?: number): SourceArticle[]`（`title LIKE %q% OR content LIKE %q%`，按 crawled_at 降序）。
- IPC：`search:fulltext` handler，payload `{ query }`。

- [ ] **Step 1: 写失败测试**（插入 2 篇文章，查询命中标题 vs 内容，断言返回与数量）
- [ ] **Step 2: 运行测试确认失败** → FAIL
- [ ] **Step 3: 实现 `searchArticles`（复用 `loadArticles` 的行映射）+ register + index**
- [ ] **Step 4: 运行测试确认通过** → PASS；`tsc` 无错
- [ ] **Step 5: Commit** `feat: fulltext search ipc`

---

### Task 2: 渲染层壳 + IPC Hook

**Files:**
- Create: `src/hooks/useInvoke.ts`（通用 IPC 调用 hook）
- Create: `src/App.tsx`（tab 壳：总览/趋势/世界/检索）
- Create: `src/env.d.ts`（补 `invoke` 载荷类型）

**Interfaces:**
- `useInvoke<T>(channel, payload?, deps) → { data, error, loading, run }`
- `App.tsx` 维护 `activeTab`，渲染各 tab 组件。

- [ ] **Step 1: 实现 useInvoke 与 tab 壳**（no test；`tsc` 校验）
- [ ] **Step 2: `npx tsc` 无错**
- [ ] **Step 3: Commit** `feat: renderer shell with tabs`

---

### Task 3: 总览 tab（状态 + 操作按钮 + 解读卡片）

**Files:**
- Create: `src/components/DashboardTab.tsx`

**内容：** 引擎状态、按钮「手动采集 / 构建图谱 / 生成解读」（分别调 `collector:manualRun`、`graph:build`、`insights:generate`），展示返回结果；解读卡片显示 `insight.content`。

- [ ] **Step 1: 实现 DashboardTab**（tsc）
- [ ] **Step 2: `npx tsc` 无错**
- [ ] **Step 3: Commit** `feat: dashboard tab with actions`

---

### Task 4: 趋势 + 世界 hot tab（echarts）

**Files:**
- Create: `src/components/TrendsTab.tsx`（echarts line，top 5 话题的桶数据）
- Create: `src/components/WorldTab.tsx`（国家横向柱状，化热力排名）
- Create: `src/lib/chart.ts`（echarts init/resize helper）

**内容：** `topics:list` 数据；趋势用折线（x=桶时间，series=top 话题），世界用`countries` 前若干做横向 bar（近似热力，附色阶）。

- [ ] **Step 1: 实现 chart helper + 两 tab**（tsc）
- [ ] **Step 2: `npx tsc` 无错；`npm run build` 成功**
- [ ] **Step 3: Commit** `feat: trends + world charts`

---

### Task 5: 检索 tab + 收尾冒烟

**Files:**
- Create: `src/components/SearchTab.tsx`（输入框 → `search:fulltext` → 结果列表）

**收尾：**
- `npm test`、`npx tsc`、`npm run build`、`LUMEN_SMOKE`（渲染层 DOM 校验含导航 tab 文案）
- 更新 M6 计划交付记录与裁定

- [ ] **Step 1: 实现 SearchTab**
- [ ] **Step 2: 全量验证**（test/tsc/build/smoke）
- [ ] **Step 3: Commit** `feat: search tab + dashboard`

---

## Self-Review
- **Spec 覆盖**：看板/时间线/检索/离线回看（spec §8 M6）、ECharts 可视化（spec §3.2 图表）、按钮接线各 IPC。
- **占位符扫描**：无 TBD。
- **类型一致性**：`SourceArticle`、`TrendsResult`、`GraphBuildResult`、`Insight` 均已在 shared 单一定义，渲染层复用。
- **世界热力图**：v1 以国家横向柱状近似（对 `countries` 排序着色），完整 choropleth 世界地图留待后续（需地理 GeoJSON 资源）。
