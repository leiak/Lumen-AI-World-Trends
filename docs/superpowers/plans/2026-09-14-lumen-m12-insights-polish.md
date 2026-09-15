# M12 解读中心体验打磨 实现计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打磨 AI 解读中心的界面体验：AI 解读与因果链**双栏布局**；空数据时**三步新手引导**（可直接采集/建图）；支持一键**导出快照**（Markdown/JSON，含趋势 + 解读 + 因果链）。

**Architecture:** 渲染层 `InsightsTab` 改为 `.insights-grid` 双栏（窄屏自动堆叠），顶部按需显示引导卡（数据为空且非加载中），引导卡复用 `collector:manualRun` / `graph:build` 两个既有 IPC；导出走新 IPC `export:snapshot`——主进程从 DB 聚合快照（`listInsights` + `listCausalChains` + `computeTrends`），纯函数 `buildMarkdownSnapshot` / `buildJsonSnapshot` 生成内容，再由 `dialog.showSaveDialog` 选路径写盘（支持 payload 带 `path` 直写，供自动化）。快照构建器独立于 Electron，可纯函数测试。

**Tech Stack:** Electron main (Node/TS), React, vitest。

**Spec:** `docs/superpowers/specs/2026-09-14-lumen-world-trends-design.md`（§1/§4 解读中心）。

## Global Constraints
- **零新增运行时依赖**：对话框/写盘用 Electron `dialog` + `node:fs/promises`。
- 契约经 `shared/contracts.ts` 收口（新增 `export:snapshot` + `ExportResult`）。
- 快照构建器纯函数化（不 import electron），保证 vitest 可测。
- i18n 新增 `insights.guide.*` / `insights.export*`（12 键 × 2，集合一致由 `i18n.test` 校验）。

---

### Task 1: 快照导出（纯函数 + 测试）

**Files:**
- Create: `electron/main/export/snapshot.ts`
- Test: `tests/export.test.ts`

**Interfaces:**
- Produces: `ExportSnapshotInput` / `buildMarkdownSnapshot(input)` / `buildJsonSnapshot(input)`

- [x] Step 1 失败测试：Markdown 含趋势/AI 解读/因果链段落、锚点断言与摘要；空数据 none 占位；JSON 可反序列化。
- [x] Step 2 实现 snapshot.ts（纯函数，中文标题 + 英文副标题双语格式）。
- [x] Step 3 `tsc` + `npm test` 通过。

### Task 2: IPC + 主进程导出

**Files:**
- Modify: `shared/contracts.ts`（`export:snapshot` + `ExportResult`）
- Modify: `electron/main/ipc/register.ts`
- Modify: `electron/main/index.ts`（`dialog` + `writeFile` + handler）

**Interfaces:**
- Produces: `runExportSnapshot(payload: {format?: 'md'|'json'; path?: string})`
- Consumes: `listInsights` / `listCausalChains` / `computeTrends` / `buildMarkdownSnapshot` / `buildJsonSnapshot`

- [x] Step 1 契约 + IpcDeps + handler 注册。
- [x] Step 2 index.ts handler：聚合 → 生成内容 → 无 path 时 `dialog.showSaveDialog`（默认文件名带时间戳）→ 写盘；取消返回 `{saved:false}`。
- [x] Step 3 `tsc` 通过（含 `Electron.SaveDialogOptions`）。

### Task 3: InsightsTab 布局 + 引导 + 导出按钮

**Files:**
- Modify: `src/components/InsightsTab.tsx`
- Modify: `src/i18n/dict.ts`（12 键 × 2）
- Modify: `src/styles.css`（`.insights-grid/.insights-col/.card-head/.guide-steps` + 980px 断点）

**Interfaces:**
- Consumes: `export:snapshot` / `collector:manualRun` / `graph:build`

- [x] Step 1 双栏网格：左列 AI 解读三卡，右列因果链两卡。
- [x] Step 2 引导卡：数据为空时展示三步 + 「去采集/去建图」即时反馈。
- [x] Step 3 导出按钮（左栏头部）+ 结果提示（成功路径/已取消/失败）。
- [x] Step 4 验证：`npm test` 68/68、`tsc`、`npm run build` 成功、冒烟 `LUMEN_SMOKE_OK`。
- [x] Step 5 README/计划更新并提交。

## Self-Review
- **Spec 覆盖**：解读中心体验打磨（§1/§4）。
- **可测性**：导出构建器纯函数，3 个新增用例（含空数据/JSON 往返）。
- **类型一致性**：`ExportResult` 收口契约；i18n 键集合一致。
- **占位符扫描**：无 TBD。