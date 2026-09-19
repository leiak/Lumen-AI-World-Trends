# M24 热度排序 UI — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消费 M23 落库的 `article.hot_score`，在 trends / dashboard / world 三处暴露按热度排序与时间窗选择；4 种显示风格可切，默认 B。

**Architecture:** 新增 `articles:byHot` IPC → `listByHot(db, opts)` SQL 走 `source_article` 单表 + 可选 INNER JOIN `article_entity`；trends 加 `<TrendsControls>`（Sort/Window/Style），dashboard 加 `<HotTopWidget>`，world 国家详情加 `<CountryHotWidget>`；`<HotBadge>` 单组件按 style='A'|'B'|'C'|'D' 渲染；用户选择存 `localStorage['lumen.hotStyle']`。

**Tech Stack:** Electron 31 + sql.js + React + Vite + TypeScript + vitest

**Spec:** `docs/superpowers/specs/2026-09-19-lumen-m24-hot-sort-ui-design.md`

---

## 文件清单

**新增：**
- `tests/list-by-hot.test.ts` — listByHot 仓储测试
- `tests/hot-badge.test.ts` — HotBadge 组件测试
- `tests/articles-by-hot.test.ts` — IPC 端到端测试
- `electron/main/ipc/articles.ts` — `articles:byHot` handler 实现
- `src/components/HotBadge.tsx` — HotBadge 组件 + `formatCompact` 工具
- `src/hooks/useHotStyle.ts` — localStorage 持久化 hook

**修改：**
- `shared/contracts.ts` — 新增 `'articles:byHot'` 频道 + 类型
- `electron/main/graph/repository.ts` — `listByHot` 新增；`loadArticles` / `searchArticles` / `rowToArticle` 修 hot_score
- `electron/main/ipc/register.ts` — 注册 `articles:byHot` channel + deps 字段
- `electron/main/index.ts` — 实现 `runArticlesByHot` 注入到 deps
- `src/components/TrendsTab.tsx` — 控件行 + 热度分支
- `src/components/DashboardTab.tsx` — `<HotTopWidget>`
- `src/components/WorldTab.tsx` — `<CountryHotWidget>`
- `src/i18n/dict.ts` — 11 个新键（中英）
- `README.md` — 特性 + 路线图勾选

---

## Task 1: IPC 契约 + 类型

**Files:**
- Modify: `shared/contracts.ts`

- [ ] **Step 1: 打开 `shared/contracts.ts`，在 `ALL_CHANNELS` 数组末尾追加**

```ts
export const ALL_CHANNELS = [
  // ...现有 33 项...
  'stocks:alerts:list',
  'stocks:alerts:add',
  'stocks:alerts:remove',
  'stocks:alerts:toggle',
  'articles:byHot'                  // ← 新增
] as const;
```

- [ ] **Step 2: 在文件末尾追加类型定义**

```ts
export type HotWindow = '24h' | '7d' | '30d' | 'all';

export interface ArticlesByHotRequest {
  window?: HotWindow;       // 默认 '24h'
  limit?: number;           // 默认 50
  countryEntity?: string;   // 可选
}
```

- [ ] **Step 3: 验证**

```bash
cd "d:/work-ai/0401-Lumen-World-trends" && npx tsc --noEmit
```

期望：0 错误。

- [ ] **Step 4: 提交**

```bash
git add shared/contracts.ts
git commit -m "feat(M24): articles:byHot IPC 契约 + HotWindow 类型"
```

---

## Task 2: listByHot 仓储函数（TDD）

**Files:**
- Modify: `electron/main/graph/repository.ts`
- Create: `tests/list-by-hot.test.ts`

- [ ] **Step 1: 写失败的测试**

