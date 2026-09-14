# M7 第二阶段 MVP 实现计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「草图版」MVP 打磨成有自主性与完整观感的第二阶段：应用自动运行采集→图谱→趋势，补齐时间线回放与图谱可视化，并全面升级界面主题。

**Architecture:** 主进程用 `setInterval` 实现自调度（无新依赖，冷启动即跑一轮）；新增 `timeline:replay` / `graph:query` 两个 IPC；渲染层新增「时间线」「图谱」Tab，并引入统一 `src/styles.css` 深色主题卡片布局替换内联样式。

**Tech Stack:** Electron main (Node/TS), React, ECharts, sql.js。

**Spec:** `docs/superpowers/specs/2026-09-14-lumen-world-trends-design.md`

## 交付状态 (2026-09-14)

- [x] 代码全部写入（Task 1~4）：新增 `shared/timeline.ts`、`shared/graph-view.ts`、`electron/main/scheduler.ts`、`src/components/TimelineTab.tsx`、`src/components/GraphTab.tsx`、`src/styles.css`；重写 `repository/register/index/App/DashboardTab` 并将 `TrendsTab/WorldTab/SearchTab/EChart` 迁移到深色主题 class。
- [x] `npx tsc -p tsconfig.json --noEmit` 通过（src / shared / electron / tests 全部类型检查）。
- [ ] `npm test`：vitest 需要派生子进程（esbuild spawn），沙箱 `EPERM` 拦截；提权请求当前被审批审阅电路以「token 超限」自动拒绝（非真实风险）。**待审批恢复后运行。**
- [ ] `npm run build`、`LUMEN_SMOKE=1 electron .`：同上，需提权运行。**待审批恢复后执行。**
- [ ] 报规 commit（含 README、M6 plan、M7 plan/source/tests/components）。

> 阻塞点：审批通道自动审阅持续报 `Total tokens of image and text exceed max message tokens`（审阅电路 token 溢出，非代码/安全风险），导致提权命令被批量拒绝。未绕过权限；等审阅恢复或用户手动批准后完成验证与提交。

## Global Constraints
- **不新增 npm 依赖**（当前审批通道不稳定，避免联网安装）；自调度用 `setInterval`。
- 新 IPC 载荷（renderer 视角）：
  - `timeline:replay` payload 空 → `IpcResponse<TimelineEvent[]>`
  - `graph:query` payload `{ topN?: number }` → `IpcResponse<GraphView>`
- 类型单一来源：`shared/timeline.ts` 与 `shared/graph-view.ts`。
- 自调度间隔可配：`LUMEN_INTERVAL_MINUTES`（默认 30），且冷启动立即跑一轮。
- 渲染层读数走 `window.lumen`；历史内联样式逐步迁移到 `styles.css`（保留 class 命名）。
- 主进程纯逻辑可测（vitest 内存库），UI 仅 `tsc` 校验。

---

### Task 1: 时间线仓库 + IPC

**Files:**
- Create: `shared/timeline.ts`
- Modify: `electron/main/graph/repository.ts`（`listEvents`）
- Modify: `electron/main/ipc/register.ts`（`runTimeline`）
- Modify: `electron/main/index.ts`（注入）
- Create: `tests/timeline.test.ts`

**Interfaces:**
- Produces:
  - `shared/timeline.ts`:
    - `export interface TimelineArticle { id: string; title: string; url: string; source: string }`
    - `export interface TimelineEvent { id: string; title: string; occurredAt: string; articleCount: number; articles: TimelineArticle[] }`
  - `repository.listEvents(db, limit?): TimelineEvent[]`（事件按 `occurred_at` 倒序，取近 `limit` 条，每条含其文章）
  - IPC `timeline:replay` → `IpcResponse<TimelineEvent[]>`

- [ ] **Step 1 写测试**：内存库种子 2 个 event + 各自 article_event/source_article/entity → `listEvents` 返回倒序、含文章。
- [ ] **Step 2 实现 `listEvents`**（先 `SELECT ... FROM event ORDER BY occurred_at DESC LIMIT ?`，再逐事件 `article_event JOIN source_article` 取文章）。
- [ ] **Step 3 接 IPC**：`register` + `index` `runTimeline`。
- [ ] **Step 4 运行测试通过**；`tsc` 无错。
- [ ] **Step 5 Commit** `feat: timeline replay ipc`

---

### Task 2: 图谱查询 + IPC

