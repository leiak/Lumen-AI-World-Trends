# M13 跨实体因果链合并（全局叙事） 实现计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把单实体的因果链按共享事件做**传递合并**，织成更大的「全局叙事」（如 制裁 China → 油价 Oil → 通胀 US），离线规则链即可产出；解读中心新增叙事视图，快照导出同步包含叙事。

**Architecture:** 新增 `electron/main/causal/merge.ts`：`buildGlobalNarratives(db)` 按实体文章热度取 Top N 实体 → 复用 `buildCausalChain` 生成规则链 → `mergeCausalChains` 用并查集按共享事件分组、合并节点（按时间排序）/去重链路，主根取节点最多者（并列按名称字典序）；`CausalChain` 增加可选 `entities?: string[]` 记录参与实体。新 IPC `causality:narratives`（不落库，随查随算）。渲染层解读 Tab 右栏顶部加「全局叙事」卡片（刷新 + 列表 + 内嵌 ChainView），ChainView 改为按 `fromEventId` 渲染链路（支持支链/跨链）。快照导出 `ExportSnapshotInput` 增加可选 `narratives` 并输出「全局叙事」段。

**Tech Stack:** Electron main (Node/TS), sql.js, React, vitest。

**Spec:** `docs/superpowers/specs/2026-09-14-lumen-world-trends-design.md`（§1 事件图谱 / §4 AI 解读）。

## Global Constraints
- **零新增运行时依赖**；不新增表（叙事随查随算，不落库）。
- 契约经 `shared/contracts.ts` 收口（新增 `causality:narratives`）。
- 合并算法纯函数化（`mergeCausalChains`），保证 vitest 可测。
- i18n 新增 `insights.nar.*`（5 键 × 2，集合一致由 `i18n.test` 校验）。

---

### Task 1: 合并算法（纯函数 + 测试）

**Files:**
- Modify: `shared/causal.ts`（`entities?: string[]`）
- Create: `electron/main/causal/merge.ts`
- Test: `tests/causal-merge.test.ts`

**Interfaces:**
- Produces: `mergeCausalChains(chains): CausalChain[]` / `buildGlobalNarratives(db, opts?)`

- [x] Step 1 失败测试：共享事件合并/时序排节点；无共享保持分离；链路去重 + 主根取节点最多者；DB 种子两条叙事（China-Oil 3 事件 / US-Fed 2 事件）。
- [x] Step 2 实现 merge.ts（并查集 + 分组合并）。
- [x] Step 3 `tsc` + 全量 `npm test` 通过（72/72）。

### Task 2: IPC + 快照导出增强

**Files:**
- Modify: `shared/contracts.ts`（`causality:narratives`）
- Modify: `electron/main/ipc/register.ts`
- Modify: `electron/main/index.ts`（handler + export 聚合加 narratives）
- Modify: `electron/main/export/snapshot.ts`（`narratives?` + 全局叙事段）
- Modify: `tests/export.test.ts`（叙事段断言）

**Interfaces:**
- Produces: `runCausalityNarratives(payload?: {maxEntities; maxEvents})`

- [x] Step 1 契约 + 注册 + handler（Top 实体规则链 → 合并）。
- [x] Step 2 快照 Markdown 输出「全局叙事」段（含参与实体数、锚点/断言），Stats 增加叙事计数。
- [x] Step 3 `npm test` 72/72、`tsc` 通过。

### Task 3: 解读 Tab 叙事视图

**Files:**
- Modify: `src/components/InsightsTab.tsx`（ChainView 按 fromEventId 渲染 + 叙事卡片）
- Modify: `src/i18n/dict.ts`（`insights.nar.*`）
- Modify: `src/styles.css`（`.tag-narrative` / `.insight-item.selected`）

**Interfaces:**
- Consumes: `causality:narratives`；`CausalChain.entities`

- [x] Step 1 ChainView 改为按 `fromEventId` 分组渲染链路（无锚点时不显示 chip；支持支链）。
- [x] Step 2 右栏顶部「全局叙事」卡片：刷新 + 列表（`N 事件 · M 链路` + 参与实体 +N）+ 内嵌 ChainView。
- [x] Step 3 验证：`npm test` 72/72、`tsc`、`npm run build` 成功、冒烟 `LUMEN_SMOKE_OK`。
- [x] Step 4 README/计划更新并提交。

## Self-Review
- **Spec 覆盖**：图谱因果链深化（§1/§4）。
- **可测性**：合并算法纯函数（并查集），4 个新增用例；快照叙事段 3 处断言。
- **类型一致性**：`entities?` 向后兼容；契约收口 `contracts.ts`；i18n 键集合一致。
- **占位符扫描**：无 TBD。