新建 `tests/list-by-hot.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, runMigrations } from '../electron/main/db/connection';
import { saveArticle } from '../electron/main/db/persistence';
import { listByHot, saveArticleEntities } from '../electron/main/graph/repository';
import type { SourceArticle } from '../shared/models';

function makeArticle(overrides: Partial<SourceArticle>): SourceArticle {
  return {
    id: overrides.id ?? 'id-' + Math.random().toString(36).slice(2, 8),
    source: overrides.source ?? 'weibo-hot',
    title: overrides.title ?? '某热点话题',
    content: '',
    url: overrides.url ?? 'https://example.com/' + Math.random(),
    lang: overrides.lang ?? 'zh',
    publishedAt: overrides.publishedAt ?? new Date().toISOString(),
    crawledAt: overrides.crawledAt ?? new Date().toISOString(),
    rawHash: overrides.rawHash ?? 'h-' + Math.random().toString(36).slice(2, 10),
    hotScore: overrides.hotScore ?? null
  };
}

describe('listByHot', () => {
  let db: ReturnType<typeof openDb>;
  beforeEach(() => {
    db = openDb();
    runMigrations(db);
  });

  it('returns articles with hot_score DESC within 24h window', () => {
    const now = new Date();
    const h2 = new Date(now.getTime() - 2 * 3600 * 1000).toISOString();
    const h5 = new Date(now.getTime() - 5 * 3600 * 1000).toISOString();
    const d2 = new Date(now.getTime() - 48 * 3600 * 1000).toISOString();
    saveArticle(db, makeArticle({ rawHash: 'a1', title: '24h 内 #1', publishedAt: h2, hotScore: 100 }));
    saveArticle(db, makeArticle({ rawHash: 'a2', title: '24h 内 #2', publishedAt: h5, hotScore: 200 }));
    saveArticle(db, makeArticle({ rawHash: 'a3', title: '24h 外', publishedAt: d2, hotScore: 999 }));

    const out = listByHot(db, { window: '24h' });
    expect(out.map((a) => a.title)).toEqual(['24h 内 #2', '24h 内 #1']);
    expect(out.every((a) => a.hotScore !== null && a.hotScore !== undefined)).toBe(true);
  });

  it('excludes articles with NULL hot_score', () => {
    saveArticle(db, makeArticle({ rawHash: 'b1', title: '有热度', hotScore: 50 }));
    saveArticle(db, makeArticle({ rawHash: 'b2', title: '无热度 (RSS)', hotScore: null }));

    const out = listByHot(db, { window: 'all' });
    expect(out.map((a) => a.title)).toEqual(['有热度']);
  });

  it('window=7d includes 24h-7d window', () => {
    const d3 = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    const d10 = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    saveArticle(db, makeArticle({ rawHash: 'c1', title: '3 天前', publishedAt: d3, hotScore: 10 }));
    saveArticle(db, makeArticle({ rawHash: 'c2', title: '10 天前', publishedAt: d10, hotScore: 999 }));

    const out = listByHot(db, { window: '7d' });
    expect(out.map((a) => a.title)).toEqual(['3 天前']);
  });

  it('countryEntity filters via article_entity join', () => {
    saveArticle(db, makeArticle({ rawHash: 'd1', title: '中国热点', hotScore: 100 }));
    saveArticle(db, makeArticle({ rawHash: 'd2', title: '日本热点', hotScore: 80 }));
    saveArticleEntities(db, 'd1', [{ name: '中国', type: 'place' }], new Date().toISOString());
    saveArticleEntities(db, 'd2', [{ name: '日本', type: 'place' }], new Date().toISOString());

    const out = listByHot(db, { window: 'all', countryEntity: '中国' });
    expect(out.map((a) => a.title)).toEqual(['中国热点']);
  });

  it('limit cap works', () => {
    for (let i = 0; i < 10; i++) {
      saveArticle(db, makeArticle({ rawHash: 'e' + i, title: 'a' + i, hotScore: 100 - i }));
    }
    const out = listByHot(db, { window: 'all', limit: 3 });
    expect(out).toHaveLength(3);
  });
});
```

- [ ] **Step 2: 运行测试，期望失败**

```bash
cd "d:/work-ai/0401-Lumen-World-trends" && npx vitest run tests/list-by-hot.test.ts
```

期望：`listByHot is not a function` / `saveArticle is not exported` 等。

- [ ] **Step 3: 在 `electron/main/graph/repository.ts` 末尾追加 `listByHot`**

