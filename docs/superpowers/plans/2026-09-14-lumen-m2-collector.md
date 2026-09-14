# M2 采集层实现计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 在 M1 骨架上打通「采集 → 标准化去重 → 本地入库 → 增量游标 → IPC 手动触发」的采集引擎闭环，全程用夹具测试、不依赖真实网络。

**Architecture:** 主进程内定义统一 `Collector` 接口，RSS/HTML 两种适配器分别注入 `loadXml`/`loadHtml` 以便夹具测试；`crawlManager` 汇总采集、按 `rawHash` 去重，`source_article` 表持久化，`source_state` 保存增量游标。

**Tech Stack:** Electron main (Node/TS), sql.js, axios, cheerio, rss-parser。

**Spec:** `docs/superpowers/specs/2026-09-14-lumen-world-trends-design.md`

## Global Constraints
- 无任何监听端口服务；采集在主进程 Node 内完成。
- 单一类型来源（`shared/models.ts`）定义 `SourceArticle`，主/渲染共享；禁止重复定义。
- 测试使用 fixture（XML/HTML 字符串/DB in-memory），**绝不**在测试里发真实网络请求。
- 数据库迁移：schema 升级到 v2，新增 `source_article` 表；`db.test.ts` 断言随之更新。
- `rawHash` = sha1(`source|url|title`)，作为跨源/同源去重主键。
- 真实采集依赖外部网络，不在 CI/测试中验证；以夹具驱动 `runCrawl` 验证逻辑。

---

### Task 1: 文章模型与 ID/标准化

**Files:**
- Create: `shared/models.ts`
- Create: `electron/main/collectors/types.ts`
- Create: `electron/main/collectors/ids.ts`
- Create: `tests/normalize.test.ts`

**Interfaces:**
- Produces（后续任务依赖）:
  - `shared/models.ts`: `export interface SourceArticle { id; source; title; content?; url; lang: 'zh'|'en'; publishedAt: string|null; crawledAt: string; rawHash: string }`
  - `collectors/types.ts`:
    - `export interface SourceConfig { id; name; lang; kind: 'rss'|'html'; url; itemSelector?; titleSelector?; linkSelector?; contentSelector? }`
    - `export interface Collector { readonly config: SourceConfig; collect(): Promise<SourceArticle[]> }`
  - `collectors/ids.ts`:
    - `articleId(source, url, title): string`（sha1 hex）
    - `normalizeArticle(cfg: Omit<SourceConfig,'itemSelector'>, part: { title; url; content?; publishedAt? }): SourceArticle`

- [x] **Step 1: 写失败测试**

