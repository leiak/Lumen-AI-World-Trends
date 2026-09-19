# M23 中文热点站采集 — 实施计划

> **For agentive workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Lumen 增加 6 个中文热点站源（微博热搜 / 知乎热榜 / 今日头条热榜 / 百度热搜 / B站热门 / 抖音热门），引入 `json-api` 与 `browser` 两种新采集适配器，并新增 `article.hot_score` 字段。

**Architecture:** 扩展 `SourceConfig.kind` 加 `'json-api'` 与 `'browser'`；新增 `createCollector(cfg)` 工厂按 kind 分派；`json-api` 用 axios 拉 JSON + 极简 dot path 字段映射；`browser` 复用 Electron 内置 Chromium 跑单例隐藏 BrowserWindow；`safeAlter` 加 `article.hot_score INTEGER` 列；UI 不变（新源自动出现在「采集策略」勾选列表）。

**Tech Stack:** Electron 31（已含 Chromium）+ axios + cheerio + vitest + sql.js

**Spec:** `docs/superpowers/specs/2026-09-19-lumen-m23-zh-hot-sites-design.md`

---

## 文件清单

**新增：**
- `electron/main/collectors/jsonApi.ts` — json-api 适配器（含 `pluck` / `getByPath`）
- `electron/main/collectors/browser.ts` — browser 适配器
- `electron/main/collectors/factory.ts` — `createCollector(cfg)` switch
- `electron/main/browser/headless.ts` — BrowserWindow 单例 + `browserNavigate`
- `tests/json-api.test.ts`
- `tests/browser-collector.test.ts`
- `tests/hot-score.test.ts`

**修改：**
- `shared/models.ts` — `SourceArticle` 加 `hotScore?: number | null`
- `electron/main/collectors/types.ts` — `SourceConfig` 扩展 json-api/browser kinds + `FieldsMap`
- `electron/main/collectors/registry.ts` — 加 6 个源
- `electron/main/db/migrate.ts` — `MIGRATION_10` + `safeAlter` 加 `hot_score`
- `electron/main/db/persistence.ts` — `insertArticles` 写入 `hot_score`
- `electron/main/index.ts` — `createCollector(cfg)` 替代 `createRssCollector(cfg)` + `app.before-quit` 销毁 BrowserWindow
- `tests/db.test.ts` — `schema_version === '10'`
- `tests/insights.test.ts` — `schema_version === '10'`
- `README.md` — 加中文热点特性 + 更新路线图

---

## Task 1: SourceArticle 加 hotScore 字段

**Files:**
- Modify: `shared/models.ts`

- [ ] **Step 1: 编辑 shared/models.ts**

替换整个文件内容：

```ts
export interface SourceArticle {
  id: string;
  source: string;
  title: string;
  content?: string;
  url: string;
  lang: 'zh' | 'en';
  publishedAt: string | null;
  crawledAt: string;
  rawHash: string;
  hotScore?: number | null;
}
```

- [ ] **Step 2: 验证 tsc**

Run: `npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: 提交**

```bash
git add shared/models.ts
git commit -m "feat(M23): SourceArticle 加 hotScore 字段"
```

---

## Task 2: SourceConfig 类型扩展

**Files:**
- Modify: `electron/main/collectors/types.ts`

- [ ] **Step 1: 替换文件内容**

```ts
import type { SourceArticle } from '../../../shared/models.js';

export type FieldKey =
  | 'title'
  | 'url'
  | 'content'
  | 'hotScore'
  | 'description'
  | 'publishedAt';

export type FieldsMap = Partial<Record<FieldKey, string>>;

export interface RssSourceConfig {
  id: string;
  name: string;
  lang: 'zh' | 'en';
  kind: 'rss';
  url: string;
}

export interface HtmlSourceConfig {
  id: string;
  name: string;
  lang: 'zh' | 'en';
  kind: 'html';
  url: string;
  itemSelector?: string;
  titleSelector?: string;
  linkSelector?: string;
  contentSelector?: string;
}

export interface JsonApiSourceConfig {
  id: string;
  name: string;
  lang: 'zh' | 'en';
  kind: 'json-api';
  url: string;             // SourceConfig 必填；json-api 不用，留空字符串
  apiUrl: string;
  fieldsMap: FieldsMap;
  dataPath?: string;
  headers?: Record<string, string>;
}