```ts
export function listByHot(
  db: Database,
  opts: {
    window: '24h' | '7d' | '30d' | 'all';
    limit?: number;
    countryEntity?: string;
  }
): SourceArticle[] {
  const limit = opts.limit ?? 50;
  const windowSql =
    opts.window === '24h' ? "datetime('now', '-1 day')" :
    opts.window === '7d'  ? "datetime('now', '-7 days')" :
    opts.window === '30d' ? "datetime('now', '-30 days')" :
    "datetime('1970-01-01')";

  const sql = opts.countryEntity
    ? `SELECT DISTINCT a.raw_hash, a.source, a.title, a.content, a.url, a.lang,
              a.published_at, a.crawled_at, a.hot_score
       FROM source_article a
       INNER JOIN article_entity e ON e.article_id = a.raw_hash
       WHERE a.hot_score IS NOT NULL
         AND a.published_at >= ${windowSql}
         AND e.entity_id LIKE '%' || ? || '%'
       ORDER BY a.hot_score DESC, a.published_at DESC
       LIMIT ?`
    : `SELECT a.raw_hash, a.source, a.title, a.content, a.url, a.lang,
              a.published_at, a.crawled_at, a.hot_score
       FROM source_article a
       WHERE a.hot_score IS NOT NULL
         AND a.published_at >= ${windowSql}
       ORDER BY a.hot_score DESC, a.published_at DESC
       LIMIT ?`;

  const stmt = db.prepare(sql);
  const params = opts.countryEntity ? [opts.countryEntity.toLowerCase(), limit] : [limit];
  stmt.bind(params);
  const out: SourceArticle[] = [];
  while (stmt.step()) out.push(rowToArticle(stmt.getAsObject() as Record<string, string | null>));
  stmt.free();
  return out;
}
```

- [ ] **Step 4: 确认 `saveArticleEntities` 已 export**

```bash
cd "d:/work-ai/0401-Lumen-World-trends" && grep -n "export function saveArticleEntities" electron/main/graph/repository.ts
```

期望：第 23 行起（已存在）。如果命名不一致，告知上层执行者去查实际签名。

- [ ] **Step 5: 运行测试，期望通过**

```bash
cd "d:/work-ai/0401-Lumen-World-trends" && npx vitest run tests/list-by-hot.test.ts
```

期望：5/5 通过。

- [ ] **Step 6: 提交**

```bash
git add tests/list-by-hot.test.ts electron/main/graph/repository.ts
git commit -m "feat(M24): listByHot 仓储（window/country 过滤 + hot_score DESC）"
```

---

## Task 3: 修 loadArticles/searchArticles 读 hot_score

**Files:**
- Modify: `electron/main/graph/repository.ts`

- [ ] **Step 1: 找到 `loadArticles` 当前 SELECT（约第 103 行）**

```bash
cd "d:/work-ai/0401-Lumen-World-trends" && grep -n "function loadArticles\|function searchArticles\|function rowToArticle" electron/main/graph/repository.ts
```

期望输出形如：
```
89:function rowToArticle(...)
103:export function loadArticles(...)
115:export function searchArticles(...)
```

- [ ] **Step 2: 修改 `loadArticles` 的 SELECT，追加 `hot_score`**

找到：
```ts
const stmt = db.prepare(
  `SELECT raw_hash, source, title, content, url, lang, published_at, crawled_at
   FROM source_article ORDER BY crawled_at DESC LIMIT ?`
);
```

替换为：
```ts
const stmt = db.prepare(
  `SELECT raw_hash, source, title, content, url, lang, published_at, crawled_at, hot_score
   FROM source_article ORDER BY crawled_at DESC LIMIT ?`
);
```

- [ ] **Step 3: 修改 `searchArticles` 的 SELECT 同理**

找到其 `SELECT raw_hash, source, ...`，在末尾加 `, hot_score`。

- [ ] **Step 4: 修改 `rowToArticle`，映射 hot_score**

找到函数体（约第 89 行起）。当前实现返回的 SourceArticle 缺 hotScore 字段。在函数末尾 `return { ... };` 之前，构造对象时添加：

```ts
function rowToArticle(r: Record<string, string | null>): SourceArticle {
  return {
    id: r.raw_hash ?? '',
    source: r.source ?? '',
    title: r.title ?? '',
    content: r.content ?? undefined,
    url: r.url ?? '',
    lang: (r.lang === 'zh' || r.lang === 'en') ? r.lang : 'zh',
    publishedAt: r.published_at ?? null,
    crawledAt: r.crawled_at ?? '',
    rawHash: r.raw_hash ?? '',
    hotScore: r.hot_score != null ? Number(r.hot_score) : null
  };
}
```

**注**：上面是参考实现。实际签名/字段名以当前代码为准，只确保 hotScore 字段被赋值。

- [ ] **Step 5: 运行现有测试**

