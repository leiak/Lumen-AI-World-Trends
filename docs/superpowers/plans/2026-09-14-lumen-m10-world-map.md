# M10 世界热力地图 实现计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补上「世界 choropleth 热力地图」：用真实世界 GeoJSON 渲染国家热度着色，点击地图区域联动国家详情/对比。

**Architecture:** 用 `world-atlas`(110m TopoJSON) + `topojson-client` 临时生成 `resources/world.geojson` 并提交为常驻资源（`--no-save` 装依赖，不动 package.json）；渲染层 `src/world/geo.ts` 做名称归一化（别名→GeoJSON 名称）并构建 map 数据；`EChart` 组件增加 `onClick` 支持；世界 Tab 顶部加 ECharts `map` 系列，`registerMap` 后点击区域 → 复用现有国家详情/对比联动。`.geojson` 由 Vite 自定义插件作为 JSON 模块加载。

**Tech Stack:** Electron main (Node/TS), React, ECharts, world-atlas(临时), topojson-client(临时)。

**Spec:** `docs/superpowers/specs/2026-09-14-lumen-world-trends-design.md`（§3.2 世界 GeoJSON、§2 世界热力地图）。

## Global Constraints
- **不写入 package.json 依赖**（临时装 `world-atlas`/`topojson-client` 仅用于生成资源；生成物 `resources/world.geojson` 提交入库，运行时零依赖）。
- 新 IPC：无（地图数据复用 `topics:list` 的 countries）。
- 名称归一化：`src/world/geo.ts` 别名表 + GeoJSON feature name 直查；无法映射的实体（欧盟等非国家）丢弃。
- 渲染层读数走 `window.lumen`；样式复用 `styles.css`；i18n 新增 `world.map` key。

---

### Task 1: 资源生成 + 数据层

**Files:**
- Create: `resources/world.geojson`（生成物，提交）
- Create: `scripts/gen-world-geo.mjs`（再生成脚本）
- Create: `src/world/geo.ts`
- Modify: `src/assets.d.ts`（`*.geojson` 模块声明）
- Modify: `vite.config.ts`（`.geojson` → JSON module 插件）
- Test: `tests/world-map.test.ts`

**Interfaces:**
- Produces:
  - `normalizeCountry(name: string): string | null`
  - `countriesToMapData(items: {name;count}[]): { name; value }[]`
  - `worldGeo`（GeoJSON 对象，供 `registerMap`）

- [x] Step 1 安装临时依赖并生成 `resources/world.geojson`（177 features）。
- [x] Step 2 写失败测试：别名映射/US 合并/欧盟丢弃。
- [x] Step 3 实现 geo.ts + assets.d.ts + vite 插件。
- [x] Step 4 `tsc` + `npm test` 通过。

### Task 2: 地图渲染 + 联动

**Files:**
- Modify: `src/components/EChart.tsx`（`onClick`）
- Modify: `src/components/WorldTab.tsx`（registerMap + map 系列 + 点击联动）
- Modify: `src/i18n/dict.ts`（`world.map`）
- Modify: `README.md`（地图特性/结构/局限更新）

**Interfaces:**
- Consumes: `worldGeo` / `normalizeCountry` / `countriesToMapData`；`toggleCountry(name)`（既有）。

- [x] Step 1 EChart 支持 `onClick`。
- [x] Step 2 WorldTab 加入 map 卡片（visualMap 深色着色、roam、点击→国家详情/对比）。
- [x] Step 3 验证：`npm test` 58/58、`tsc`、`npm run build` 成功、冒烟正常。
- [x] Step 4 README/计划更新并提交。

## Self-Review
- **Spec 覆盖**：世界热力地图（§2/§3.2）。
- **资源策略**：离线可构建；生成物常驻 `resources/`，运行时零网络/零依赖。
- **类型一致性**：`worldGeo` 声明于 `geo.ts`，`assets.d.ts` 提供模块类型。
- **占位符扫描**：无 TBD。