# M8 总览数据 / AI 解读中心 / 事件图谱升级 实现计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐「总览数据看板 + AI 解读中心（历史/周报）+ 事件节点入图」，并修复「本地缓存实际未落盘」的核心缺陷。

**Architecture:** 新增第 5 版迁移 `insight` 表与 `dashboard:today` / `insights:list` / `insights:weekly` 三个 IPC；总览数据由主进程汇总（表计数 + 今日增量 + 调度元信息）；AI 解读写库并持久化；图谱查询支持 `includeEvents` 把事件节点与事件→实体边加入力导向图。

**Tech Stack:** Electron main (Node/TS), React, ECharts, sql.js（零新依赖）。

**Spec:** `docs/superpowers/specs/2026-09-14-lumen-world-trends-design.md`（§2 周报、§4 Insight 表、§5 dashboard:today / insights:generate）。

## Global Constraints
- **零新增 npm 依赖**（沿用 M7 约束，审批/网络不稳）。
- 新 IPC 载荷（renderer 视角）：
  - `dashboard:today` payload 空 → `IpcResponse<DashboardSnapshot>`
  - `insights:generate` payload `{ type?: 'causal' | 'weekly'; topic?: string }` → `IpcResponse<Insight>`（结果写库）
  - `insights:list` payload `{ limit?: number }` → `IpcResponse<Insight[]>`
  - `insights:weekly` payload 空 → `IpcResponse<Insight>`（等价 generate type='weekly'，结果写库）
  - `graph:query` payload `{ topN?: number; includeEvents?: boolean; eventLimit?: number }`
- 类型单一来源：`shared/dashboard.ts`、`shared/insight.ts`、`shared/graph-view.ts`（`GraphNode` 增加 `kind`/`occurredAt`）。
- 持久化：主进程在每次采集/建图/解读后与退出前调用 `saveDatabase`；`schema_version` 升到 5。
- 渲染层读数走 `window.lumen`，样式复用 `styles.css` class；电脑可离线（无 Key 走 Mock）。

---

## 交付状态 (2026-09-14)

- [x] Task 0 落盘：`index.ts` 在采集/建图/解读后与 `before-quit` 调用 `saveDatabase`；冒烟验证 `%APPDATA%\lumen-world-trends\lumen.db` 生成（106KB）。
- [x] Task 1 `dashboard:today`：`shared/dashboard.ts` + `dash/summary.ts` + 总览 Tab（指标卡/今日热点/调度状态）。
- [x] Task 2 解读中心：migrate v5 `insight` 表 + `db/insights.ts` + `interpretWeekly` + `insights:list`/`insights:weekly` + 解读 Tab（历史/生成/周报）。
- [x] Task 3 图谱事件节点：`GraphQueryOptions` + `queryGraph` 支持 `includeEvents`（事件→实体边）+ 图谱 Tab 开关（菱形事件节点）。
- [x] 全量验证：`npm test` 46/46、`tsc --noEmit` 无错、`npm run build` 成功、冒烟 7 Tab 正常。
- [x] README 更新（7 Tab / 新 IPC / 落盘说明）。
- 说明：`index.ts` 中三个特性改动相互交织，未按计划拆 4 个 commit，改为单次 M8 综合提交（与 M7 惯例一致）。

### Task 0: 修复本地缓存未落盘（核心缺陷）

**Files:**
- Modify: `electron/main/index.ts`（采集/建图/解读后与 `before-quit` 持久化）
- Test: `tests/db.test.ts`（saveDatabase 往返：写临时文件→重开→读行）

**Interfaces:**
- Consumes: `connection.saveDatabase(db, dbPath)`（已存在）
- Produces: 无新导出；`runManualCrawl` / `runGraphBuild` / `runInsight*` / 自动调度 job / `before-quit` 均触发落盘。

- [ ] Step 1 写失败测试：内存库写 1 篇文章 → `saveDatabase` 到临时文件 → 用 `openDatabase` 重开 → 能查到文章。
- [ ] Step 2 实现/接线：`index.ts` 内 `persist()`，各变更点 + quit 调用。
- [ ] Step 3 单测通过 + `tsc` 无错。
- [ ] Step 4 Commit `fix: persist sql.js database to disk (local cache)`

---

### Task 1: 总览数据 `dashboard:today` + 看板升级

**Files:**
- Create: `shared/dashboard.ts`（`DashboardMetrics`/`TopTopic`/`DashboardSnapshot`）
- Create: `electron/main/dash/summary.ts`（`loadDashboardSnapshot(db, meta)`）
- Modify: `shared/contracts.ts`（`dashboard:today` 已在，无需改；确认 handler 接入）
- Modify: `electron/main/ipc/register.ts`（`runDashboard`）
- Modify: `electron/main/index.ts`（注入 + 调度元信息）
- Modify: `src/components/DashboardTab.tsx`（指标卡片 + 今日热点 + 调度状态）
- Modify: `src/styles.css`（`.stat-grid/.stat/.stat-num/.stat-label`）
- Test: `tests/dashboard.test.ts`