```bash
cd "d:/work-ai/0401-Lumen-World-trends" && npx vitest run
```

期望：140 全过 + T2 新增 5 个 = 145 通过。

- [ ] **Step 6: 提交**

```bash
git add electron/main/graph/repository.ts
git commit -m "fix(M24): loadArticles/searchArticles 读 hot_score（修 M23 评审 gap）"
```

---

## Task 4: articles:byHot IPC handler

**Files:**
- Modify: `electron/main/ipc/register.ts`
- Modify: `electron/main/index.ts`

- [ ] **Step 1: 在 `register.ts` 的 `IpcDeps` 接口加字段**

```ts
runArticlesByHot?: (payload: unknown) => Promise<IpcResponse<SourceArticle[]>>;
```

放在 `runSearch?: ...;` 后面或 IPC 区段末尾。

- [ ] **Step 2: 在 `registerIpc` 函数体末尾注册 channel**

```ts
if (deps.runArticlesByHot) ipcMain.handle('articles:byHot', (_e, payload) => deps.runArticlesByHot!(payload));
```

- [ ] **Step 3: 在 `index.ts` 找到 `IpcDeps` 注入的位置（约第 580-600 行）**

按现有 `runSearch: ...` 模式，新增 `runArticlesByHot` 实现：

```ts
const runArticlesByHot = async (payload: unknown): Promise<IpcResponse<SourceArticle[]>> => {
  const req = (payload ?? {}) as { window?: '24h'|'7d'|'30d'|'all'; limit?: number; countryEntity?: string };
  const window = req.window ?? '24h';
  const limit = req.limit ?? 50;
  const articles = listByHot(getDb(), { window, limit, countryEntity: req.countryEntity });
  return { ok: true, data: articles };
};
```

（import：`import { listByHot } from './graph/repository.js';`）

- [ ] **Step 4: 把 `runArticlesByHot` 注入到 `registerIpc({ ... })` 的参数对象**

加一行 `runArticlesByHot,`。

- [ ] **Step 5: 验证**

```bash
cd "d:/work-ai/0401-Lumen-World-trends" && npx tsc --noEmit
```

期望：0 错误。

- [ ] **Step 6: 提交**

```bash
git add electron/main/ipc/register.ts electron/main/index.ts
git commit -m "feat(M24): articles:byHot IPC handler 接线"
```

---

## Task 5: HotBadge 组件 + formatCompact（TDD）

**Files:**
- Create: `tests/hot-badge.test.ts`
- Create: `src/components/HotBadge.tsx`

- [ ] **Step 1: 写失败的测试**

新建 `tests/hot-badge.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { formatCompact } from '../src/components/HotBadge';

describe('formatCompact', () => {
  it('formats >=1e8 as 亿', () => {
    expect(formatCompact(123_000_000)).toBe('1.2 亿');
    expect(formatCompact(1_500_000_000)).toBe('15.0 亿');
  });
  it('formats >=1e4 as 万', () => {
    expect(formatCompact(12_500)).toBe('1.3 万');
    expect(formatCompact(342_0000)).toBe('342.0 万');  // 3,420,000
  });
  it('formats <1e4 raw', () => {
    expect(formatCompact(999)).toBe('999');
    expect(formatCompact(0)).toBe('0');
  });
});
```

- [ ] **Step 2: 运行，期望失败**

```bash
cd "d:/work-ai/0401-Lumen-World-trends" && npx vitest run tests/hot-badge.test.ts
```

期望：`formatCompact is not a function`。

- [ ] **Step 3: 创建 `src/components/HotBadge.tsx`**

```tsx
export type HotStyle = 'A' | 'B' | 'C' | 'D';

export function formatCompact(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} 千`;
  return String(n);
}

interface Props {
  score: number | null | undefined;
  style?: HotStyle;
  max?: number;  // D 风格归一化基线
}

