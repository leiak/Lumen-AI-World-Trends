# M24 热度排序 UI — 设计文档

> 日期：2026-09-19
> 状态：已获方向确认，待用户审阅

## 1. 一句话定位

消费 M23 落库的 `article.hot_score`，在 **trends / dashboard / world** 三处暴露按热度排序与时间窗选择；提供 **4 种显示风格**（A/B/C/D），默认 B（紧凑中文）。无新 IPC schema、无新表、无新依赖。

## 2. 目标与非目标

### 目标

- 让 M23 的 `hot_score` 真正被用户看见，不只是落库。
- 三视图（trends / dashboard / world）一处都不缺。
- 4 种显示风格可切，用户偏好本地保存（`localStorage`）。
- 时间窗默认 24h，可切 7d / 30d / all。
- 不破坏现有 trends 时间排序、dashboard widget、world 详情页。
- 全程 fixture 测试，零真实网络。

### 非目标（M24 不做）

- 不做按源内百分位归一化（用户接受原始 hot_score 混排，B站百万播放压制是已知取舍）。
- 不做 per-source TTL / 热度衰减衰减函数（靠 `published_at` 窗过滤近似）。
- 不做「热点话题聚合」（沿用 M22 既有事件聚类）。
- 不做新 IPC schema 字段（只新增一个 `articles:byHot` 契约）。
- 不动 schema 版本号（沿用 v10）。

## 3. 架构决策

### 3.1 三处统一抽象

新增一个最小数据通路 `articles:byHot → SourceArticle[]`，三处共享。

仓储位置：`electron/main/graph/repository.ts`（已存在，与 `loadArticles` / `searchArticles` 同文件，物理就近）。

**关键事实**：entities 存在独立表 `article_entity(article_id, entity_id, crawled_at)`（由 `saveArticleEntities` 写入），不在 `source_article` 行内。country 过滤用 INNER JOIN。

