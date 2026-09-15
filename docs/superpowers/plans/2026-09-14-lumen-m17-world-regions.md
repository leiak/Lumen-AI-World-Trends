# M17 世界大洲聚合视图 实现计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 世界 Tab 增加「国家 / 大洲」双维度：同一份国家热度（总量与按日回放）可一键聚合成洲级视角 —— 地图按所在大洲的总热度着色、榜单改显洲级热度，回放同样支持洲级逐日演变。

**Architecture:** 纯渲染层实现，不动主进程/schema。新增 `src/world/regions.ts`：按 GeoJSON 110m 精确名称建立「国家 → 大洲」静态映射（8 桶：asia / europe / north-america / latin-america / middle-east / africa / oceania / other），提供 `regionOfCountry(canonical)`（未收录 → other）与 `aggregateRegions(items)`（先 `normalizeCountry` 归一并丢非地图实体，再按洲求和、降序、去零）。WorldTab 新增 `dim: 'country' | 'region'` 状态：地图卡顶部维度切换 chips；region 模式下地图 data 的每国 value 替换为所在洲总热度，国家 Top 卡换成洲级 chips（i18n 显示名）。国家详情/对比交互保持国家级不变。

**Tech Stack:** React render layer, ECharts, vitest。零新依赖。

**Spec:** `docs/superpowers/specs/2026-09-14-lumen-world-trends-design.md`（§世界热力地图）。

## Global Constraints
- **零新增依赖**；纯渲染层，无 IPC/schema 变更。
- 映射键必须与 `resources/world.geojson` 的 `properties.name` 完全一致（别名先经 `normalizeCountry` 归一到 GeoJSON 名）。
- i18n 新增 `world.dim.*` / `world.regions` / `world.region.*`（11 键 × 2，`i18n.test` 校验集合一致）。

---

### Task 1: 大洲映射与聚合（TDD）

**Files:**
- Create: `src/world/regions.ts`
- Test: `tests/world-regions.test.ts`

**Interfaces:**
- Produces: `regionOfCountry(name) => RegionKey` / `aggregateRegions(items) => { key; count }[]`

- [x] Step 1 失败测试：映射抽查（美/中/俄/巴/以/尼日利亚/澳/科索沃/所罗门群岛）+ 别名合并（US/United States/美国）+ 非地图实体丢弃 + 降序/去零。
- [x] Step 2 实现 `regions.ts`（GeoJSON 名称 → 8 洲，缺省 other）。
- [x] Step 3 `tsc` 通过、单测转绿。

### Task 2: WorldTab 维度切换

**Files:**
- Modify: `src/components/WorldTab.tsx`（`dim` 状态 + 地图 data 洲聚合 + 榜单/回放联动）
- Modify: `src/i18n/dict.ts`（`world.dim.*` / `world.regions` / `world.region.*` ×2）
- Modify: `src/styles.css`（维度切换 chips 间距/复用现有 `.chip.pick.on`）

- [x] Step 4 地图卡顶部加「国家/大洲」维度 chips；region 模式地图按洲着色。
- [x] Step 5 榜单卡双态：国家 Top15 / 洲级热度 chips；回放模式同样取当日数据聚合。
- [x] Step 6 `i18n.test` 通过（zh/en key 集合一致）。

### Task 3: 验证与文档

- [x] Step 7 全量 `npm test` + `tsc --noEmit` + `npm run build` + `LUMEN_SMOKE=1` 冒烟。
- [x] Step 8 更新 README（特性/看板/测试覆盖/路线图）。
- [x] Step 9 commit `feat: M17 world region aggregation view`。