export default function HotBadge({ score, style = 'B', max }: Props) {
  if (score == null) return null;

  if (style === 'A') {
    return <span className="hot-raw">{score.toLocaleString()}</span>;
  }
  if (style === 'B') {
    return <span className="hot-compact">{formatCompact(score)}</span>;
  }
  if (style === 'C') {
    return <span className="hot-badge">🔥 {formatCompact(score)}</span>;
  }
  // D
  const m = max && max > 0 ? max : score;
  const pct = Math.max(8, Math.round((score / m) * 100));
  return (
    <span className="hot-bar-wrap">
      <span className="hot-bar-num">{formatCompact(score)}</span>
      <span className="hot-bar">
        <span className="hot-bar-fill" style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}
```

- [ ] **Step 4: 运行测试，期望通过**

```bash
cd "d:/work-ai/0401-Lumen-World-trends" && npx vitest run tests/hot-badge.test.ts
```

期望：3/3 通过。

- [ ] **Step 5: 验证渲染（可选 quick check）**

在 DevTools console 或测试中：
```ts
import { render } from '@testing-library/react';
import HotBadge from '../src/components/HotBadge';
const { container } = render(<HotBadge score={125000} style="C" />);
expect(container.textContent).toContain('🔥');
```

**注**：项目目前可能无 `@testing-library/react`。若缺失，跳过此步（5 个核心测试已足够）。在 commit 信息中注明。

- [ ] **Step 6: 提交**

```bash
git add tests/hot-badge.test.ts src/components/HotBadge.tsx
git commit -m "feat(M24): HotBadge 组件（A/B/C/D 4 风格 + formatCompact）"
```

---

## Task 6: useHotStyle hook

**Files:**
- Create: `src/hooks/useHotStyle.ts`

- [ ] **Step 1: 创建 hook**

```ts
import { useEffect, useState } from 'react';
import type { HotStyle } from '../components/HotBadge';

const KEY = 'lumen.hotStyle';
const DEFAULT: HotStyle = 'B';

function read(): HotStyle {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    if (v === 'A' || v === 'B' || v === 'C' || v === 'D') return v;
  } catch {
    // SSR / 测试环境 localStorage 不可用
  }
  return DEFAULT;
}

export function useHotStyle(): [HotStyle, (s: HotStyle) => void] {
  const [style, setStyle] = useState<HotStyle>(read);
  useEffect(() => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, style);
    } catch {
      // ignore
    }
  }, [style]);
  return [style, setStyle];
}
```

- [ ] **Step 2: 验证**

```bash
cd "d:/work-ai/0401-Lumen-World-trends" && npx tsc --noEmit
```

期望：0 错误。

- [ ] **Step 3: 提交**

```bash
git add src/hooks/useHotStyle.ts
git commit -m "feat(M24): useHotStyle localStorage hook（默认 B）"
```

---

## Task 7: i18n 11 键

**Files:**
- Modify: `src/i18n/dict.ts`

- [ ] **Step 1: 在 `zhDict` 末尾追加**

```ts
'hot.sortByHot': '按热度',
'hot.sortByTime': '按时间',
'hot.todayHot': '今日热点 Top 10',
'hot.countryHot': '该国今日热点',
'hot.win24h': '24 小时',
'hot.win7d': '7 天',
'hot.win30d': '30 天',
'hot.winAll': '全部',
'hot.displayStyle': '显示风格',
'hot.hotEmpty': '该时段暂无热点文章',
'hot.label': '热度',
```

- [ ] **Step 2: 在 `enDict` 末尾追加同名键**

```ts
'hot.sortByHot': 'By heat',
'hot.sortByTime': 'By time',
'hot.todayHot': "Today's Hot Top 10",
'hot.countryHot': 'Hot in this country',
'hot.win24h': '24 hours',
'hot.win7d': '7 days',
'hot.win30d': '30 days',
'hot.winAll': 'All time',
'hot.displayStyle': 'Display style',
'hot.hotEmpty': 'No hot articles in this window',
'hot.label': 'Heat',
```

- [ ] **Step 3: 验证**

```bash
cd "d:/work-ai/0401-Lumen-World-trends" && npx tsc --noEmit
```

期望：0 错误。

- [ ] **Step 4: 提交**

```bash
git add src/i18n/dict.ts
git commit -m "feat(M24): 11 个 i18n 键（hot.* 中英）"
```

---

## Task 8: TrendsTab 控件行 + 热度分支

**Files:**
- Modify: `src/components/TrendsTab.tsx`

- [ ] **Step 1: 顶部加 import**

```tsx
import HotBadge from './HotBadge';
import { useHotStyle } from '../hooks/useHotStyle';
import type { SourceArticle } from '../../shared/models';
```

- [ ] **Step 2: 在 `TrendsTab` 组件内加状态与 invoke**

```tsx
import type { HotWindow } from '../../shared/contracts';