```ts
// electron/main/graph/repository.ts (新增)
export function listByHot(db: Database, opts: {
  window: '24h' | '7d' | '30d' | 'all';
  limit?: number;
  countryEntity?: string;
}): SourceArticle[] {
  const limit = opts.limit ?? 50;
  const windowSql =
    opts.window === '24h' ? "datetime('now', '-1 day')" :
    opts.window === '7d'  ? "datetime('now', '-7 days')" :
    opts.window === '30d' ? "datetime('now', '-30 days')" :
    "datetime('1970-01-01')";

  // countryEntity 用 INNER JOIN；不带国家时只查 source_article
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

`articles:byHot` IPC handler 在 `electron/main/ipc/` 新增或追加到现有 handlers 文件，单文件 ~30 行。

### 3.2 显示风格统一组件

`<HotBadge>` 单文件（`src/components/HotBadge.tsx`）：

```ts
type HotStyle = 'A' | 'B' | 'C' | 'D';
interface Props { score: number | null; style?: HotStyle; }
```

- A = 原始整数（`125000`）
- B = 紧凑中文（`12.5 万` / `342 万` / `1.2 亿`）
- C = 🔥 徽章 + 紧凑数（带颜色背景）
- D = 横向热度条 + 紧凑数

`formatCompact()` 工具函数放同文件。

用户选择存 `localStorage['lumen.hotStyle']`，默认 `'B'`。读取失败/缺失 fallback 'B'。

### 3.3 控件位置

- **trends 页**：现有 trend list 上方加一行控件（Flex Row）：
  - 左侧 `SortToggle`：时间 ↔ 热度（两个 pill button）
  - 中间 `WindowToggle`：24h / 7d / 30d / all（4 个 pill）
  - 右侧 `StylePicker`：A / B / C / D（4 个小按钮，下划线标识当前）
- **dashboard 顶部**：新增 widget 「今日热点 Top 10」，固定 24h / 风格 C / limit=10，不显示控件。
- **world 国家详情页**：现有 country detail 顶部加区块 「该国今日热点 5 条」，固定 24h / 风格 B / limit=5。

## 4. 数据模型

### 4.1 IPC 契约新增

`shared/contracts.ts`：

```ts
articlesByHot: (opts: {
  window?: '24h' | '7d' | '30d' | 'all';   // 默认 '24h'
  limit?: number;                          // 默认 50
  countryEntity?: string;                  // 可选；world 用
}) => Promise<SourceArticle[]>;
```

### 4.2 数据库读路径修复

`electron/main/graph/repository.ts`：

- **M23 评审遗留**：`loadArticles`（line 103）和 `searchArticles`（line 115）未 SELECT `hot_score`。M24 一并补齐 SELECT `hot_score`，并更新 `rowToArticle`（line 89）映射新字段。
- 新增 `listByHot(opts)` 函数（见 §3.1）。

### 4.3 数据落库规则不变

`article.hot_score` 已由 M23 schema v10 + `insertArticles` 写入。M24 不动。

## 5. 前端实现

### 5.1 Trends 视图

文件：`src/components/TrendsTab.tsx`（已有，整体修改）。

- 顶部新增控件行 `<TrendsControls>`，包含三个子组件：
  - `<SortToggle>` —— `useState<'time'|'hot'>`，触发重查
  - `<WindowToggle>` —— `useState<Window>`，仅在 sort='hot' 时启用
  - `<StylePicker>` —— 读 `localStorage.hotStyle`，写入同 key；触发 `<HotBadge>` 重渲
- 当 `sort='hot'`：调 `articles:byHot({ window, limit: 50 })`，渲染 `<HotBadge>` 在卡片右侧。
- 当 `sort='time'`：复用现有 `topics:list` 或 `trends:*` IPC，不变。
- 切换 sort 时清空当前列表 + 显示 loading。
- 复用 `src/components/TrendsTab.tsx` 现有的 i18n hook 与 React Query（`useInvoke`）模式。

### 5.2 Dashboard 视图

文件：`src/components/DashboardTab.tsx`（已有，整体修改）。

- 新增子组件 `<HotTopWidget limit={10}>`，固定 24h / 风格 C。
- 位置：dashboard 顶部（在现有「今日热点」话题列表之前，或作为独立一行）。
- 数据：`articles:byHot({ window: '24h', limit: 10 })`，每行卡片显示 title + source + 🔥 score。
- 缓存：用 `useInvoke` 自带缓存（已有），无需额外。
- 文案：i18n key `dash.todayHot` → 「今日热点 Top 10」/ "Today's Hot Top 10"。
- 注意：现有 `dash.topTopics`（基于事件聚类 Top 话题）保留不动，与新 widget 并存。

### 5.3 World 国家详情

文件：`src/components/WorldTab.tsx`（已有，新增区块）。

- 国家详情组件顶部新增 `<CountryHotWidget entity={countryName} limit={5}>`，固定 24h / 风格 B。
- 数据：`articles:byHot({ window: '24h', countryEntity: countryName, limit: 5 })`。
- 国家归属：`countryEntity` 经 SQL 走 `article_entity.entity_id LIKE '%country%'` 匹配（见 §3.1 JOIN 实现）。country name 由调用方传入（如「中国」「美国」）。
- 0 条结果时该区块隐藏（不显示「暂无」提示，避免视觉噪音）。

### 5.4 显示风格组件

`src/components/HotBadge.tsx`（新文件）：

```tsx
type HotStyle = 'A' | 'B' | 'C' | 'D';

function formatCompact(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} 千`;
  return String(n);
}

export function HotBadge({ score, style = 'B' }: { score: number | null; style?: HotStyle }) {
  if (score == null) return null;
  if (style === 'A') return <span className="hot-raw">{score.toLocaleString()}</span>;
  if (style === 'B') return <span className="hot-compact">{formatCompact(score)}</span>;
  if (style === 'C') return <span className="hot-badge">🔥 {formatCompact(score)}</span>;
  // D: 条形；需 parent 传 max 提供归一化基线
  return null;
}
```

