# M3 结构化 + 事件图谱实现计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 M2 采集到的文章上做「实体抽取 → 共现关系 → 事件聚类」，将结构化结果持久化为事件图谱（entity/event/edge），并提供可手动触发的 `graph:build` 管线。

**Architecture:** 轻量 NLP：双语实体词典（gazetteer）做子串匹配抽取；同一篇文章内两两实体的出现构成 `co-occurrence` 边；通过共享实体将文章 union-find 聚类成事件。抽取/聚类/持久化各为独立纯函数单元，用 fixture 驱动测试。

**Tech Stack:** Electron main (Node/TS), sql.js, node:crypto。

**Spec:** `docs/superpowers/specs/2026-09-14-lumen-world-trends-design.md`

## Global Constraints
- 实体类型枚举：`person | organization | country | location | topic | event`。
- ID 确定性：`entityId = sha1(nameLower)`；`eventId = sha1(sorted(articleIds).join('|'))`；`edgeId = sha1(source|target)`，保证幂等。
- 关系类型 v1 仅 `co-occurrence`（真正的因果/上下位关系由 M5 AI 负责）。
- 迁移升级到 v3，新增 `entity` / `event` / `article_event` / `graph_edge` 表；`db.test.ts` 断言随之更新。
- 抽取/聚类均为纯函数，测试用 fixture 文本与内存库，不发网络请求。

---

### Task 1: 双语实体词典与抽取器

**Files:**
- Create: `shared/entities.ts`
- Create: `electron/main/extract/gazetteer.ts`
- Create: `electron/main/extract/names.ts`（`entityId`）
- Create: `tests/gazetteer.test.ts`

**Interfaces:**
- Produces:
  - `shared/entities.ts`:
    - `export type EntityType = 'person' | 'organization' | 'country' | 'location' | 'topic' | 'event'`
    - `export interface NamedEntity { name: string; nameEn?: string; type: EntityType; lang: 'zh' | 'en' }`
  - `extract/gazetteer.ts`:
    - `export interface GazetteerEntry { name: string; nameEn?: string; type: EntityType; lang: 'zh' | 'en' }`
    - `createGazetteer(entries): Gazetteer`
    - `Gazetteer.match(text: string): NamedEntity[]`（大小写不敏感子串匹配、按出现去重、按长度降序保证长词优先）
  - `extract/names.ts`: `export function entityId(name: string): string`

- [ ] **Step 1: 写失败测试**

写入 `tests/gazetteer.test.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { createGazetteer } from '../electron/main/extract/gazetteer.js';

describe('gazetteer', () => {
  it('大小写不敏感抽取并去重', () => {
    const g = createGazetteer([
      { name: 'China', type: 'country', lang: 'en' },
      { name: 'United States', type: 'country', lang: 'en' }
    ]);
    const hits = g.match('CHINA and the united states visited China');
    expect(hits.map((h) => h.name)).toEqual(['China', 'United States']);
  });

  it('长词优先', () => {
    const g = createGazetteer([
      { name: 'US', type: 'country', lang: 'en' },
      { name: 'United States', type: 'country', lang: 'en' }
    ]);
    const hits = g.match('The United States agreed');
    expect(hits.map((h) => h.name)).toEqual(['United States']);
  });
});
```

- [ ] **Step 2: 运行测试确认失败** → `npm test` FAIL。

- [ ] **Step 3: 实现**

`shared/entities.ts`（类型）、`extract/names.ts`（`entityId` 用 sha1）、`extract/gazetteer.ts`（`createGazetteer` 返回 `{ match(text) }`；内部按词长度降序排序，子串匹配收集，`Set` 去重后按首次出现顺序返回）。

- [ ] **Step 4: 运行测试确认通过** → `npm test` PASS。

- [ ] **Step 5: Commit**

```bash
git add shared electron tests
git commit -m "feat: bilingual gazetteer entity extractor"
```

---

### Task 2: 共现关系构建

**Files:**
- Create: `electron/main/graph/relation.ts`
- Create: `tests/relation.test.ts`

