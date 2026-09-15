# M14 叙事 AI 摘要 + 反事实推演 实现计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 M13 的全局叙事补上 AI 深化能力：一键生成**叙事整体摘要**，以及**反事实推演**（“如果首个事件没有发生会怎样”，支持自定义假设）。离线无 ARK key 时走 Mock 兜底，不阻塞。

**Architecture:** 扩展 `electron/main/causal/interpret.ts`：`buildNarrativeSummaryPrompt`（参与实体 + 事件序列 + 因果链路上下文，`SUMMARY:` 行格式）、`summarizeNarrative` 返回带 summary 的链；`buildCounterfactualPrompt`（默认假设锚定首个事件，`COUNTERFACTUAL:` 行格式）、`reasonCounterfactual` 返回 `{text, model, generatedAt}`；解析函数对缺失行回退整段。新增 IPC `causality:summarize` / `causality:counterfactual`（payload 带整条叙事链）。解读 Tab 叙事卡片加两个操作按钮 + 输出区块。

**Tech Stack:** Electron main (Node/TS), React, vitest。

**Spec:** `docs/superpowers/specs/2026-09-14-lumen-world-trends-design.md`（§4 AI 解读）。

## Global Constraints
- **零新增依赖**；provider 复用 ARK/Mock（`createProvider(process.env)`）。
- 契约经 `shared/contracts.ts` 收口（新增 2 通道）。
- prompt/解析纯函数化，vitest 可测（fake provider）。
- i18n 新增 `insights.nar.summarize/summarizing/counterfactual/cfDo/cfPlaceholder`（5 键 × 2）。

---

### Task 1: 叙事摘要 + 反事实纯函数（TDD）

**Files:**
- Modify: `electron/main/causal/interpret.ts`
- Test: `tests/causal-narrative.test.ts`

**Interfaces:**
- Produces: `buildNarrativeSummaryPrompt / parseNarrativeSummary / summarizeNarrative`；`buildCounterfactualPrompt / parseCounterfactual / reasonCounterfactual`

- [x] Step 1 失败测试（7 用例）：摘要 prompt 含实体/事件/断言；SUMMARY 行提取 + 中文冒号 + 回退；summarize 产出带摘要链；默认/自定义假设；COUNTERFACTUAL 行提取 + 回退；reason 输出文本。
- [x] Step 2 实现 interpret.ts 扩展。
- [x] Step 3 `tsc` 通过。

### Task 2: IPC 接线

**Files:**
- Modify: `shared/contracts.ts`（`causality:summarize` / `causality:counterfactual`）
- Modify: `electron/main/ipc/register.ts`
- Modify: `electron/main/index.ts`（handler：校验 chain → AI → 返回；失败返回 error）

**Interfaces:**
- Produces: `runCausalitySummarize({chain})` / `runCausalityCounterfactual({chain, hypothesis?})`

- [x] Step 1 契约 + IpcDeps + handler 注册。
- [x] Step 2 index.ts handler + `npm test` 79/79 通过。

### Task 3: 叙事卡片操作区

**Files:**
- Modify: `src/components/InsightsTab.tsx`（摘要/推演按钮 + 输出区块 + 切换叙事清空）
- Modify: `src/i18n/dict.ts`（5 键 × 2）
- Modify: `README.md`

**Interfaces:**
- Consumes: `causality:summarize` / `causality:counterfactual`

- [x] Step 1 叙事卡片内「AI 摘要」按钮与摘要 mono 区块。
- [x] Step 2 假设输入框 + 「推演」按钮与结果区块；切换叙事时清空旧结果。
- [x] Step 3 验证：`npm test` 79/79、`tsc`、`npm run build` 成功、冒烟 `LUMEN_SMOKE_OK`。
- [x] Step 4 README/计划更新并提交。

## Self-Review
- **Spec 覆盖**：AI 解读深化（§4）。
- **可测性**：6 个纯函数 + 7 个新增用例（含回退与中文冒号）。
- **类型一致性**：契约收口；i18n 键集合一致。
- **占位符扫描**：无 TBD。