写入 `tests/normalize.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { articleId, normalizeArticle } from '../electron/main/collectors/ids.js';

describe('normalizeArticle', () => {
  it('生成稳定 id 与 rawHash', () => {
    const a = normalizeArticle(
      { id: 'bbc', name: 'BBC', lang: 'en', kind: 'rss', url: 'http://x/rss' },
      { title: 'Hello', url: 'http://x/1' }
    );
    expect(a.id).toBe(articleId('bbc', 'http://x/1', 'Hello'));
    expect(a.rawHash).toBe(a.id);
    expect(a.lang).toBe('en');
    expect(a.publishedAt).toBeNull();
  });

  it('相同输入两次 id 相同', () => {
    const a = normalizeArticle(
      { id: 'bbc', name: 'BBC', lang: 'en', kind: 'rss', url: 'http://x/rss' },
      { title: 'T', url: 'http://x/u' }
    );
    const b = normalizeArticle(
      { id: 'bbc', name: 'BBC', lang: 'en', kind: 'rss', url: 'http://x/rss' },
      { title: 'T', url: 'http://x/u' }
    );
    expect(a.id).toBe(b.id);
  });
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL（模块不存在）。

- [x] **Step 3: 实现模型与标准化**

写入 `shared/models.ts`、`electron/main/collectors/types.ts`、`electron/main/collectors/ids.ts`（内容见上文 Interfaces）。

`normalizeArticle` 实现：
```ts
export function normalizeArticle(
  cfg: { id: string; lang: 'zh' | 'en' },
  part: { title: string; url: string; content?: string; publishedAt?: string }
): SourceArticle {
  const id = articleId(cfg.id, part.url, part.title);
  return {
    id,
    source: cfg.id,
    title: part.title,
    url: part.url,
    content: part.content,
    lang: cfg.lang,
    publishedAt: part.publishedAt ?? null,
    crawledAt: new Date().toISOString(),
    rawHash: id
  };
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add shared electron/main/collectors tests
git commit -m "feat: article model and normalization"
```

---

### Task 2: RSS 采集适配器（可注入加载器）

**Files:**
- Create: `electron/main/collectors/rss.ts`
- Create: `tests/fixtures/rss.xml`
- Create: `tests/rss.test.ts`

**Interfaces:**
- Consumes: `SourceConfig`/`Collector` from `collectors/types.js`; `normalizeArticle` from `collectors/ids.js`.
- Produces:
  - `createRssCollector(config: SourceConfig, loadXml?: (url: string) => Promise<string>): Collector`

**Files 说明:** 默认 `loadXml` 用 `axios` 请求；测试注入读取 fixture 的 loader，`item.title/link` 对应 `SourceArticle` 的 `title/url`。

- [x] **Step 1: 写失败测试 + fixture**

写入 `tests/fixtures/rss.xml`（内含 2 条 item，各自 title+link+pubDate）。

写入 `tests/rss.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRssCollector } from '../electron/main/collectors/rss.js';
import type { SourceConfig } from '../electron/main/collectors/types.js';

const fixture = () =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'rss.xml'), 'utf8');