export interface BrowserSourceConfig {
  id: string;
  name: string;
  lang: 'zh' | 'en';
  kind: 'browser';
  url: string;             // 同上，留空
  browserUrl: string;
  browserWaitSelector?: string;
  browserWaitMs?: number;
  browserExtractScript: string;
  fieldsMap: FieldsMap;
}

export type SourceConfig =
  | RssSourceConfig
  | HtmlSourceConfig
  | JsonApiSourceConfig
  | BrowserSourceConfig;

export interface Collector {
  readonly config: SourceConfig;
  collect(): Promise<SourceArticle[]>;
}
```

> **注：** 之前 `SourceConfig` 是单一接口（含可选字段）。改为 discriminated union 后，旧 cfg 用 `kind` 字段做收窄。后续如有现存代码按 `cfg.url` 等访问，新语法要求显式判别（`cfg.kind === 'rss'`），这正是 Task 6 工厂要做的。

- [ ] **Step 2: 验证 tsc**

Run: `npx tsc --noEmit`
Expected: 会报 `createHtmlCollector` / `createRssCollector` 类型不兼容 `SourceConfig` —— 因为它们的 cfg 入参现在是具体子类型，不能再直接赋给 `SourceConfig`。记录错误，后续 Task 5/6 修复。

- [ ] **Step 3: 暂不提交**

进入 Task 3（json-api 适配器）后再一起提交 types + adapter。

---

## Task 3: json-api 适配器

**Files:**
- Create: `electron/main/collectors/jsonApi.ts`
- Create: `tests/json-api.test.ts`

- [ ] **Step 1: 写失败测试**

写 `tests/json-api.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { createJsonApiCollector } from '../electron/main/collectors/jsonApi.js';
import type { JsonApiSourceConfig } from '../electron/main/collectors/types.js';

const cfg: JsonApiSourceConfig = {
  id: 'demo',
  name: 'Demo',
  lang: 'zh',
  kind: 'json-api',
  url: '',
  apiUrl: 'http://example.test/api',
  fieldsMap: { title: 'title', url: 'url', hotScore: 'num' }
};