**Files:**
- Create: `shared/graph-view.ts`
- Modify: `electron/main/graph/repository.ts`（`queryGraph`）
- Modify: `electron/main/ipc/register.ts`（`runGraphQuery`）
- Modify: `electron/main/index.ts`（注入）
- Create: `tests/graph-query.test.ts`

**Interfaces:**
- Produces:
  - `shared/graph-view.ts`:
    - `export interface GraphNode { id: string; name: string; type: string; count: number }`
    - `export interface GraphLink { source: string; target: string; weight: number }`
    - `export interface GraphView { nodes: GraphNode[]; links: GraphLink[] }`
  - `repository.queryGraph(db, topN?): GraphView`（节点=实体按出现频次 topN；边=这些实体间 `graph_edge`，含 `weight`）
  - IPC `graph:query` payload `{ topN }` → `IpcResponse<GraphView>`

- [ ] **Step 1 写测试**：种子实体/边 → `queryGraph` 返回 topN 节点与链接、边的 source/target 都在节点内。
- [ ] **Step 2 实现 `queryGraph`**（节点频次 `article_entity` count；链接 `graph_edge` 过滤 join 节点 id）。
- [ ] **Step 3 接 IPC**：`register` + `index` `runGraphQuery`。
- [ ] **Step 4 运行测试通过**；`tsc` 无错。
- [ ] **Step 5 Commit** `feat: graph query ipc`

---

### Task 3: 自调度（自主运行）

**Files:**
- Create: `electron/main/scheduler.ts`
- Modify: `electron/main/index.ts`（冷启动启动 `startScheduler`）
- Create: `tests/scheduler.test.ts`

**Interfaces:**
- Produces:
  - `startScheduler(deps: { job: () => Promise<void>; intervalMs: number; onError?: (e: unknown) => void }): () => void`
  - 立即执行一次 `job()`，随后 `setInterval(intervalMs)`；返回 `stop()`；用 `running` 标志避免重入。
  - `resolveIntervalMs(env): number`（读 `LUMEN_INTERVAL_MINUTES`，默认 30 分钟，下限 1 分钟）

- [ ] **Step 1 写测试**：`resolveIntervalMs` 默认 30 * 60000、非法值回落默认；`startScheduler` 立即跑并 `stop()` 停表（用可注入 timer 或短间隔 + `vi.useFakeTimers`）。
- [ ] **Step 2 实现 `scheduler.ts`**。
- [ ] **Step 3 接 `index.ts`**：job = `[crawl, buildGraph, computeTrends]`，启动即跑。
- [ ] **Step 4 运行测试通过**；`tsc` 无错。
- [ ] **Step 5 Commit** `feat: auto scheduler (crawl+graph)` 

---

### Task 4: 渲染层新 Tab（时间线 / 图谱）+ 主题升级

**Files:**
- Create: `src/styles.css`
- Modify: `src/App.tsx`（tab 扩为 6：总览/时间线/图谱/趋势/世界/检索；用 CSS class）
- Create: `src/components/TimelineTab.tsx`
- Create: `src/components/GraphTab.tsx`
- Modify: `src/components/DashboardTab.tsx`、`TrendsTab.tsx`、`WorldTab.tsx`、`SearchTab.tsx`、`EChart.tsx`（改为 class 复用深色主题；移除主内联样式）
- Modify: `src/main.tsx`（`import './styles.css'`）

**内容：**
- `TimelineTab`：调 `timeline:replay`，竖向时间线渲染事件与文章链接。
- `GraphTab`：调 `graph:query {topN:30}`，用 ECharts `graph` 系列渲染 nodes/links。
- `styles.css`：深色背景、卡片、标签页、按钮、输入框、时间线样式；统一样式替代内联。

- [ ] **Step 1 写 styles.css 与 main.tsx 引入**
- [ ] **Step 2 实现 TimelineTab / GraphTab**
- [ ] **Step 3 重构 App 与各组件用 class**
- [ ] **Step 4 `npx tsc` 无错；`npm run build` 成功**
- [ ] **Step 5 Commit** `feat: timeline + graph tabs with dark theme`

---

## Self-Review
- **Spec 覆盖**：补偿此前跳过的 `timeline:replay`/`graph:query`（spec §5），实现自调度、图谱视图，并升级视觉。
- **占位符扫描**：无 TBD；SQL/接口/载荷均明确。
- **类型一致性**：`TimelineEvent/GraphView` 单一定义于 shared；IPC 载荷与渲染层一致。
- **无新依赖**：规避当前审批/网络不稳定；后续可把自调度换成 node-cron 增强。