D 风格需要「相对热度」归一化基线（当前列表最大值）。设计：
- `<HotBadge score={n} style="D" max={M}>` —— 调用方传 max（计算自列表）。
- 条形宽度：`Math.max(8, Math.round((n / M) * 100))}%`。
- 父组件在渲染 D 风格时计算 `max = Math.max(...scores)` 并传入。

CSS：`src/styles/hot-badge.css`（或合并到现有 CSS 文件）。

## 6. i18n

`src/i18n/dict.ts`（单一文件，含 `zhDict` / `enDict`）新增：

| key | zh-CN | en-US |
|---|---|---|
| `hot` | 热度 | Heat |
| `sortByHot` | 按热度 | By heat |
| `sortByTime` | 按时间 | By time |
| `todayHot` | 今日热点 | Today's hot |
| `win24h` | 24 小时 | 24 hours |
| `win7d` | 7 天 | 7 days |
| `win30d` | 30 天 | 30 days |
| `winAll` | 全部 | All time |
| `displayStyle` | 显示风格 | Display style |
| `countryHot` | 该国今日热点 | Hot in this country |
| `hotEmpty` | 该时段暂无热点文章 | No hot articles in this window |

## 7. 测试（fixture，不发网络）

### 7.1 后端：`tests/hot-sort.test.ts`（新增 ~6 测试）

- `listByHot({ window: '24h' })`：返回时间窗内文章，按 hot_score DESC
- `listByHot({ window: '7d' })`：包含 24h 之外但 7d 之内的
- `listByHot({ window: 'all' })`：无视时间，包含 NULL hot_score 的不出现
- `listByHot({ countryEntity: '中国' })`：只返回 entities 含中国的
- `listByHot({ limit: 5 })`：返回最多 5 条
- `loadArticles` 现在 SELECT `hot_score`：fixture 文章含 hot_score 的能读回

### 7.2 前端：`tests/hot-badge.test.ts`（新增 ~4 测试）

- A：原始整数（locale-aware toLocaleString）
- B：12.5 万 / 342 万 / 1.2 亿 / 999（<1k 不缩）
- C：含 🔥 emoji + 紧凑数 + CSS class `hot-badge`
- D：条形宽度按 max 归一化（mock max=100, score=25 → 25%）

### 7.3 端到端：`tests/articles-by-hot.test.ts`（新增 ~3 测试）

- IPC `articles:byHot({ window: '24h', limit: 10 })` 命中预期数据
- `articles:byHot({ countryEntity: 'X' })` 正确过滤
- localStorage 默认值 / 写读

## 8. UI 改动

**有**：trends / dashboard / world 三处加 UI 元素（控件 + widget）。但**不新增 Tab**，8 个 tab 结构不变。

8 张截图需重新生成（dashboard widget 是新元素，world 顶部有新块）。

## 9. 完工标准（DoD）

- tsc clean（0 错误）
- vitest：140 → ~155 测试全过（+15 新测试）
- `npm run build` 成功（dist-electron 体积增量 < 10KB）
- `npm run capture:shots` 仍能产 8 张图
- README：「特性」加一行；「路线图」勾选 M24

## 10. 风险与缓解

- **B站百万播放压制**：用户接受。文档化为已知行为。
- **countryEntity 匹配模糊**：M16/M17 既有 entities 是数组 JSON LIKE；M24 复用，不重做。
- **localStorage 不可用**（SSR/测试环境）：fallback 默认 'B'，不抛错。
- **窗口切换时 hot_score 已落库旧值**：用户切 7d 可能看到 7d 前的热度快照。接受。
- **重复渲染 D 风格时计算 max 性能**：列表 ≤ 50 条，O(n) 可接受。
