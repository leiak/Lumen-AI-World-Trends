# M11 图谱因果链 实现计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 深化事件图谱的因果链能力：输入任意实体，把其相关事件按时间串成链路（共享实体作锚点），可选 AI 逐段生成因果断言 + 整体摘要，本地缓存历史。

**Architecture:** 主进程新增 `electron/main/causal/`：`build.ts` 用 SQL（`article_event` + `article_entity` + `entity`）按时间序取根实体相关事件，对相邻事件查共享实体锚点生成 `kind='rule'` 链路；`interpret.ts` 组装 `LINK <i>: … / SUMMARY: …` 提示词调 provider（火山方舟 ARK / Mock），`parseCausalOutput` 回填 `assertion` 并解析摘要；`repository.ts` 把链以 JSON 存入新增 `causal_chain` 表（schema v6）。IPC 三通道 `causality:list/generate/chain` 接入 `register.ts` + `index.ts`；渲染层 InsightsTab 新增「因果链」卡片（实体输入 + AI 开关 + 链路可视化 + 历史列表）。

**Tech Stack:** Electron main (Node/TS), sql.js, React, vitest。

**Spec:** `docs/superpowers/specs/2026-09-14-lumen-world-trends-design.md`（§1 事件图谱 / §4 AI 解读）。

## Global Constraints
- **零新增运行时依赖**：全部用现有 sql.js / provider；AI 失败回退规则链（console.warn）。
- 契约经 `shared/contracts.ts` 收口；`shared/causal.ts` 定义 `CausalChain/CausalNode/CausalLink/CausalGeneratePayload`。
- 渲染层读数走 `window.lumen`（`useInvoke`）；i18n 新增 `insights.causal.*` 键（zh/en 集合一致，`i18n.test` 自动校验）。

---

### Task 1: 数据层 + 规则链构建（离线）

**Files:**
- Create: `shared/causal.ts`
- Create: `electron/main/causal/build.ts`
- Modify: `electron/main/db/migrate.ts`（schema v6：`causal_chain` 表 + 索引）
- Modify: `tests/db.test.ts`、`tests/insights.test.ts`（v5→v6 断言）
- Test: `tests/causal-build.test.ts`

**Interfaces:**
- Produces: `buildCausalChain(db, rootEntity, opts?): CausalChain | null`
- Schema: `causal_chain(id PK, root_entity, generated_at, model, chain_json)`

- [x] Step 1 共享类型 + 迁移 v6。
- [x] Step 2 失败测试：时间排序链 + 共享锚点；单事件/未知实体返回 null。
- [x] Step 3 实现 `buildCausalChain`（修复 `sharedEntityBetween` 缺 `entity` JOIN 的 `e.name` 问题）。
- [x] Step 4 `tsc` + `npm test` 通过（65/65）。

### Task 2: AI 因果断言 + 仓储

**Files:**
- Create: `electron/main/causal/interpret.ts`
- Create: `electron/main/causal/repository.ts`
- Modify: `shared/contracts.ts`（`causality:list/generate/chain`）
- Test: `tests/causal-interpret.test.ts`、`tests/causal-repo.test.ts`

**Interfaces:**
- Produces: `buildCausalPrompt(chain)` / `parseCausalOutput(chain, output)` / `interpretCausalChain(provider, chain, now?)`；`saveCausalChain` / `listCausalChains` / `getCausalChain`

- [x] Step 1 失败测试：prompt 含链接索引；`LINK <i>:` 回填断言（含中文冒号）；`SUMMARY` 摘要；缺失回退整段。
- [x] Step 2 实现 interpret + repository。
- [x] Step 3 全量测试通过。

### Task 3: IPC + 主进程接线

**Files:**
- Modify: `electron/main/ipc/register.ts`
- Modify: `electron/main/index.ts`

**Interfaces:**
- Consumes: `buildCausalChain` / `interpretCausalChain` / 仓储三函数
- Channels: `causality:list`（limit） / `causality:generate`（{name,maxEvents,useAi}） / `causality:chain`（{id}）

- [x] Step 1 IpcDeps 增加三个 handler 并注册。
- [x] Step 2 index.ts 实现：规则链 →（可选 AI）interpretCausalChain，失败保留规则链 → save + persist。
- [x] Step 3 `tsc` 通过。

### Task 4: InsightsTab 因果链 UI

**Files:**
- Modify: `src/components/InsightsTab.tsx`
- Modify: `src/i18n/dict.ts`（`insights.causal.*` 15 键 × 2）
- Modify: `src/hooks/useInvoke.ts`（run 返回结果信封，供新 UI 取最新链）
- Modify: `src/styles.css`（`.chain-list/.chain-node/.chain-edge/.tag-ai/.tag-rule` 等）

**Interfaces:**
- Consumes: `causality:generate` / `causality:list`；`CausalChain` 类型

- [x] Step 1 因果链卡片：实体输入 + 生成按钮 + AI 开关 + 事件序列/锚点/断言/摘要渲染。
- [x] Step 2 历史列表点击回看。
- [x] Step 3 验证：`npm test` 65/65、`tsc`、`npm run build` 成功、冒烟 `LUMEN_SMOKE_OK`。
- [x] Step 4 README/计划更新并提交。

## Self-Review
- **Spec 覆盖**：图谱因果链（§1/§4）。
- **离线优先**：无 AI 时规则链照常产出；AI 失败回退不阻断。
- **类型一致性**：`shared/causal.ts` 主/渲染共用；契约收口 `contracts.ts`。
- **占位符扫描**：无 TBD。