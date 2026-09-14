# M9 双语界面 / 中文热点源 / 世界 Tab 升级 实现计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补全「中英双语界面 + 国内中文热点源 + 国家维度深挖（无 GeoJSON 的务实升级）」，让国际/国内信号都可读、可对比。

**Architecture:** 渲染层新增轻量 i18n（中/英字典 + React context + localStorage 记忆，零新依赖）；采集注册表补充两个中文 RSS 源（复用现有 RSS 适配器，逐源失败隔离）；主进程新增 `countries:detail` / `countries:series` 两个 IPC，世界 Tab 提供国家榜单 + 国家详情 + 多国对比折线。

**Tech Stack:** Electron main (Node/TS), React, ECharts, rss-parser, sql.js。

**Spec:** `docs/superpowers/specs/2026-09-14-lumen-world-trends-design.md`（§2 双语 + 国内国际、§3.1 无服务端、§5 IPC）。

## Global Constraints
- **零新增 npm 依赖**。
- 新 IPC 载荷（renderer 视角）：
  - `countries:detail` payload `{ name?: string }` → `IpcResponse<CountryDetail | null>`
  - `countries:series` payload `{ names?: string[] }` → `IpcResponse<CountrySeriesResult>`
- 类型单一来源：`src/i18n/dict.ts`（字典）、`shared/world.ts`（IPC 类型）。
- i18n：默认 `zh`，切换存 `localStorage['lumen.lang']`；测试只测纯函数（Node 无 DOM）。
- 中文源：复用 `createRssCollector`，`lang='zh'`，失败被逐源隔离；新增 fixture 测试（中文 XML 样例）。
- 渲染层读数走 `window.lumen`，样式复用 `styles.css`。

---

## 交付状态 (2026-09-14)

- [x] Task A i18n：`src/i18n/dict.ts`（55 key 中英一致）+ `I18n.tsx` Provider/`useI18n` + 头部切换按钮（localStorage 记忆）；7 个组件文案全部迁移。
- [x] Task B 中文源：`REAL_SOURCES` 新增 `36kr`（36氪）与 `ithome`（IT之家），`lang='zh'`；中文 RSS fixture 测试通过。
- [x] Task C 世界 Tab：`shared/world.ts` + `trends/computeEntitySeries` + `world/detail.ts` + `countries:detail`/`countries:series` IPC；榜单点击 → 国家详情（关联话题/文章）+ 2-4 国对比折线。
- [x] 全量验证：`npm test` 55/55、`tsc --noEmit` 无错、`npm run build` 成功、冒烟 7 Tab + EN 按钮 + 5 源正常。
- [x] README 更新（双语/中文源/世界 Tab/新 IPC/结构）。
- 说明：Task A/B/C 改动文件相对独立，但 `index.ts`/`register.ts` 仍多特性交织，按惯例合并为单次 M9 提交。

### Task A: 双语界面 i18n

**Files:**
- Create: `src/i18n/dict.ts`（`I18nKey`、`zh`/`en` 字典、`translate`）
- Create: `src/i18n/I18n.tsx`（`I18nProvider` + `useI18n`）
- Modify: `src/App.tsx`（语言切换按钮，包 Provider）
- Modify: `src/components/{DashboardTab,TimelineTab,GraphTab,InsightsTab,TrendsTab,WorldTab,SearchTab}.tsx`（文案换 `t()`）
- Test: `tests/i18n.test.ts`

**Interfaces:**
- Produces:
  - `translate(lang: 'zh'|'en', key: I18nKey): string`
  - `useI18n(): { lang: 'zh'|'en'; setLang(l: 'zh'|'en'): void; t(k: I18nKey): string }`

- [ ] Step 1 写失败测试：zh/en key 集合完全一致；`translate` 双语文案返回各自语言。
- [ ] Step 2 实现 dict + Provider/hook。
- [ ] Step 3 全组件文案迁移 + App 切换按钮。
- [ ] Step 4 `tsc` 无错；`npm test` 通过。
- [ ] Step 5 Commit `feat: bilingual ui (zh/en)`

---

### Task B: 中文热点源

**Files:**
- Modify: `electron/main/collectors/registry.ts`（新增 2 个 zh 源）
- Create: `tests/fixtures/rss-zh.xml`
- Create: `tests/rss-zh.test.ts`

**Interfaces:**
- Produces: `REAL_SOURCES` 增加 `{ id: '36kr', name: '36氪', lang: 'zh', kind: 'rss', url: 'https://36kr.com/feed' }` 与 `{ id: 'ithome', name: 'IT之家', lang: 'zh', kind: 'rss', url: 'https://www.ithome.com/rss/' }`
- Consumes: `createRssCollector`（无需改动）。

- [ ] Step 1 写中文 fixture + 失败测试（解析 zh RSS → `lang='zh'`、标题正确）。
- [ ] Step 2 注册表新增中文源。
- [ ] Step 3 `npm test` 通过。
- [ ] Step 4 Commit `feat: chinese news sources (zh)`

---

### Task C: 世界 Tab 升级 + 国家详情/对比

**Files:**
- Create: `shared/world.ts`（`CountryDetail`/`CountrySeriesResult`）
- Create: `electron/main/world/detail.ts`（`countryDetail`/`countrySeries`）
- Modify: `electron/main/trends/engine.ts`（导出 `computeEntitySeries`）
- Modify: `shared/contracts.ts`、`electron/main/ipc/register.ts`、`electron/main/index.ts`
- Modify: `src/components/WorldTab.tsx`（榜单 + 详情 + 对比折线）
- Test: `tests/world.test.ts`

**Interfaces:**
- Produces:
  - `shared/world.ts`:
    - `CountryDetail { name: string; count: number; topics: TopTopic[]; articles: TimelineArticle[] }`
    - `CountrySeriesResult { series: { name: string; points: TrendPoint[] }[] }`
  - `world/detail.ts`:
    - `countryDetail(db, name, opts?): CountryDetail | null`
    - `countrySeries(db, names, opts?): CountrySeriesResult`
  - `trends/engine.ts` 新增 `computeEntitySeries(db, names, opts?): { name: string; points: TrendPoint[] }[]`
- Consumes: `article_entity` + `entity` + `source_article`；`computeTrends` 世界热点。

- [ ] Step 1 写失败测试：种子多国多文章 → `countryDetail` 返回话题/文章；`countrySeries` 返回时间桶。
- [ ] Step 2 实现 shared/world.ts + trends 辅助 + world/detail.ts。
- [ ] Step 3 接 IPC（contracts/register/index）。
- [ ] Step 4 重写 WorldTab（国家榜 + 点击详情 + 多选对比折线）。
- [ ] Step 5 `tsc` + `npm test` 通过。
- [ ] Step 6 Commit `feat: world tab with country detail & compare`

---

## Self-Review
- **Spec 覆盖**：双语（§2）、国内源（§2/M2）、IPC 扩展（§5）、国家维度。
- **占位符扫描**：无 TBD；中文源 URL 为已知稳定公开 feed（运行期逐源失败隔离）。
- **类型一致性**：IPC 类型单一定义于 `shared/world.ts`；i18n key 集合由测试锁死。
- **无新依赖**：i18n/World 均用既有能力。