describe('json-api 适配器', () => {
  it('基础字段抽取：title / url / hotScore', async () => {
    const c = createJsonApiCollector(cfg, async () => [
      { title: 'A', url: 'http://x/1', num: 1234 },
      { title: 'B', url: 'http://x/2', num: 5678 }
    ]);
    const arts = await c.collect();
    expect(arts).toHaveLength(2);
    expect(arts[0].title).toBe('A');
    expect(arts[0].url).toBe('http://x/1');
    expect(arts[0].hotScore).toBe(1234);
    expect(arts[0].source).toBe('demo');
  });

  it('dataPath 嵌套数组', async () => {
    const c = createJsonApiCollector(
      { ...cfg, dataPath: 'data.items', fieldsMap: { title: 'name', url: 'link' } },
      async () => ({ data: { items: [{ name: 'X', link: 'http://y/1' }] } })
    );
    const arts = await c.collect();
    expect(arts).toHaveLength(1);
    expect(arts[0].title).toBe('X');
  });

  it('缺 apiUrl 抛错', async () => {
    const c = createJsonApiCollector({ ...cfg, apiUrl: '' }, async () => []);
    await expect(c.collect()).rejects.toThrow('apiUrl required');
  });

  it('缺 fieldsMap.title 抛错', async () => {
    const c = createJsonApiCollector(
      { ...cfg, fieldsMap: { url: 'url' } },
      async () => []
    );
    await expect(c.collect()).rejects.toThrow('title and url required');
  });

  it('字段取值为 undefined 跳过该条', async () => {
    const c = createJsonApiCollector(cfg, async () => [
      { title: 'OK', url: 'http://x/1', num: 1 },
      { title: '', url: 'http://x/2', num: 2 },
      { title: 'NoUrl', num: 3 }
    ]);
    const arts = await c.collect();
    expect(arts).toHaveLength(1);
    expect(arts[0].title).toBe('OK');
  });

  it('hotScore 非数 → null', async () => {
    const c = createJsonApiCollector(cfg, async () => [
      { title: 'A', url: 'http://x/1', num: 'abc' },
      { title: 'B', url: 'http://x/2' /* no num */}
    ]);
    const arts = await c.collect();
    expect(arts[0].hotScore).toBeNull();
    expect(arts[1].hotScore).toBeNull();
  });

  it('JSON 解析失败抛错', async () => {
    const c = createJsonApiCollector(cfg, async () => {
      throw new Error('parse error');
    });
    await expect(c.collect()).rejects.toThrow('parse error');
  });

  it('headers 透传', async () => {
    let captured: Record<string, string> | undefined;
    const c = createJsonApiCollector(
      { ...cfg, headers: { 'X-Test': '1' } },
      async (_url, headers) => {
        captured = headers;
        return [];
      }
    );
    await c.collect();
    expect(captured).toEqual({ 'X-Test': '1' });
  });

  it('content / description / publishedAt 透传', async () => {
    const c = createJsonApiCollector(
      {
        ...cfg,
        fieldsMap: {
          title: 't',
          url: 'u',
          content: 'body',
          description: 'desc',
          publishedAt: 'time'
        }
      },
      async () => [{ t: 'X', u: 'http://x/1', body: 'B', desc: 'D', time: '2026-09-19' }]
    );
    const arts = await c.collect();
    expect(arts[0].content).toBe('B');
    expect(arts[0].publishedAt).toBe('2026-09-19');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/json-api.test.ts`
Expected: FAIL（模块未找到：`createJsonApiCollector`）。

- [ ] **Step 3: 实现 json-api 适配器**

写 `electron/main/collectors/jsonApi.ts`：

```ts
import axios from 'axios';
import { normalizeArticle } from './ids.js';
import type {
  Collector,
  FieldsMap,
  JsonApiSourceConfig
} from './types.js';
import type { SourceArticle } from '../../../shared/models.js';

type LoadJson = (url: string, headers?: Record<string, string>) => Promise<unknown>;

const defaultLoadJson: LoadJson = async (url, headers) =>
  (await axios.get(url, { headers, timeout: 15000 })).data;

/** 极简两层 dot path：'a' / 'a.b' / 'a[0].b' / 'a[0].b.c' / '[0].b'
 *  不实现完整 JSONPath；不支持 '[]' 数组迭代占位。 */
export function pluck(obj: unknown, path: string): unknown {
  if (obj == null) return undefined;
  // 分词：'info[0].word' → ['info', '[0]', 'word']
  const tokens: string[] = [];
  let cur = '';
  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if (ch === '.' || ch === '[') {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
      if (ch === '[') {
        const end = path.indexOf(']', i);
        if (end < 0) return undefined;
        tokens.push(path.slice(i, end + 1));
        i = end;
      }
    } else if (ch === ']') {
      // 已由 '[' 处理
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);

  let v: unknown = obj;
  for (const t of tokens) {
    if (v == null) return undefined;
    const m = t.match(/^\[(\d+)\]$/);
    if (m) {
      v = Array.isArray(v) ? v[Number(m[1])] : undefined;
    } else {
      v = (v as Record<string, unknown>)[t];
    }
  }
  return v;
}

/** dataPath：单层 dot path 走到数组根；缺省视为整体 */
export function getByPath(obj: unknown, path: string): unknown {
  if (obj == null) return undefined;
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function numOrNull(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function createJsonApiCollector(
  cfg: JsonApiSourceConfig,
  loadJson: LoadJson = defaultLoadJson
): Collector {
  return {
    config: cfg,
    async collect(): Promise<SourceArticle[]> {
      if (!cfg.apiUrl) throw new Error('apiUrl required');
      if (!cfg.fieldsMap.title || !cfg.fieldsMap.url) {
        throw new Error('fieldsMap.title and url required');
      }
      const raw = await loadJson(cfg.apiUrl, cfg.headers);
      const arr = cfg.dataPath ? getByPath(raw, cfg.dataPath) : raw;
      if (!Array.isArray(arr)) return [];
      const out: SourceArticle[] = [];
      for (const item of arr) {
        const title = pluck(item, cfg.fieldsMap.title);
        const url = pluck(item, cfg.fieldsMap.url);
        if (!title || !url) continue;
        out.push(
          normalizeArticle(
            cfg,
            {
              title: String(title),
              url: String(url),
              content: cfg.fieldsMap.content
                ? pluck(item, cfg.fieldsMap.content)
                : undefined,
              publishedAt: cfg.fieldsMap.publishedAt
                ? pluck(item, cfg.fieldsMap.publishedAt) as string | undefined
                : undefined,
              hotScore: numOrNull(
                cfg.fieldsMap.hotScore
                  ? pluck(item, cfg.fieldsMap.hotScore)
                  : undefined
              )
            }
          )
        );
      }
      return out;
    }
  };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run tests/json-api.test.ts`
Expected: 8 passed。

- [ ] **Step 5: 提交**

```bash
git add electron/main/collectors/jsonApi.ts tests/json-api.test.ts
git commit -m "feat(M23): json-api 适配器 + 8 项测试"
```

---

## Task 4: browser 适配器

**Files:**
- Create: `electron/main/collectors/browser.ts`
- Create: `tests/browser-collector.test.ts`

- [ ] **Step 1: 写失败测试**

写 `tests/browser-collector.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { createBrowserCollector } from '../electron/main/collectors/browser.js';
import type { BrowserSourceConfig } from '../electron/main/collectors/types.js';

const cfg: BrowserSourceConfig = {
  id: 'demo',
  name: 'Demo',
  lang: 'zh',
  kind: 'browser',
  url: '',
  browserUrl: 'http://example.test/',
  browserExtractScript: 'return [{title:"A",url:"http://x/1",num:100}];',
  fieldsMap: { title: 'title', url: 'url', hotScore: 'num' }
};

describe('browser 适配器', () => {
  it('正常提取数组 → 字段映射 + normalize', async () => {
    const navigate = vi.fn(async () => [
      { title: 'A', url: 'http://x/1', num: 100 },
      { title: 'B', url: 'http://x/2', num: 200 }
    ]);
    const c = createBrowserCollector(cfg, navigate);
    const arts = await c.collect();
    expect(arts).toHaveLength(2);
    expect(arts[0].title).toBe('A');
    expect(arts[0].hotScore).toBe(100);
    expect(arts[0].source).toBe('demo');
    expect(navigate).toHaveBeenCalledWith('http://example.test/', {
      waitSel: undefined,
      waitMs: undefined,
      extractScript: cfg.browserExtractScript
    });
  });

  it('navigate 抛错 → 返回空数组', async () => {
    const navigate = vi.fn(async () => {
      throw new Error('load fail');
    });
    const c = createBrowserCollector(cfg, navigate);
    const arts = await c.collect();
    expect(arts).toEqual([]);
  });

  it('navigate 返回非数组 → 返回空数组', async () => {
    const navigate = vi.fn(async () => ({ not: 'array' }));
    const c = createBrowserCollector(cfg, navigate);
    const arts = await c.collect();
    expect(arts).toEqual([]);
  });

  it('多源共用 navigate，一源错不污染下一源', async () => {
    let call = 0;
    const navigate = vi.fn(async () => {
      call++;
      if (call === 1) throw new Error('first source boom');
      return [{ title: 'OK', url: 'http://x/1' }];
    });
    const c1 = createBrowserCollector(cfg, navigate);
    const c2 = createBrowserCollector(cfg, navigate);
    const a1 = await c1.collect();
    const a2 = await c2.collect();
    expect(a1).toEqual([]);
    expect(a2).toHaveLength(1);
  });

  it('缺 browserExtractScript 抛错', async () => {
    const c = createBrowserCollector(
      { ...cfg, browserExtractScript: '' },
      async () => []
    );
    await expect(c.collect()).rejects.toThrow('browserExtractScript required');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/browser-collector.test.ts`
Expected: FAIL（模块未找到）。

- [ ] **Step 3: 实现 browser 适配器**

写 `electron/main/collectors/browser.ts`：

```ts
import { normalizeArticle } from './ids.js';
import { pluck, numOrNull } from './jsonApi.js';
import type {
  BrowserSourceConfig,
  Collector
} from './types.js';
import type { SourceArticle } from '../../../shared/models.js';

export type BrowserNavigate = (
  url: string,
  opts: { waitSel?: string; waitMs?: number; extractScript: string }
) => Promise<unknown>;

export function createBrowserCollector(
  cfg: BrowserSourceConfig,
  navigate: BrowserNavigate
): Collector {
  return {
    config: cfg,
    async collect(): Promise<SourceArticle[]> {
      if (!cfg.browserExtractScript) {
        throw new Error('browserExtractScript required');
      }
      try {
        const raw = await navigate(cfg.browserUrl, {
          waitSel: cfg.browserWaitSelector,
          waitMs: cfg.browserWaitMs,
          extractScript: cfg.browserExtractScript
        });
        if (!Array.isArray(raw)) return [];
        const out: SourceArticle[] = [];
        for (const item of raw) {
          const title = pluck(item, cfg.fieldsMap.title!);
          const url = pluck(item, cfg.fieldsMap.url!);
          if (!title || !url) continue;
          out.push(
            normalizeArticle(
              cfg,
              {
                title: String(title),
                url: String(url),
                content: cfg.fieldsMap.content
                  ? pluck(item, cfg.fieldsMap.content)
                  : undefined,
                publishedAt: cfg.fieldsMap.publishedAt
                  ? pluck(item, cfg.fieldsMap.publishedAt) as string | undefined
                  : undefined,
                hotScore: numOrNull(
                  cfg.fieldsMap.hotScore
                    ? pluck(item, cfg.fieldsMap.hotScore)
                    : undefined
                )
              }
            )
          );
        }
        return out;
      } catch (err) {
        console.warn(
          '[browser]',
          cfg.id,
          'failed:',
          err instanceof Error ? err.message : err
        );
        return [];
      }
    }
  };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run tests/browser-collector.test.ts`
Expected: 5 passed。

- [ ] **Step 5: 提交**

```bash
git add electron/main/collectors/browser.ts tests/browser-collector.test.ts
git commit -m "feat(M23): browser 适配器 + 5 项测试"
```

---

## Task 5: headless BrowserWindow 单例

**Files:**
- Create: `electron/main/browser/headless.ts`

- [ ] **Step 1: 实现 headless.ts**

```ts
import { BrowserWindow } from 'electron';
import type { BrowserNavigate } from '../collectors/browser.js';

let win: BrowserWindow | null = null;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function getWin(): Promise<BrowserWindow> {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      offscreen: false,
      sandbox: false,
      contextIsolation: true
    }
  });
  win.webContents.setUserAgent(UA);
  return win;
}

export const browserNavigate: BrowserNavigate = async (url, opts) => {
  const w = await getWin();
  await w.loadURL(url);
  const waitMs = opts.waitMs ?? 4000;
  if (opts.waitSel) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const ok = await w.webContents.executeJavaScript(
        `document.querySelectorAll(${JSON.stringify(opts.waitSel)}).length > 0`
      );
      if (ok) break;
      await new Promise((r) => setTimeout(r, 200));
    }
  } else {
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return w.webContents.executeJavaScript(
    `(function(){${opts.extractScript}})()`
  );
};

export function disposeHeadless(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}
```

- [ ] **Step 2: tsc 验证**

Run: `npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: 提交**

```bash
git add electron/main/browser/headless.ts
git commit -m "feat(M23): 单例 BrowserWindow + browserNavigate"
```

---

## Task 6: collector 工厂

**Files:**
- Create: `electron/main/collectors/factory.ts`

- [ ] **Step 1: 实现 factory.ts**

```ts
import { createRssCollector } from './rss.js';
import { createHtmlCollector } from './html.js';
import { createJsonApiCollector } from './jsonApi.js';
import { createBrowserCollector } from './browser.js';
import { browserNavigate } from '../browser/headless.js';
import type { Collector, SourceConfig } from './types.js';

export function createCollector(cfg: SourceConfig): Collector {
  switch (cfg.kind) {
    case 'rss':
      return createRssCollector(cfg);
    case 'html':
      return createHtmlCollector(cfg);
    case 'json-api':
      return createJsonApiCollector(cfg);
    case 'browser':
      return createBrowserCollector(cfg, browserNavigate);
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add electron/main/collectors/factory.ts
git commit -m "feat(M23): createCollector 工厂按 kind 分派"
```

---

## Task 7: 数据库迁移 v10 + insertArticles 加 hot_score

**Files:**
- Modify: `electron/main/db/migrate.ts`
- Modify: `electron/main/db/persistence.ts`
- Modify: `tests/db.test.ts`
- Modify: `tests/insights.test.ts`

- [ ] **Step 1: 写失败测试**

编辑 `tests/db.test.ts`，把第 39 行：

```ts
expect(row.value).toBe('9');
```

改为：

```ts
expect(row.value).toBe('10');
```

并在 `'写入 schema_version'` 测试的 `for (const table of ...)` 列表前插入：

```ts
// 验证 hot_score 列存在
const colRes = db.exec(`PRAGMA table_info(source_article)`);
const cols = colRes[0] ? colRes[0].values.map((r) => r[1] as string) : [];
expect(cols).toContain('hot_score');
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL — schema_version 期望 '10' 但实际 '9'；hot_score 列不存在。

- [ ] **Step 3: 在 migrate.ts 加 MIGRATION_10**

在 `migrate.ts` 文件末尾、`export function migrate` 之前，新增：

```ts
const MIGRATION_10_ALTERS = [
  'ALTER TABLE source_article ADD COLUMN hot_score INTEGER;'
];
```

然后修改 `migrate` 函数末尾，在 `db.exec(\`DELETE FROM meta...\`` 之前插入：

```ts
  for (const stmt of MIGRATION_10_ALTERS) safeAlter(db, stmt);
```

把 `'schema_version'` 的值从 `'9'` 改为 `'10'`。

最终 `migrate` 函数：

```ts
export function migrate(db: Database): void {
  db.exec(MIGRATION_1);
  db.exec(MIGRATION_2);
  db.exec(MIGRATION_3);
  db.exec(MIGRATION_4);
  db.exec(MIGRATION_5);
  db.exec(MIGRATION_6);
  db.exec(MIGRATION_7);
  db.exec(MIGRATION_8);
  db.exec(MIGRATION_9_DDL);
  for (const stmt of MIGRATION_9_ALTERS) safeAlter(db, stmt);
  for (const stmt of MIGRATION_10_ALTERS) safeAlter(db, stmt);
  db.exec(
    `DELETE FROM meta WHERE key='schema_version';` +
      `INSERT INTO meta (key, value) VALUES ('schema_version', '10');`
  );
}
```

- [ ] **Step 4: 更新 insertArticles**

编辑 `electron/main/db/persistence.ts`，把 `insertArticles` 函数：

```ts
export function insertArticles(db: Database, articles: SourceArticle[]): number {
  let inserted = 0;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO source_article
       (raw_hash, source, title, content, url, lang, published_at, crawled_at, hot_score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const a of articles) {
    stmt.run([
      a.rawHash,
      a.source,
      a.title,
      a.content ?? null,
      a.url,
      a.lang,
      a.publishedAt,
      a.crawledAt,
      a.hotScore ?? null
    ]);
    if (db.getRowsModified() > 0) inserted++;
  }
  stmt.free();
  return inserted;
}
```

- [ ] **Step 5: 更新 insights.test.ts schema_version 期望**

编辑 `tests/insights.test.ts` 第 45 行：

```ts
expect(v).toBe('10');
```

- [ ] **Step 6: 运行所有测试**

Run: `npx vitest run`
Expected: 123 → 123 + 13（json-api 8 + browser 5 - 但 db/insights 是改数字，没有新测试）。实际预期：所有原 123 + 新增 13 + db/insights 数字更新也通过 → 总计 136 tests pass。

> **注：** db.test.ts 与 insights.test.ts 修改的是已有用例的数字，未新增。所以总新增是 13，总数 123+13=136。

- [ ] **Step 7: 提交**

```bash
git add electron/main/db/migrate.ts electron/main/db/persistence.ts tests/db.test.ts tests/insights.test.ts
git commit -m "feat(M23): schema v10 — article.hot_score + insertArticles 透传"
```

---

## Task 8: hot-score 端到端测试

**Files:**
- Create: `tests/hot-score.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import { insertArticles } from '../electron/main/db/persistence.js';
import type { SourceArticle } from '../shared/models.js';

describe('article.hot_score', () => {
  let db: Database;

  beforeAll(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();
    migrate(db);
  });

  it('写入 hot_score 后可读回', () => {
    const art: SourceArticle = {
      id: 'h1',
      source: 'weibo-hot',
      title: '微博热搜条目',
      url: 'http://weibo.test/x',
      lang: 'zh',
      publishedAt: null,
      crawledAt: '2026-09-19T00:00:00Z',
      rawHash: 'h1',
      hotScore: 1234567
    };
    insertArticles(db, [art]);
    const stmt = db.prepare('SELECT hot_score FROM source_article WHERE raw_hash=?');
    stmt.bind(['h1']);
    expect(stmt.step()).toBe(true);
    const row = stmt.getAsObject() as { hot_score: number | null };
    stmt.free();
    expect(row.hot_score).toBe(1234567);
  });

  it('未填 hotScore 时为 null（兼容旧 RSS）', () => {
    const art: SourceArticle = {
      id: 'r1',
      source: 'bbc',
      title: 'Old RSS',
      url: 'http://bbc.test/x',
      lang: 'en',
      publishedAt: null,
      crawledAt: '2026-09-19T00:00:00Z',
      rawHash: 'r1'
    };
    insertArticles(db, [art]);
    const stmt = db.prepare('SELECT hot_score FROM source_article WHERE raw_hash=?');
    stmt.bind(['r1']);
    expect(stmt.step()).toBe(true);
    const row = stmt.getAsObject() as { hot_score: number | null };
    stmt.free();
    expect(row.hot_score).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试，确认通过**

Run: `npx vitest run tests/hot-score.test.ts`
Expected: 2 passed。

- [ ] **Step 3: 提交**

```bash
git add tests/hot-score.test.ts
git commit -m "test(M23): hot_score 写入 / 读回 / 旧 RSS 兼容"
```

---

## Task 9: 6 个中文热点站源 + 调度器切到 createCollector + before-quit

**Files:**
- Modify: `electron/main/collectors/registry.ts`
- Modify: `electron/main/index.ts`

- [ ] **Step 1: 在 registry.ts 加 6 个源**

把 `REAL_SOURCES` 替换为：

```ts
import type { SourceConfig } from './types.js';

export const REAL_SOURCES: SourceConfig[] = [
  // RSS 原 5 源（结构未变）
  {
    id: 'bbc-world',
    name: 'BBC World',
    lang: 'en',
    kind: 'rss',
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml'
  },
  {
    id: 'guardian-world',
    name: 'The Guardian World',
    lang: 'en',
    kind: 'rss',
    url: 'https://www.theguardian.com/world/rss'
  },
  {
    id: 'nyt-world',
    name: 'NYT World',
    lang: 'en',
    kind: 'rss',
    url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml'
  },
  {
    id: '36kr',
    name: '36氪',
    lang: 'zh',
    kind: 'rss',
    url: 'https://36kr.com/feed'
  },
  {
    id: 'ithome',
    name: 'IT之家',
    lang: 'zh',
    kind: 'rss',
    url: 'https://www.ithome.com/rss/'
  },
  // 中文热点 6 源（json-api + browser）
  {
    id: 'weibo-hot',
    name: '微博热搜',
    lang: 'zh',
    kind: 'json-api',
    url: '',
    apiUrl: 'https://s.weibo.com/top/summary',
    headers: { Referer: 'https://s.weibo.com/' },
    fieldsMap: { title: 'word', url: 'url', hotScore: 'num' }
  },
  {
    id: 'zhihu-hot',
    name: '知乎热榜',
    lang: 'zh',
    kind: 'json-api',
    url: '',
    apiUrl:
      'https://api.zhihu.com/topstory/hot-lists/total?limit=50',
    fieldsMap: {
      title: 'target.title',
      url: 'target.url',
      hotScore: 'detail_text'
    }
  },
  {
    id: 'toutiao-hot',
    name: '今日头条热榜',
    lang: 'zh',
    kind: 'json-api',
    url: '',
    apiUrl:
      'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc',
    fieldsMap: { title: 'title', url: 'url', hotScore: 'hotValue' }
  },
  {
    id: 'bilibili-hot',
    name: 'B站热门',
    lang: 'zh',
    kind: 'json-api',
    url: '',
    apiUrl:
      'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all',
    fieldsMap: { title: 'title', url: 'link', hotScore: 'stat.view' }
  },
  {
    id: 'baidu-hot',
    name: '百度热搜',
    lang: 'zh',
    kind: 'browser',
    url: '',
    browserUrl: 'https://top.baidu.com/board?platform=pc-task',
    browserWaitSelector: '.category-wrap_iQLoo',
    browserExtractScript: `
      const items = document.querySelectorAll('.category-wrap_iQLoo');
      return Array.from(items).map((it) => {
        const a = it.querySelector('.title-content_Yd290');
        const word = it.querySelector('.c-single-text-ellipsis');
        const num = it.querySelector('.hot-index_1Bl1a');
        return {
          title: word ? word.textContent.trim() : '',
          url: a ? a.href : '',
          hotScore: num ? Number(num.textContent.replace(/[^0-9]/g, '')) : null
        };
      });
    `,
    fieldsMap: { title: 'title', url: 'url', hotScore: 'hotScore' }
  },
  {
    id: 'douyin-hot',
    name: '抖音热门',
    lang: 'zh',
    kind: 'browser',
    url: '',
    browserUrl: 'https://www.douyin.com/hot',
    browserWaitSelector: '[data-e2e="hot-list-item"]',
    browserExtractScript: `
      const items = document.querySelectorAll('[data-e2e="hot-list-item"]');
      return Array.from(items).map((it) => {
        const t = it.querySelector('a');
        return {
          title: it.textContent.trim().slice(0, 60),
          url: t ? t.href : '',
          hotScore: null
        };
      });
    `,
    fieldsMap: { title: 'title', url: 'url', hotScore: 'hotScore' }
  }
];
```

> **注：** 真实端点可能在落地时调整；某源反复失败时在「采集策略」disable 即可。

- [ ] **Step 2: 切换 index.ts 调度器**

编辑 `electron/main/index.ts`：

a) 在 imports 区添加：

```ts
import { createCollector } from './collectors/factory.js';
import { disposeHeadless } from './browser/headless.js';
```

b) 把两处：

```ts
const collectors = enabledCollectors(getDb(), REAL_SOURCES).map((cfg) => createRssCollector(cfg));
```

替换为：

```ts
const collectors = enabledCollectors(getDb(), REAL_SOURCES).map((cfg) => createCollector(cfg));
```

c) 在 `app.whenReady()` 之后或合适位置加：

```ts
app.on('before-quit', () => {
  disposeHeadless();
});
```

- [ ] **Step 3: tsc + 全部测试**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean, 136 tests pass。

- [ ] **Step 4: 构建**

Run: `npm run build`
Expected: 成功（dist-electron/index.js 体积增量 < 5KB）。

- [ ] **Step 5: 提交**

```bash
git add electron/main/collectors/registry.ts electron/main/index.ts
git commit -m "feat(M23): 注册 6 中文热点源 + 调度走 createCollector + 退出销毁窗口"
```

---

## Task 10: README + 路线图

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 加中文热点特性**

在 README 「特性」列表里，`- **股票增强**（M22）：...` 行的 **下一行**插入：

```markdown
- **中文热点站**（M23）：微博热搜 / 知乎热榜 / 今日头条热榜 / 百度热搜 / B站热门 / 抖音热门 6 个源；`json-api` 适配器走 axios + 极简 dot 路径字段映射，`browser` 适配器复用 Electron 内置 Chromium 跑单例隐藏 BrowserWindow；新增 `article.hot_score` 字段承载热度数值；新源自动出现在总览 Tab「采集策略」勾选列表，无需新 UI。
```

- [ ] **Step 2: 更新路线图**

把 `- **中文热点站（微博/知乎等）**：依赖 JS 渲染 + 反爬，当前未接；下一步可用无头浏览器型采集器适配。`

替换为：

```markdown
- **中文热点站**：已接入微博 / 知乎 / 头条 / 百度 / B站 / 抖音 6 源（`json-api` + `browser` 双适配器复用 Electron Chromium，零额外下载）；下一步可做热度排序 UI 或扩展更多站点。
```

- [ ] **Step 3: 提交**

```bash
git add README.md
git commit -m "docs(M23): 中文热点站特性 + 路线图更新"
```

---

## Task 11: 推送到 origin

- [ ] **Step 1: 全量验证**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: 全通过。

- [ ] **Step 2: 推送**

```bash
git push origin main
```

Expected: 推送成功，远程 main 包含本次 11 个 commit（Tasks 1-10 + 本 Task 11 之前的所有 commit）。

---

## 完工检查（DoD）

- [ ] tsc 干净
- [ ] 136 tests pass（123 旧 + 8 json-api + 5 browser + 2 hot-score；db.test / insights.test 数字已更新）
- [ ] `npm run build` 成功
- [ ] 总览 Tab「采集策略」勾选列表出现 6 个新中文源（手动 `npm run dev` 验证可选）
- [ ] README 特性 + 路线图已更新
- [ ] 推送成功

## 风险与备注

- 真实端点可能在落地时失效（反爬 / API 变更）。任一源失败不阻塞其他源；用户可在「采集策略」disable。
- 单例 BrowserWindow 常驻约 50-100MB；与既有 Electron 进程共享资源。
- 自动调度一轮多花 ~5-10s（6 新源中 4 个 axios，2 个 browser）。