describe('rss collector', () => {
  it('解析 item 为 SourceArticle', async () => {
    const cfg: SourceConfig = { id: 'bbc', name: 'BBC', lang: 'en', kind: 'rss', url: 'http://x/rss' };
    const c = createRssCollector(cfg, async () => fixture());
    const arts = await c.collect();
    expect(arts).toHaveLength(2);
    expect(arts[0].title).toBeTruthy();
    expect(arts[0].url).toMatch(/^http/);
    expect(arts[0].source).toBe('bbc');
  });
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL（模块不存在）。

- [x] **Step 3: 实现 RSS 适配器**

写入 `electron/main/collectors/rss.ts`:
```ts
import Parser from 'rss-parser';
import axios from 'axios';
import { normalizeArticle } from './ids.js';
import type { Collector, SourceConfig } from './types.js';

type LoadXml = (url: string) => Promise<string>;

const defaultLoadXml: LoadXml = async (url) => (await axios.get<string>(url)).data;

export function createRssCollector(config: SourceConfig, loadXml: LoadXml = defaultLoadXml): Collector {
  return {
    config,
    async collect() {
      const xml = await loadXml(config.url);
      const parser = new Parser();
      const feed = await parser.parseString(xml);
      return (feed.items ?? [])
        .filter((i) => i.title && i.link)
        .map((i) =>
          normalizeArticle(config, {
            title: i.title!,
            url: i.link!,
            content: i.content ?? i.contentSnippet,
            publishedAt: i.isoDate ?? i.pubDate
          })
        );
    }
  };
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add electron tests
git commit -m "feat: rss collector adapter"
```

---

### Task 3: HTML 采集适配器（选择器驱动）

**Files:**
- Create: `electron/main/collectors/html.ts`
- Create: `tests/fixtures/page.html`
- Create: `tests/html.test.ts`

**Interfaces:**
- Consumes: `SourceConfig`/`Collector`; `normalizeArticle`.
- Produces: `createHtmlCollector(config: SourceConfig, loadHtml?: (url: string) => Promise<string>): Collector`

**Rules:**
- 若 `config.itemSelector` 为空 → 抛 `Error('itemSelector required')`。
- 每个 item 取 `titleSelector` 文本为标题、`linkSelector` 的 `href` 为 URL（相对地址用 `new URL(href, config.url)` 解析）；`contentSelector` 可选。

- [x] **Step 1: 写失败测试 + fixture**

写入 `tests/fixtures/page.html`（一个列表页，含 2 个 item，标题/链接/正文）。写入 `tests/html.test.ts`（断言 `collect()` 返回 2 条、标题与 URL 正确、用 fixture loader）。

- [x] **Step 2: 运行测试确认失败**

Run: `npm test`  → FAIL。

- [x] **Step 3: 实现 HTML 适配器**

`electron/main/collectors/html.ts` 用 `axios`（默认 loader）+ `cheerio`：
```ts
import * as cheerio from 'cheerio';
import axios from 'axios';
import { normalizeArticle } from './ids.js';
import type { Collector, SourceConfig } from './types.js';

type LoadHtml = (url: string) => Promise<string>;
const defaultLoadHtml: LoadHtml = async (url) => (await axios.get<string>(url)).data;

export function createHtmlCollector(config: SourceConfig, loadHtml: LoadHtml = defaultLoadHtml): Collector {
  return {
    config,
    async collect() {
      if (!config.itemSelector) throw new Error('itemSelector required');
      const html = await loadHtml(config.url);
      const $ = cheerio.load(html);
      const arts: ReturnType<typeof normalizeArticle>[] = [];
      $(config.itemSelector).each((_, el) => {
        const $item = $(el);
        const title = config.titleSelector ? $item.find(config.titleSelector).text().trim() : '';
        const relHref = config.linkSelector ? $item.find(config.linkSelector).attr('href') : undefined;
        const content = config.contentSelector ? $item.find(config.contentSelector).text().trim() : undefined;
        if (!title || !relHref) return;
        arts.push(normalizeArticle(config, { title, url: new URL(relHref, config.url).toString(), content }));
      });
      return arts;
    }
  };
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `npm test` → PASS。

- [x] **Step 5: Commit**

```bash
git add electron tests
git commit -m "feat: html collector adapter"
```

---

### Task 4: 采集管理器（汇总 + 去重）

**Files:**
- Create: `electron/main/crawl/manager.ts`
- Create: `electron/main/collectors/registry.ts`
- Create: `tests/manager.test.ts`

**Interfaces:**
- Consumes: `Collector`; `articleId` — 用于跨源去重。
- Produces:
  - `export interface CrawlItem { article: SourceArticle; sourceId: string }`
  - `runCollectors(collectors: Collector[]): Promise<SourceArticle[]>`（逐源采集，单源失败隔离记录 `errors`，返回 `{ articles, errors }`）
  - `dedupById(articles: SourceArticle[]): SourceArticle[]`（保留首个出现）
  - `registry`：`RealCollectors(): Collector[]`（可被测试覆盖用的占位导出）

- [x] **Step 1: 写失败测试**

写入 `tests/manager.test.ts`：用两个 fixture collector（返回部分重复文章）断言 `runCollectors` 返回 `{articles, errors}`、`dedupById` 去重到唯一 id 数。

- [x] **Step 2: 运行测试确认失败**

Run: `npm test` → FAIL。

- [x] **Step 3: 实现 manager 与 registry**

`manager.ts` 逐源 `try/catch` 采集，收集错误为 `{sourceId, message}`，`dedupById` 用 `Set` 按 `id` 保留首个。
`registry.ts` 导出国际 RSS 源配置（BBC/Guardian/NYT），供后续接入真实采集；`lang` 均 `en`。中文 JS 热点站适配留待后续里程碑。

- [x] **Step 4: 运行测试确认通过**

Run: `npm test` → PASS。

- [x] **Step 5: Commit**

```bash
git add electron tests
git commit -m "feat: collect manager with dedup"
```

---

### Task 5: 持久化 + 增量 + IPC 手动触发

**Files:**
- Modify: `electron/main/db/migrate.ts`（新增 `source_article` 表，schema_version → '2'）
- Create: `electron/main/db/persistence.ts`
- Modify: `electron/main/ipc/register.ts`（挂 `collector:manualRun`）
- Modify: `electron/main/index.ts`（初始化 db 并注入）
- Create: `tests/persistence.test.ts`
- Modify: `tests/db.test.ts`（schema_version 期望 '2'，断言含 `source_article`）

**Interfaces:**
- Consumes: `Database`（sql.js）, `SourceArticle`, `runCollectors`/`dedupById`.
- Produces:
  - `getExistingHashes(db, source): Set<string>`
  - `insertArticles(db, articles): number`
  - `upsertSourceState(db, id, lastCrawledAt): void`
  - `runCrawl(db, collectors, opts?): Promise<{ addedFetched: number; addedNew: number; dupes: number; errors: {sourceId; message}[] }>`
  - IPC `collector:manualRun` → `IpcResponse<CrawlSummary>`

- [x] **Step 1: 更新迁移 + 测试（schema v2）**

修改 `migrate.ts` 增加 `source_article` DDL，版本置 `'2'`。更新 `tests/db.test.ts` 断言。

- [x] **Step 2: 写持久化 + 增量测试**

写入 `tests/persistence.test.ts`：内存库跑 `migrate`，`insertArticles` 两次相同文章 → 第二次插入 0；`runCrawl` 用 fixture collector，断言首次 `addedNew=2`、再次 `addedNew=0, dupes=2`。

- [x] **Step 3: 运行测试确认失败**

Run: `npm test` → FAil（persistence 模块不存在）。

- [x] **Step 4: 实现 persistence 与 manualRun**

实现 `persistence.ts`（`runCrawl` 先 `getExistingHashes` → `runCollectors` → `dedup` 剔除已存在 → `insertArticles` → `upsertSourceState`）。在 `register.ts` 增加 `collector:manualRun` handler（调用 `runCrawl` 返回统计）。`index.ts` 里初始化 db 并传入。

- [x] **Step 5: 运行测试确认通过**

Run: `npm test` → PASS；`npx tsc --noEmit` 无错。

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: persistence, incremental crawl, ipc manualRun"
```

---

## Self-Review
- **Spec 覆盖**：采集器统一接口（M2 spec §3 数据流采集层）、增量抓取（spec §4 SourceState）、本地入库、手动 IPC（spec §5 `collector:manualRun`）、夹具测试（spec §7）。
- **占位符扫描**：每个代码步均给实际代码或明确接口，无 TBD。
- **类型一致性**：`SourceArticle`、`SourceConfig`、`Collector`、`runCrawl` 在各任务间签名一致，单一定义在 `shared/models.ts` 与 `collectors/types.ts`。
- **决议（Ruling 待记录）**：中文 JS 热点站无法纯 HTML 采集，纳入后续里程碑；M2 落地引擎 + 国际 RSS/HTML 适配。

---

## M2 交付记录（2026-09-14）
- Task 1 `9857c05`（文章模型+标准化）· Task 2 `eb8e9fb`（RSS 适配器）· Task 3 `3036d38`（HTML 适配器）· Task 4 `c5ad7d7`（采集管理+去重）· Task 5 `3a5eb71`（持久化+增量+IPC）
- `npm test`：14/14 通过（contract / db / normalize / rss / html / manager / persistence / engine）。
- `npm run build`：成功；冒烟 `LUMEN_SMOKE_OK {"ready":true,"sources":["bbc-world","guardian-world","nyt-world"]}`，sql.js 库在 Electron 运行时真实打开、IPC 工作正常。

## Rulings（裁定记录）
- **Ruling 3 — 中文 JS 热点站本轮不接**：微博/知乎等依赖 JS 渲染与反爬，纯 HTML 采集不可行；M2 落地引擎 + 国际 RSS（BBC/Guardian/NYT）+ 通用 HTML 适配器，中文热点站适配留待后续里程碑。若误判，代价是后续补 JS 渲染采集器（如无头浏览器）。
- **Ruling 4 — 真实外网采集不在 CI/测试验证**：本机网络对 GitHub/部分站点不稳定；采集逻辑全部以 fixture/内存库夹具驱动验证，真实网络采集由 `collector:manualRun` 在用户侧手动触发。若误判，代价是真实站点解析差异可能滞后暴露。
