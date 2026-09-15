# M15 UI 化采集策略 实现计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把采集策略搬进 UI：总览 Tab 可勾选启用的新闻源、开关自动调度、调间隔（1-720 分钟），保存后即时生效并持久化到本地库（`meta` 表），替代「改代码 / 环境变量」式配置。

**Architecture:** 新增 `shared/settings.ts`（`CollectSettings` / `SourceInfo` / `SettingsView`）与 `electron/main/db/settings.ts`（`loadCollectSettings`（fallback 支持 env 兜底）/ `saveCollectSettings`（合并 + 校验：未知源过滤、间隔钳 1-720）/ `enabledCollectors`（空数组=全部启用））。新 IPC `settings:get` / `settings:update`；主进程 `restartScheduler()`（停旧调度→按新配置重启；`autoEnabled=false` 时不调度），手动采集与自动 job 均改用 `enabledCollectors`；引擎状态 sources 显示启用的源。DashboardTab 新增「采集策略」卡片（源勾选 chips + 自动开关 + 间隔 number + 保存）。

**Tech Stack:** Electron main (Node/TS), sql.js, React, vitest。

**Spec:** `docs/superpowers/specs/2026-09-14-lumen-world-trends-design.md`（§2 桌面看板 / 采集）。

## Global Constraints
- **零新增依赖**；配置存已有 `meta` 表（schema 不变）。
- 契约经 `shared/contracts.ts` 收口（新增 2 通道）。
- 语义约定：`enabledSources` 空数组 = 全部启用（未配置默认）；更新时至少保留一个源（空 = 全启用语义冲突）。
- i18n 新增 `dash.settings.*` + `common.on/off`（10 键 × 2，集合一致由 `i18n.test` 校验）。

---

### Task 1: 设置存储模块（TDD）

**Files:**
- Create: `shared/settings.ts`
- Create: `electron/main/db/settings.ts`
- Test: `tests/settings.test.ts`

**Interfaces:**
- Produces: `loadCollectSettings(db, fallback?)` / `saveCollectSettings(db, patch, knownIds)` / `enabledCollectors(db, all)`

- [x] Step 1 失败测试（4 用例）：默认值 + fallback；round-trip；合并校验（未知源过滤/间隔钳制/坏 JSON 回退）；enabledCollectors 过滤。
- [x] Step 2 实现 settings 模块（meta 表读写）。
- [x] Step 3 `tsc` 通过。

### Task 2: IPC + 调度重构

**Files:**
- Modify: `shared/contracts.ts`（`settings:get` / `settings:update`）
- Modify: `electron/main/ipc/register.ts`
- Modify: `electron/main/index.ts`

**Interfaces:**
- Produces: `runSettingsGet` / `runSettingsUpdate`
- Consumes: `loadCollectSettings` / `saveCollectSettings` / `enabledCollectors`

- [x] Step 1 契约 + 注册。
- [x] Step 2 index.ts：settings 视图组装（全部源信息 + 设置）；update 校验（至少一个源）→ 保存 → persist → `restartScheduler()`。
- [x] Step 3 `restartScheduler`：停旧调度、按 `autoEnabled`/`intervalMinutes` 重启；手动采集与自动 job 用启用源；engine status sources 用启用源；env 间隔作未保存时的兜底。
- [x] Step 4 `npm test` 83/83 通过。

### Task 3: 总览采集策略卡片

**Files:**
- Modify: `src/components/DashboardTab.tsx`
- Modify: `src/i18n/dict.ts`（`dash.settings.*` + `common.on/off`）
- Modify: `src/styles.css`（`.settings-grid/.settings-row/.toggle-btn.on/.source-check`）
- Modify: `README.md`

**Interfaces:**
- Consumes: `settings:get` / `settings:update`

- [x] Step 1 卡片：源勾选（chips + checkbox，空=全启用）、自动开关按钮、间隔 number、保存 + 提示（saved/至少一个源）。
- [x] Step 2 验证：`npm test` 83/83、`tsc`、`npm run build` 成功、冒烟 `LUMEN_SMOKE_OK`。
- [x] Step 3 README/计划更新并提交。

## Self-Review
- **Spec 覆盖**：采集策略 UI 化（§2）。
- **可测性**：设置持久化/校验纯 db 函数，4 个新增用例。
- **类型一致性**：`shared/settings.ts` 主/渲染共用；契约收口；i18n 键集合一致。
- **占位符扫描**：无 TBD。