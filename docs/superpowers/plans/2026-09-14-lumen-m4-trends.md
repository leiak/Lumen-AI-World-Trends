# M4 趋势引擎实现计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 基于事件图谱与实体出现记录，计算话题热度**时间序列**与**动量（涨/跌）**，输出世界热点聚合，供看板/热力图使用，并暴露 `topics:list` IPC。

**Architecture:** 新增 `article_entity` 关联表（文章↔实体↔时间）；趋势引擎纯函数读取该表，按时间桶聚合实体频次、以前后半桶之差计算动量；另聚合 `type='country'` 实体作为世界热点。全部以种子数据 fixture 测试。

**Tech Stack:** Electron main (Node/TS), sql.js。

**Spec:** `docs/superpowers/specs/2026-09-14-lumen-world-trends-design.md`

## Global Constraints
- 迁移升到 v4，新增 `article_entity(article_id, entity_id, crawled_at, PRIMARY KEY(article_id, entity_id))` 与索引；`db.test.ts` 断言更新。
- 时间桶：`now - horizonMs` 到 `now` 均分为 `bucketCount` 个桶（默认 7 天、8 桶）。
- `momentum = secondHalfCount - firstHalfCount`（后半桶总和 − 前半桶总和），`rising = momentum > 0`。
- 趋势/热力数据经 `shared/trend.ts` 单一类型来源。
- 引擎只读、纯函数，测试用内存库种子 SQL，不发网络。

---

### Task 1: 迁移 v4 + article_entity 入库

**Files:**
- Modify: `electron/main/db/migrate.ts`（新增 `article_entity`，schema_version → '4'）
- Modify: `electron/main/graph/repository.ts`（`saveArticleEntities(db, articleId, entities, crawledAt)`）
- Modify: `electron/main/graph/build.ts`（build 中写入 article_entity）
- Modify: `tests/db.test.ts`（schema '4'，断言含 `article_entity`）
- Modify: `tests/build.test.ts`（断言 `article_entity` 行数 ≥ 实体数 * 文章数）

**Interfaces:**
- Produces: `saveArticleEntities(db, articleId: string, entities: NamedEntity[], crawledAt: string): number`

- [x] **Step 1: 更新迁移与 db 测试（v4）**

`migrate.ts` 追加：
```sql
CREATE TABLE IF NOT EXISTS article_entity (
  article_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  crawled_at TEXT NOT NULL,
  PRIMARY KEY (article_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_article_entity_crawled ON article_entity(crawled_at);
```
`schema_version` → '4'；`tests/db.test.ts` 加 `expect(tables).toContain('article_entity')`，版本断言改 '4'。

- [x] **Step 2: 实现仓储与 build 接线**

`repository.ts`: `saveArticleEntities`（`INSERT OR IGNORE`，`getRowsModified` 计数）。
`build.ts`: 在 `saveEntities` 后对每个 item 调用 `saveArticleEntities(db, article.id, entities, article.crawledAt)`。

- [x] **Step 3: 运行测试确认通过**

Run: `npm test` → 全绿；`npx tsc` 无错。

- [x] **Step 4: Commit**

```bash
git commit -am "feat: article_entity join for time-based trends (schema v4)"
```

---

### Task 2: 趋势引擎（时间序列 + 动量）

**Files:**
- Create: `shared/trend.ts`
- Create: `electron/main/trends/engine.ts`
- Create: `tests/trends.test.ts`

**Interfaces:**
- Consumes: `article_entity` + `entity` 表。
- Produces:
  - `shared/trend.ts`:
    - `export interface TrendPoint { bucketStart: string; count: number }`
    - `export interface TopicTrend { key: string; name: string; count: number; buckets: TrendPoint[]; momentum: number; rising: boolean }`
    - `export interface CountryHeat { name: string; count: number }`
    - `export interface TrendsResult { trends: TopicTrend[]; countries: CountryHeat[]; generatedAt: string }`
  - `engine.ts`:
    - `export interface TrendOptions { horizonMs?: number; bucketCount?: number; topN?: number; now?: string }`
    - `computeTrends(db, opts?: TrendOptions): TrendsResult`

**Algorithm（computeTrends）：**
1. `now`（默认当前）、`horizon`=7d、`bucketCount`=8、`topN`=20。
2. 读 `article_entity JOIN entity`，仅 `crawled_at >= now - horizon`。
3. 按实体聚合 `count`；将 `[start, now]` 均分桶，命中时间落到桶，得 `buckets`。
4. `firstHalf=sum(buckets[0..mid])`，`secondHalf=sum(buckets[mid..])`，`momentum=secondHalf-firstHalf`，`rising=momentum>0`。
5. `trends` 按 count 降序取 topN。
6. `countries` = `type='country'` 实体聚合，按 count 降序。