type SortMode = 'time' | 'hot';
const [sortMode, setSortMode] = useState<SortMode>('time');
const [hotWindow, setHotWindow] = useState<HotWindow>('24h');
const [hotStyle, setHotStyle] = useHotStyle();
const hotArticles = useInvoke<SourceArticle[]>('articles:byHot');
```

- [ ] **Step 3: 在 useEffect 触发热点拉取（仅 sortMode==='hot' 时）**

```tsx
useEffect(() => {
  if (sortMode === 'hot') {
    void hotArticles.run({ window: hotWindow, limit: 50 });
  }
}, [sortMode, hotWindow]);
```

- [ ] **Step 4: 在现有 `<div className="toolbar">` 后插入控件行**

```tsx
<div className="toolbar trends-hot-controls">
  <div className="seg-group">
    <button className={`seg${sortMode === 'time' ? ' on' : ''}`} onClick={() => setSortMode('time')}>{t('hot.sortByTime')}</button>
    <button className={`seg${sortMode === 'hot'  ? ' on' : ''}`} onClick={() => setSortMode('hot')}>{t('hot.sortByHot')}</button>
  </div>
  {sortMode === 'hot' && (
    <>
      <div className="seg-group">
        {(['24h','7d','30d','all'] as const).map((w) => (
          <button key={w} className={`seg${hotWindow === w ? ' on' : ''}`} onClick={() => setHotWindow(w)}>{t(`hot.win${w}`)}</button>
        ))}
      </div>
      <div className="seg-group">
        {(['A','B','C','D'] as const).map((s) => (
          <button key={s} className={`seg style-${s}${hotStyle === s ? ' on' : ''}`} onClick={() => setHotStyle(s)}>{s}</button>
        ))}
      </div>
    </>
  )}