**Interfaces:**
- Consumes: `NamedEntity`（shared/entities），`SourceArticle`（shared/models）。
- Produces:
  - `export interface GraphEdge { id: string; source: string; target: string; relationType: 'co-occurrence'; weight: number; firstSeenAt: string; lastSeenAt: string }`
  - `export function buildCooccurrenceEdges(article: { source: string; id: string; crawledAt: string }, entities: NamedEntity[]): GraphEdge[]`
    - 语义：同一篇文章内不同实体的**无向配对**，`source<target` 按 `entityId` 字典序，`edgeId = sha1(source|target)`，权重 1，时间用 `article.crawledAt`。

- [ ] **Step 1: 写失败测试**

写入 `tests/relation.test.ts`：给 3 个实体 → 期望 3 条 pair 边；`edgeId` 幂等（同 pair 两次相同）；`source/target` 字典序稳定。

- [ ] **Step 2: 运行测试确认失败** → FAIL。

- [ ] **Step 3: 实现 `relation.ts`**（无向 pair 去重，`source<target` 用字典序，id 用 `sha1(source|target)`）。

- [ ] **Step 4: 运行测试确认通过** → PASS。

- [ ] **Step 5: Commit**

```bash
git add electron tests
git commit -m "feat: co-occurrence relation builder"
```

---

### Task 3: 事件聚类

**Files:**
- Create: `electron/main/graph/cluster.ts`
- Create: `tests/cluster.test.ts`

**Interfaces:**
- Consumes: `SourceArticle`、`NamedEntity`。
- Produces:
  - `export interface ArticleWithEntities { article: SourceArticle; entities: NamedEntity[] }`
  - `export interface EventBundle { id: string; title: string; articleIds: string[]; entityIds: string[]; occurredAt: string }`
  - `export function clusterArticles(items: ArticleWithEntities[]): EventBundle[]`
    - union-find：两篇文章共享 ≥1 个实体 → 同一事件。
    - `eventId = sha1(sorted(articleIds).join('|'))`。
    - `title` = 该事件中文章数最多的实体名（无实体则用“综合事件”）。
    - `occurredAt` = 事件最早 `crawledAt`。

- [ ] **Step 1: 写失败测试**

写入 `tests/cluster.test.ts`：3 篇文章，A/B 共享 `China`，B/C 共享 `US` → 全在同一事件；另 1 篇文章无实体单独成事件；断言 event 数、articleIds 归属。

- [ ] **Step 2: 运行测试确认失败** → FAIL。

- [ ] **Step 3: 实现 `cluster.ts`**（union-find 或 BFS 连通分量；输出确定性排序）。

- [ ] **Step 4: 运行测试确认通过** → PASS。

- [ ] **Step 5: Commit**

```bash
git add electron tests
git commit -m "feat: event clustering via shared entities"
```

---

### Task 4: 图谱持久化（迁移 v3 + 仓储）

**Files:**
- Modify: `electron/main/db/migrate.ts`（新增表，schema → '3'）
- Create: `electron/main/graph/repository.ts`
- Modify: `tests/db.test.ts`（schema_version '3'，断言含新表）
- Create: `tests/repository.test.ts`

**Interfaces:**
- Consumes: `Database`（sql.js），`NamedEntity`, `GraphEdge`, `EventBundle`。
- Produces:
  - `saveEntities(db, entities): number`
  - `saveEvents(db, bundles: EventBundle[]): number`
  - `saveArticleEvents(db, bundle): void`
  - `mergeEdges(db, edges): { upserted: number }`（按 edgeId 累加 weight、刷新 lastSeenAt）
  - `loadArticles(db, limit?): SourceArticle[]`（从 `source_article` 读最近文章）

**Migration v3 SQL:**
```sql
CREATE TABLE IF NOT EXISTS entity (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_en TEXT, type TEXT NOT NULL, lang TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS event (id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT, occurred_at TEXT, lang TEXT);
CREATE TABLE IF NOT EXISTS article_event (article_id TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY (article_id, event_id));
CREATE TABLE IF NOT EXISTS graph_edge (id TEXT PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL, event_id TEXT, relation_type TEXT NOT NULL, weight INTEGER NOT NULL DEFAULT 1, first_seen_at TEXT, last_seen_at TEXT);
CREATE INDEX IF NOT EXISTS idx_edge_source ON graph_edge(source);
CREATE INDEX IF NOT EXISTS idx_article_event_article ON article_event(article_id);
```