- [x] **Step 1: 写失败测试**

写入 `tests/trends.test.ts`：种子 article_entity（2 个实体，时间跨前后半桶）→ 断言总计数、桶数、`rising` 方向、`countries` 归属。种子直接用 SQL INSERT（构造基准 `now`，字段对齐桶边界）。

- [x] **Step 2: 运行测试确认失败** → FAIL（模块不存在）。

- [x] **Step 3: 实现 `shared/trend.ts` 与 `engine.ts`**。

- [x] **Step 4: 运行测试确认通过** → PASS。

- [x] **Step 5: Commit**

```bash
git commit -am "feat: trend engine with time series and momentum"
```

---

### Task 3: 世界热点聚合（heatmap 数据）

**Files:**
- Create: `tests/heatmap.test.ts`
- Modify: `electron/main/trends/engine.ts`
- Modify: `shared/trend.ts`（如需扩展）

**Interfaces:**
- Produces: `computeHeatmap(db, opts?): CountryHeat[]`
  - 复用 Task 2 的 `countries` 聚合；按 ISO 兼容的城市/国家名（保持 entity.name）输出 `{name, count}`，按 count 降序。看板热力图用 name 匹配世界 GeoJSON。

- [x] **Step 1: 写失败测试**（断言国家实体计数正确、降序、排除非国家实体）

- [x] **Step 2: 运行测试确认失败** → FAIL。

- [x] **Step 3: 实现 `computeHeatmap`**。

- [x] **Step 4: 运行测试确认通过** → PASS。

- [x] **Step 5: Commit**

```bash
git commit -am "feat: world heatmap country aggregation"
```

---

### Task 4: IPC `topics:list` 接入

**Files:**
- Modify: `shared/contracts.ts`（类型已含 `topics:list` 渠道，无需加）
- Modify: `electron/main/ipc/register.ts`（挂 `topics:list`）
- Modify: `electron/main/index.ts`（注入 `runTopics`）
- Create: `tests/trends-ipc.test.ts`（可选：验证 `computeTrends` 函数联动）

**Interfaces:**
- Produces: IPC `topics:list` → `IpcResponse<TrendsResult>`
- `register.ts` 新增 `IpcDeps.runTopics?: () => Promise<IpcResponse<TrendsResult>>`，`ipcMain.handle('topics:list', ...)`。
- `index.ts`：`runTopics: async () => ({ ok: true, data: computeTrends(getDb()) })`。

- [x] **Step 1: 更新 register.ts 与 index.ts**

（pending 更新保证 `npx tsc` 无错。）

- [x] **Step 2: 全量验证**

Run: `npm test` 全绿；`npx tsc` 无错；`npm run build` 成功；`LUMEN_SMOKE` 冒烟 IPC 正常。

- [x] **Step 3: Commit**

```bash
git commit -am "feat: topics:list ipc for trends"
```

---

## Self-Review
- **Spec 覆盖**：趋势分析时间序列/动量/聚类（spec §3 趋势引擎）、`topics:list`（spec §5）、看板热力图数据铺垫。
- **占位符扫描**：无 TBD；关键算法与 SQL 直接给出。
- **类型一致性**：`TopicTrend/TrendsResult` 单一定义于 `shared/trend.ts`；`computeTrends` 与 IPC 载荷一致。

---

## M4 交付记录（2026-09-14）
- Task 1 `9a44f5a`（article_entity + schema v4）· Task 2/3 `f02b148`（趋势引擎/热力）· Task 4 `d65b600`（topics:list IPC）
- `npm test`：24/24 通过、`npx tsc` 无错、构建成功、冒烟正常。

## Rulings（裁定记录）
- **Ruling 8 — 动量用前后半桶计数差**：`momentum = secondHalf - firstHalf`，`rising = momentum > 0`，简单且对时序直观；如需更细滑/相对动量可后续扩展。
- **Ruling 9 — 世界热点目前以「国家实体频次」近似**：按 `type='country'` 实体计数降序，为看板热力图提供数据；确切地理归属（城市、州）留待后续地理编码。
- **Ruling 10 — 默认窗口 7 天 / 8 桶**：趋势粒度先按周滚动；窗口/粒度均可在 `TrendOptions` 调整。