</div>
```

- [ ] **Step 5: 在主卡片区下方根据 sortMode 切换渲染**

- sortMode === 'time'：保持现有 trends 列表（不变）。
- sortMode === 'hot'：渲染 `<HotList>` 子组件（行内定义在 TrendsTab.tsx 末尾）：

```tsx
function HotList({ articles, style }: { articles: SourceArticle[]; style: 'A'|'B'|'C'|'D' }) {
  const max = articles.reduce((m, a) => Math.max(m, a.hotScore ?? 0), 0);
  if (articles.length === 0) return <p className="muted">—</p>;
  return (
    <ul className="hot-list">
      {articles.map((a) => (
        <li key={a.rawHash} className="hot-row">
          <a href={a.url} target="_blank" rel="noreferrer">{a.title}</a>
          <span className="muted">{a.source}</span>
          <HotBadge score={a.hotScore ?? null} style={style} max={max} />
        </li>
      ))}
    </ul>
  );
}
```

在 TrendsTab 主 return 内根据 `sortMode` 二选一：

```tsx
{sortMode === 'hot' ? (
  <HotList articles={hotArticles.data ?? []} style={hotStyle} />
) : (
  /* 现有 trends 渲染不变 */
)}
```

- [ ] **Step 6: 验证**

```bash
cd "d:/work-ai/0401-Lumen-World-trends" && npx tsc --noEmit && npx vitest run
```

期望：tsc 0 错误，145+ 测试全过。

- [ ] **Step 7: 提交**

```bash
git add src/components/TrendsTab.tsx
git commit -m "feat(M24): TrendsTab 控件行 + 热度分支"
```

---

## Task 9: DashboardTab HotTopWidget

**Files:**
- Modify: `src/components/DashboardTab.tsx`

- [ ] **Step 1: 加 import**

```tsx
import { useEffect, useState } from 'react';
import HotBadge from './HotBadge';
import type { SourceArticle } from '../../shared/models';
```

- [ ] **Step 2: 在文件末尾（export default 之后）加子组件**

```tsx
function HotTopWidget() {
  const { t } = useI18n();
  const { data, run } = useInvoke<SourceArticle[]>('articles:byHot');
  const [max, setMax] = useState(0);

  useEffect(() => {
    void run({ window: '24h', limit: 10 });
  }, []);

  useEffect(() => {
    if (data) setMax(data.reduce((m, a) => Math.max(m, a.hotScore ?? 0), 0));
  }, [data]);

  if (!data || data.length === 0) return null;

  return (
    <div className="card">
      <h2>{t('hot.todayHot')}</h2>
      <ul className="hot-list">
        {data.map((a) => (
          <li key={a.rawHash} className="hot-row">
            <a href={a.url} target="_blank" rel="noreferrer">{a.title}</a>
            <span className="muted">{a.source}</span>
            <HotBadge score={a.hotScore ?? null} style="C" max={max} />
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: 在 `DashboardTab` 主 return 顶部插入 widget**

找到现有 dashboard 主 return，找到最顶部的 card 之前，插入：

```tsx
<HotTopWidget />
```

放在哪个位置由执行者根据现有 dashboard 视觉布局决定（建议在第一个 .card 之前）。

- [ ] **Step 4: 验证**

```bash
cd "d:/work-ai/0401-Lumen-World-trends" && npx tsc --noEmit
```

期望：0 错误。

- [ ] **Step 5: 提交**

```bash
git add src/components/DashboardTab.tsx
git commit -m "feat(M24): DashboardTab 今日热点 Top 10 widget（24h / style C）"
```

---

## Task 10: WorldTab CountryHotWidget

**Files:**
- Modify: `src/components/WorldTab.tsx`

- [ ] **Step 1: 加 import**

```tsx
import HotBadge from './HotBadge';
import type { SourceArticle } from '../../shared/models';
```

- [ ] **Step 2: 在文件末尾加子组件**

```tsx
function CountryHotWidget({ entity }: { entity: string }) {
  const { t } = useI18n();
  const { data, run } = useInvoke<SourceArticle[]>('articles:byHot');
  const [max, setMax] = useState(0);

  useEffect(() => {
    void run({ window: '24h', countryEntity: entity, limit: 5 });
  }, [entity]);

  useEffect(() => {
    if (data) setMax(data.reduce((m, a) => Math.max(m, a.hotScore ?? 0), 0));
  }, [data]);

  if (!data || data.length === 0) return null;

  return (
    <div className="card country-hot-widget">
      <h3>{t('hot.countryHot')}</h3>
      <ul className="hot-list">
        {data.map((a) => (
          <li key={a.rawHash} className="hot-row">
            <a href={a.url} target="_blank" rel="noreferrer">{a.title}</a>
            <span className="muted">{a.source}</span>
            <HotBadge score={a.hotScore ?? null} style="B" max={max} />
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: 在国家详情渲染区插入 widget**

执行者需先打开 `src/components/WorldTab.tsx`，找到国家详情组件（按 country name 过滤并展示的位置），在主返回顶部或第一个详情元素之前插入：

```tsx
<CountryHotWidget entity={currentCountryName} />
```

其中 `currentCountryName` 替换为执行者从上下文找到的国家名变量。

- [ ] **Step 4: 验证**

```bash
cd "d:/work-ai/0401-Lumen-World-trends" && npx tsc --noEmit
```

期望：0 错误。

- [ ] **Step 5: 提交**

```bash
git add src/components/WorldTab.tsx
git commit -m "feat(M24): WorldTab 国家详情热点 widget（24h / style B / 0 结果隐藏）"
```

---

## Task 11: IPC 端到端测试

**Files:**
- Create: `tests/articles-by-hot.test.ts`

- [ ] **Step 1: 写测试**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, runMigrations } from '../electron/main/db/connection';
import { saveArticle } from '../electron/main/db/persistence';
import { listByHot, saveArticleEntities } from '../electron/main/graph/repository';
import type { SourceArticle } from '../shared/models';

function art(over: Partial<SourceArticle>): SourceArticle {
  return {
    id: 'i', source: 'weibo-hot', title: 't', content: '', url: 'https://e.x',
    lang: 'zh', publishedAt: new Date().toISOString(),
    crawledAt: new Date().toISOString(), rawHash: 'h', hotScore: null, ...over
  };
}

describe('articles:byHot end-to-end', () => {
  let db: ReturnType<typeof openDb>;
  beforeEach(() => { db = openDb(); runMigrations(db); });

  it('IPC-shaped query returns top hot articles', () => {
    saveArticle(db, art({ rawHash: 'x1', hotScore: 500 }));
    saveArticle(db, art({ rawHash: 'x2', hotScore: 300 }));
    saveArticle(db, art({ rawHash: 'x3', hotScore: 100 }));
    const out = listByHot(db, { window: '24h', limit: 2 });
    expect(out).toHaveLength(2);
    expect(out[0].hotScore).toBe(500);
    expect(out[1].hotScore).toBe(300);
  });

  it('country filter works through repository', () => {
    saveArticle(db, art({ rawHash: 'y1', title: 'cn', hotScore: 100 }));
    saveArticle(db, art({ rawHash: 'y2', title: 'jp', hotScore: 80 }));
    saveArticleEntities(db, 'y1', [{ name: '中国', type: 'place' }], new Date().toISOString());
    saveArticleEntities(db, 'y2', [{ name: '日本', type: 'place' }], new Date().toISOString());
    const out = listByHot(db, { window: 'all', countryEntity: '中国' });
    expect(out.map((a) => a.title)).toEqual(['cn']);
  });

  it('respects limit cap', () => {
    for (let i = 0; i < 5; i++) saveArticle(db, art({ rawHash: 'z' + i, hotScore: 10 - i }));
    expect(listByHot(db, { window: 'all', limit: 3 })).toHaveLength(3);
  });
});
```

- [ ] **Step 2: 运行**

```bash
cd "d:/work-ai/0401-Lumen-World-trends" && npx vitest run tests/articles-by-hot.test.ts
```

期望：3/3 通过。

- [ ] **Step 3: 提交**

```bash
git add tests/articles-by-hot.test.ts
git commit -m "test(M24): articles:byHot 端到端（IPC 形状 + 国家过滤 + limit）"
```

---

## Task 12: README + 路线图

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 在「特性」section 加一条 M24 bullet**

（位置：line 12 附近，跟随 M23 中文热点条后）

```
- **热度排序 UI**（M24）：trends / dashboard / world 三视图消费 `article.hot_score`；trends 可切 24h/7d/30d/all + 4 种显示风格；dashboard 顶部「今日热点 Top 10」；world 国家详情「该国今日热点 5 条」。
```

- [ ] **Step 2: 在「路线图」section 把 M24 行标记完成**

找到现有 M22/M23 风格路线图行（line ~268-269），在 M23 行后加：

```
- ✓ **热度排序 UI**（M24）：trends 加 sort/window/style 控件；dashboard Top 10 widget；world 国家详情 Top 5；4 种 HotBadge 风格。
```

（如果发现现有路线图结构与 M23 风格不一致，执行者按现有风格调整即可。）

- [ ] **Step 3: 验证**

```bash
cd "d:/work-ai/0401-Lumen-World-trends" && npx tsc --noEmit && npx vitest run
```

期望：tsc 0 错误，约 148+ 测试全过。

- [ ] **Step 4: 提交**

```bash
git add README.md
git commit -m "docs: M24 README 路线图勾选 + 特性条目"
```

---

## Task 13: 全量验证 + 推送

- [ ] **Step 1: 完整 tsc**

```bash
cd "d:/work-ai/0401-Lumen-World-trends" && npx tsc --noEmit
```

期望：0 错误。

- [ ] **Step 2: 完整 vitest**

```bash
cd "d:/work-ai/0401-Lumen-World-trends" && npx vitest run
```

期望：~148 测试全过。

- [ ] **Step 3: 完整 build**

```bash
cd "d:/work-ai/0401-Lumen-World-trends" && npm run build
```

期望：成功；dist-electron 体积增量 < 10KB。

- [ ] **Step 4: git status / log 检查**

```bash
git status --short && git log --oneline -16
```

期望：working tree clean；M24 commit 链清晰。

- [ ] **Step 5: 推送**

```bash
git push origin main
```

期望：成功。

- [ ] **Step 6: 不提交任何"chore: pre-push cleanup"**

如有 housekeeping 需要处理，单独评估；正常情况下无。

---

## 完工标准（DoD）

- tsc 0 错误
- vitest 全过（~148 测试）
- `npm run build` 成功
- README 路线图勾选 M24
- 8 张 capture 截图仍能生成（可选，本期未要求重跑）
- 推送成功

## 风险与回退

- **A/B/C/D 风格 CSS 没加**：纯功能不影响；但 D 风格的条形可能无样式（fallback 到裸 span）。
- **trends 国家详情 widget 缺变量**：执行者需现场读 WorldTab.tsx 找国家名变量。
- **DIST 体积超 10KB**：可能因 HotBadge 文件不大，不太会超；如超 10KB 仅 INFO，不阻断。