**Interfaces:**
- Produces:
  - `shared/dashboard.ts`:
    - `interface DashboardMetrics { articles: number; entities: number; events: number; edges: number; addedToday: number }`
    - `interface TopTopic { name: string; count: number; rising: boolean }`
    - `interface DashboardSnapshot { metrics: DashboardMetrics; topTopics: TopTopic[]; generatedAt: string; lastAutoRunAt: string | null; autoIntervalMinutes: number; lastCrawlAt: string | null }`
  - `summary.loadDashboardSnapshot(db, opts: { now?: string; intervalMinutes: number; lastAutoRunAt?: string | null; topN?: number })`
- Consumes: `contracts.ALL_CHANNELS` 已有 `dashboard:today`。

- [ ] Step 1 写失败测试：种子文章/实体/事件/边 + 今日 2 篇/昨日 1 篇 → 计数与 `addedToday=2` 正确、TopTopic 前 3 排序。
- [ ] Step 2 实现 `shared/dashboard.ts` + `dash/summary.ts`。
- [ ] Step 3 接 IPC 与 `index.ts`（含调度最近运行时间捕获）。
- [ ] Step 4 改造 `DashboardTab`（卡片/热点/状态，保留采集/建图/解读按钮）。
- [ ] Step 5 `npm test` + `tsc` 通过。
- [ ] Step 6 Commit `feat: dashboard:today overview with metrics and top topics`

---

### Task 2: AI 解读中心（历史 + 周报）

**Files:**
- Modify: `electron/main/db/migrate.ts`（MIGRATION_5：`insight` 表；`schema_version=5`）
- Create: `electron/main/db/insights.ts`（`saveInsight`/`listInsights`）
- Modify: `electron/main/ai/interpreter.ts`（`buildWeeklyPrompt`/`interpretWeekly`）
- Modify: `shared/contracts.ts`（新增 `insights:list`、`insights:weekly`）
- Modify: `electron/main/ipc/register.ts`、`electron/main/index.ts`
- Create: `src/components/InsightsTab.tsx`（解读中心 Tab）
- Modify: `src/App.tsx`（Tab 扩为 7：加「解读」）、`src/styles.css`（`.insight-item` 等）
- Test: `tests/insights.test.ts`；扩展 `tests/interpreter.test.ts`、`tests/contracts.test.ts`

**Interfaces:**
- Produces:
  - `db/insights.ts`:
    - `saveInsight(db, insight: Insight): void`
    - `listInsights(db, limit?: number): Insight[]`（按 `generated_at DESC`）
  - `ai/interpreter.ts`:
    - `buildWeeklyPrompt(trends: TrendsResult): ChatMessage[]`
    - `interpretWeekly(provider: AiProvider, trends: TrendsResult): Promise<Insight>`（type=`weekly`，标题 `周报·<日期>`）
- Consumes: `parseInsight`（type 扩展已含 `weekly`）。

- [ ] Step 1 写失败测试（insights.test.ts：保存/倒序列表；interpreter：weekly prompt 与 interpretWeekly）。
- [ ] Step 2 实现 migrate v5 + insights 仓储。
- [ ] Step 3 实现 weekly 解读。
- [ ] Step 4 接 IPC 与 `index.ts`（generate/weekly 均写库并落盘；list 直接查库）。
- [ ] Step 5 实现 `InsightsTab` + App Tab + 样式。
- [ ] Step 6 `npm test` + `tsc` 通过。
- [ ] Step 7 Commit `feat: AI insights center (history + weekly report)`

---

### Task 3: 事件节点入图谱

**Files:**
- Modify: `shared/graph-view.ts`（`GraphNode.kind/occurredAt`、`GraphQueryOptions`）
- Modify: `electron/main/graph/repository.ts`（`queryGraph(db, opts)`，事件→实体边）
- Modify: `electron/main/ipc/register.ts`（透传 includeEvents/eventLimit）
- Modify: `src/components/GraphTab.tsx`（“显示事件”开关、事件节点配色、tooltip 显示时间）
- Modify: `tests/graph-query.test.ts`
- Modify: `src/styles.css`（切换开关样式，可选）

**Interfaces:**
- Produces:
  - `GraphQueryOptions { topN?: number; includeEvents?: boolean; eventLimit?: number }`
  - `repository.queryGraph(db, opts?: GraphQueryOptions): GraphView`（向后兼容：内部默认 `{topN:20, includeEvents:false, eventLimit:10}`）
  - 事件节点 `id = 'evt:' + event.id`，`kind='event'`，`occurredAt` 来自 `event.occurred_at`；事件→实体边权 = 共享文章数。
- Consumes: `graph_edge`（实体边）、`article_event` + `article_entity`（事件实体边）、`event` 表。

- [ ] Step 1 写失败测试：种子事件 + article_event + article_entity → `includeEvents:true` 返回事件节点与事件→实体链接；`includeEvents:false` 不含。
- [ ] Step 2 实现类型 + `queryGraph` 扩展。
- [ ] Step 3 接 IPC + GraphTab UI。
- [ ] Step 4 `npm test` + `tsc` 通过。
- [ ] Step 5 Commit `feat: event nodes in graph view`

---

## Self-Review
- **缺陷优先**：Task 0 修复「本地缓存未落盘」，否则其余功能重启即丢。
- **Spec 覆盖**：补上 §5 `dashboard:today`、§2 周报、M5「历史可回看」。
- **占位符扫描**：无 TBD；SQL/接口/载荷均明确。
- **类型一致性**：新增类型全部单一定义于 shared；IPC 载荷与渲染一致。
- **无新依赖**：只用 sql.js/axios/ECharts/React 既有能力。