- [ ] **Step 1: 更新迁移与 db 测试（v3）**

修改 `migrate.ts`（追加以上 DDL，schema_version → '3'）；更新 `tests/db.test.ts`。

- [ ] **Step 2: 写仓储测试**

写入 `tests/repository.test.ts`：内存库 `migrate`，`saveEntities` 幂等、`mergeEdges` 同 edgeId 累加 weight、`saveEvents`+`saveArticleEvents` 落库、`loadArticles` 返回插入的文章。

- [ ] **Step 3: 运行测试确认失败** → FAIL（repository 不存在）。

- [ ] **Step 4: 实现 `repository.ts`**（用 M2 的 `insertArticles` 同样方式：`stmt.step`/`getRowsModified`；`mergeEdges` 用 `INSERT ... ON CONFLICT(id) DO UPDATE SET weight=weight+excluded.weight, last_seen_at=excluded.last_seen_at`，返回影响行数判定 upsert）。

- [ ] **Step 5: 运行测试确认通过** → PASS；`npx tsc --noEmit` 无错。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: graph persistence schema v3"
```

---

### Task 5: buildGraph 管线 + IPC 手动触发

**Files:**
- Create: `electron/main/graph/build.ts`
- Modify: `shared/contracts.ts`（新增 `graph:build` 渠道）
- Modify: `electron/main/ipc/register.ts`（挂 `graph:build`）
- Modify: `electron/main/index.ts`（注入 build handler）
- Create: `tests/build.test.ts`

**Interfaces:**
- Consumes: `loadArticles`, `createGazetteer`+内置词典, `clusterArticles`, `buildCooccurrenceEdges`, 各仓储函数。
- Produces:
  - `export interface GraphBuildResult { articles: number; entities: number; events: number; edges: number }`
  - `export async function buildGraph(db, articles, gazetteer): Promise<GraphBuildResult>`
  - `defaultGazetteer()`：内置少量国际源常用实体（国家/机构/人物，双语若干）供默认可运行。

**Pipeline 顺序：**
1. 对每篇文章 `extractEntities(gazetteer, title + ' ' + content)`。
2. `clusterArticles` → 事件。
3. 保存 entities / events / article_event。
4. 对所有文章产出的实体构建共现边 → `mergeEdges`。
5. 返回计数。

**IPC：** `graph:build` → 读 `loadArticles(db, 200)` → `buildGraph` → 返回 `CrawlSummary` 结构（`{articles,entities,events,edges}`）。

- [ ] **Step 1: 写失败测试**

写入 `tests/build.test.ts`：内存库 + 预填 2 篇共享 `China` 的文章 + 词典 → `buildGraph` 返回 `entities>=1`、`events>=1`、`edges>=1`；再跑一次幂等（entities/events 数量稳定）。

- [ ] **Step 2: 运行测试确认失败** → FAIL。

- [ ] **Step 3: 实现 `build.ts` 与 `defaultGazetteer`**。

- [ ] **Step 4: 接 IPC**（contracts + register + index）。

- [ ] **Step 5: 运行测试确认通过** → PASS；`npx tsc --noEmit` 无错；`npm run build` 成功。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: buildGraph pipeline + graph:build ipc"
```

---

## Self-Review
- **Spec 覆盖**：实体识别（spec §3 结构化层）、事件去重/关系抽取、图谱入库、`graph:build` 手动触发。
- **占位符扫描**：无 TBD；每步给接口或代码。
- **类型一致性**：`NamedEntity`、`GraphEdge`、`EventBundle` 在各任务签名一致；实体类型枚举在 `shared/entities.ts` 单一定义。
- **升级判定**：M4 趋势引擎、M5 AI 因果、M6 看板另立计划。
