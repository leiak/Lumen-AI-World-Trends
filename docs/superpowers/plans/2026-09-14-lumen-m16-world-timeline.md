# M16 世界地图按日回放时间轴 实现计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 世界 choropleth 地图支持按天回放热度：本地按文章日期把国家热度拆成日级时间线，地图播放/暂停/滑块回看近 14 天世界热度的逐日演变。

**Architecture:** 数据层新增 `electron/main/world/timeline.ts` 纯 db 函数 `countryDayTimeline(db, { days, now })`：以 `article_entity LEFT JOIN entity + JOIN source_article`，按 `COALESCE(NULLIF(published_at,''), crawled_at)` 的日期前缀（`substr(...,1,10)`）分组，逐日返回国家+当日去重文章数（日期升序，空日为空数组）。共享类型 `WorldTimeline { dates; byDate: { date; countries: CountryHeat[] } }` 进 `shared/world.ts`；新 IPC `world:timeline`（payload `{ days? }`）。渲染层 WorldTab 地图卡新增播放器：总量/按日回放切换 + 播放/暂停 + range 滑块 + 日期显示（1.2s 循环推进），地图 data 切换为当日国家热度。

**Tech Stack:** Electron main (Node/TS), sql.js, ECharts, React, vitest。

**Spec:** `docs/superpowers/specs/2026-09-14-lumen-world-trends-design.md`（§世界热力地图）。

## Global Constraints
- **零新增依赖**；`world:timeline` 为只读查询，不改 schema。
- 契约经 `shared/contracts.ts` 收口（新增 1 通道）。
- 国家名→地图名归一化只在渲染层 `src/world/geo.ts` 做，主进程不做（不 import 渲染层模块）。
- i18n 新增 `world.pb.*`（6 键 × 2，集合一致由 `i18n.test` 校验）。

---

### Task 1: 数据层（TDD）

**Files:**
- Modify: `shared/world.ts`（`WorldTimeline` / `WorldTimelineEntry`）
- Create: `electron/main/world/timeline.ts`（`countryDayTimeline`）
- Test: `tests/world-timeline.test.ts`

**Interfaces:**
- Produces: `countryDayTimeline(db, opts?) => WorldTimeline`（`days` 钳制 1-60，默认 7；`now` 可注入便于测试）

- [x] Step 1 失败测试（2 组）：双日期 stat、空日、日期升序、days 钳制/默认窗口。
- [x] Step 2 实现 `timeline.ts`（SQL 按日分组 + JS 日期窗口生成）。
- [x] Step 3 `tsc` 通过、单测转绿（85/85）。

### Task 2: IPC 接线

**Files:**
- Modify: `shared/contracts.ts`（`world:timeline`）
- Modify: `electron/main/ipc/register.ts`（`runWorldTimeline` dep + handler）
- Modify: `electron/main/index.ts`（`countryDayTimeline` handler，days 可选）

- [x] Step 4 契约 + register：`world:timeline` 渠道收口。
- [x] Step 5 `index.ts` handler 注册（只读，不持久化）。

### Task 3: WorldTab 播放器 UI

**Files:**
- Modify: `src/components/WorldTab.tsx`（回放状态 + 播放器 + 地图 data 切换）
- Modify: `src/i18n/dict.ts`（`world.pb.*` 6 键 × 2）
- Modify: `src/styles.css`（`.player` / `.player-bar`）

- [x] Step 6 播放器：总量/回放切换、播放/暂停、滑块、日期显示；`useInvoke('world:timeline', { days: 14 })`。
- [x] Step 7 地图 data 按回放模式切换（总量 → 当日）；EChart deps 更新触发重算。
- [x] Step 8 `i18n.test` 通过（zh/en key 集合一致）。

### Task 4: 验证与文档

- [x] Step 9 全量 `npm test`（85 通过）+ `tsc --noEmit` + `npm run build` + `LUMEN_SMOKE=1` 冒烟。
- [x] Step 10 更新 README（特性/看板/项目结构/IPC 一览/测试覆盖/路线图）。
- [x] Step 11 commit `feat: M16 world map timeline playback`。
