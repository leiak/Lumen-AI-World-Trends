# M23 中文热点站采集 — 设计文档

> 日期：2026-09-19
> 状态：已获方向确认，待用户审阅

## 1. 一句话定位

为 Lumen 增加 **6 个中文热点站源**（微博热搜 / 知乎热榜 / 今日头条热榜 / 百度热搜 / B站热门 / 抖音热门），引入 `json-api` 与 `browser` 两种新采集适配器，并新增 `article.hot_score` 字段以承载热度信息。新源复用现有 article 落库 + 图谱 + 趋势 + 解读链路，无新 UI。

## 2. 目标与非目标

### 目标

- 让中文热点首次进入 Lumen 数据流（之前只有 36氪 / IT之家，覆盖面窄）。
- 复用 Electron 主进程 Chromium 实现 JS 渲染型站点采集，零额外二进制下载。
- 抽象出 `json-api` 与 `browser` 两种新 adapter kind，可插拔扩展后续新源。
- 热度数值结构化入 `article.hot_score`，便于后续按热度排序/筛选（即便本次不消费）。
- 不破坏现有 RSS / HTML 适配器、不破坏现有 UI 与调度逻辑。
- 全程 fixture 测试，不发真实网络。

### 非目标（M23 不做）

- 不引入 Puppeteer / Playwright（避免额外 ~300MB 二进制下载）。
- 不抓评论 / 作者 / 关联文章（保持最小化字段）。
- 不做按热度排序的 UI（hot_score 落库但本期不显）。
- 不做反爬对抗（被风控就 disable / 接受空结果）。
- 不引入跨源话题聚合（沿用现有事件聚类）。

## 3. 架构决策

### 3.1 适配器 kind 扩展

`SourceConfig.kind` 从 `'rss' | 'html'` 扩展为 `'rss' | 'html' | 'json-api' | 'browser'`。`createCollector(cfg)` 在 `electron/main/collectors/factory.ts`（新增）按 kind 分派：

```ts
function createCollector(cfg: SourceConfig): Collector {
  switch (cfg.kind) {
    case 'rss': return createRssCollector(cfg);
    case 'html': return createHtmlCollector(cfg);
    case 'json-api': return createJsonApiCollector(cfg);
    case 'browser': return createBrowserCollector(cfg);
  }
}
```

`index.ts` 中 `runManualCrawl` 与自动 job 各一处替换为 `createCollector(cfg)`。`html` 适配器本期保留在工厂里但不入 `REAL_SOURCES`（避免歧义）。

### 3.2 为什么用 Electron BrowserWindow 做 headless

- 应用已带 Electron 31 + Chromium 运行时，零额外下载。
- 复用进程内 Chromium，规避 Puppeteer 的 browsers-install 网络问题。
- 单进程内 IPC + `webContents.executeJavaScript` 拉取结构化数据。

## 4. 数据模型

### 4.1 SourceConfig 扩展

```ts
type FieldKey = 'title' | 'url' | 'content' | 'hotScore' | 'description' | 'publishedAt';
type FieldsMap = Partial<Record<FieldKey, string>>;

interface JsonApiSourceConfig extends SourceConfig {
  kind: 'json-api';
  apiUrl: string;          // 必填
  fieldsMap: FieldsMap;    // 必填；title 与 url 必须在
  dataPath?: string;       // 选填；默认根为数组
  headers?: Record<string, string>;
}

interface BrowserSourceConfig extends SourceConfig {
  kind: 'browser';
  browserUrl: string;
  browserWaitSelector?: string;
  browserWaitMs?: number;          // 默认 4000
  browserExtractScript: string;    // 必填；返回 JSON.stringify(数组)
  fieldsMap: FieldsMap;
}
```

字段映射语法**只支持两层**：`<key>` 或 `<key>.<subkey>`，如 `title`、`data.url`、`info[0].word`。不实现完整 JSONPath。`hotScore` 取值后 `Number()`；非数 → null。

### 4.2 SourceArticle 扩展

```ts
interface SourceArticle {
  // ...既有 9 个字段
  hotScore?: number | null;   // 新增；nullable，旧 RSS 文章不填
}
```

### 4.3 数据库迁移 v10

`electron/main/db/migrate.ts` MIGRATION_10：

```ts
safeAlter(db, 'article', 'hot_score', 'INTEGER');
```

`safeAlter` 已存在（`electron/main/db/migrate.ts`），复用包装 `ALTER TABLE ADD COLUMN` 的幂等检查。schema_version 升到 `'10'`。

### 4.4 仓储层

`electron/main/db/articles.ts`（如已存在）：`saveArticle` 增 `hot_score` 列写入；`loadArticles` / `loadRecent` 增读取。其他消费者（如 `searchArticles`）无需改（不消费 hot_score）。

## 5. 适配器实现

### 5.1 json-api 适配器

```ts
type LoadJson = (url: string, headers?: Record<string,string>) => Promise<unknown>;
const defaultLoadJson: LoadJson = async (url, headers) =>
  (await axios.get(url, { headers, timeout: 15000 })).data;

export function createJsonApiCollector(
  cfg: JsonApiSourceConfig,
  loadJson: LoadJson = defaultLoadJson
): Collector {
  return {
    config: cfg,
    async collect() {
      if (!cfg.apiUrl) throw new Error('apiUrl required');
      if (!cfg.fieldsMap.title || !cfg.fieldsMap.url) throw new Error('fieldsMap.title and url required');
      const raw = await loadJson(cfg.apiUrl, cfg.headers);
      const arr = cfg.dataPath ? getByPath(raw, cfg.dataPath) : raw;
      if (!Array.isArray(arr)) return [];
      const out: SourceArticle[] = [];
      for (const item of arr) {
        const title = pluck(item, cfg.fieldsMap.title);
        const url = pluck(item, cfg.fieldsMap.url);
        if (!title || !url) continue;
        const hotRaw = cfg.fieldsMap.hotScore ? pluck(item, cfg.fieldsMap.hotScore) : undefined;
        const hot = hotRaw === undefined ? null : Number(hotRaw);
        out.push(normalizeArticle(cfg, {
          title: String(title),
          url: String(url),
          content: cfg.fieldsMap.description ? pluck(item, cfg.fieldsMap.description) : undefined,
          publishedAt: cfg.fieldsMap.publishedAt ? pluck(item, cfg.fieldsMap.publishedAt) : undefined,
          hotScore: hot !== null && Number.isFinite(hot) ? hot : null
        }));
      }
      return out;
    }
  };
}
```

`pluck` / `getByPath`：实现两层 + `[]` 标记。失败返回 `undefined`。

### 5.2 browser 适配器

```ts
type BrowserNavigate = (
  url: string,
  opts: { waitSel?: string; waitMs?: number; extractScript: string }
) => Promise<unknown>;

export function createBrowserCollector(
  cfg: BrowserSourceConfig,
  navigate: BrowserNavigate
): Collector {
  return {
    config: cfg,
    async collect() {
      if (!cfg.browserExtractScript) throw new Error('browserExtractScript required');
      try {
        const raw = await navigate(cfg.browserUrl, {
          waitSel: cfg.browserWaitSelector,
          waitMs: cfg.browserWaitMs,
          extractScript: cfg.browserExtractScript
        });
        if (!Array.isArray(raw)) return [];
        const out: SourceArticle[] = [];
        for (const item of raw) {
          const title = pluck(item, cfg.fieldsMap.title);
          const url = pluck(item, cfg.fieldsMap.url);
          if (!title || !url) continue;
          const hotRaw = cfg.fieldsMap.hotScore ? pluck(item, cfg.fieldsMap.hotScore) : undefined;
          const hot = hotRaw === undefined ? null : Number(hotRaw);
          out.push(normalizeArticle(cfg, {
            title: String(title),
            url: String(url),
            content: cfg.fieldsMap.description ? pluck(item, cfg.fieldsMap.description) : undefined,
            hotScore: hot !== null && Number.isFinite(hot) ? hot : null
          }));
        }
        return out;
      } catch (err) {
        console.warn('[browser]', cfg.id, 'failed:', err instanceof Error ? err.message : err);
        return [];
      }
    }
  };
}
```

### 5.3 BrowserWindow 单例（主进程内）

`electron/main/browser/headless.ts`（新增）：

```ts
let win: BrowserWindow | null = null;
async function getWin(): Promise<BrowserWindow> {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: false, sandbox: false, contextIsolation: true }
  });
  win.webContents.setUserAgent('Mozilla/5.0 ... Chrome/126 ...');
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
  return w.webContents.executeJavaScript(`(function(){${opts.extractScript}})()`);
};
```

主进程调度时把 `browserNavigate` 作为 `navigate` 参数注入 `createBrowserCollector(cfg, browserNavigate)`。

### 5.4 资源清理

`app.on('before-quit', () => { if (win && !win.isDestroyed()) win.destroy(); })` —— 在 `electron/main/index.ts` 注册一次。

## 6. REAL_SOURCES 新增

`electron/main/collectors/registry.ts` 追加 6 项（端点为本期"最佳猜测"，实际 endpoint 落地时可微调；fixture 测试用 stub 数据）。`url` 字段为 `SourceConfig` 必填占位（json-api 用 `apiUrl`，browser 用 `browserUrl`，`url` 留空字符串即可）：

```ts
{ id: 'weibo-hot',     name: '微博热搜',     lang: 'zh', kind: 'json-api', url: '', apiUrl: 'https://s.weibo.com/top/summary', headers: { 'Referer': 'https://s.weibo.com/' }, fieldsMap: { title: 'word', url: 'url', hotScore: 'num' } },
{ id: 'zhihu-hot',     name: '知乎热榜',     lang: 'zh', kind: 'json-api', url: '', apiUrl: 'https://api.zhihu.com/topstory/hot-lists/total?limit=50', fieldsMap: { title: 'target.title', url: 'target.url', hotScore: 'detail_text' } },
{ id: 'toutiao-hot',   name: '今日头条热榜', lang: 'zh', kind: 'json-api', url: '', apiUrl: 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', fieldsMap: { title: 'title', url: 'url', hotScore: 'hotValue' } },
{ id: 'baidu-hot',     name: '百度热搜',     lang: 'zh', kind: 'browser',  url: '', browserUrl: 'https://top.baidu.com/board?platform=pc-task', browserWaitSelector: '.category-wrap_iQLoo', browserExtractScript: '...return Array.from(document.querySelectorAll(".category-wrap_iQLoo")).map(...)', fieldsMap: { title: 'title', url: 'url', hotScore: 'score' } },
{ id: 'bilibili-hot',  name: 'B站热门',      lang: 'zh', kind: 'json-api', url: '', apiUrl: 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all', fieldsMap: { title: 'title', url: 'link', hotScore: 'stat.view' } },
{ id: 'douyin-hot',    name: '抖音热门',     lang: 'zh', kind: 'browser',  url: '', browserUrl: 'https://www.douyin.com/hot', browserWaitSelector: '.hot-list-item', browserExtractScript: '...', fieldsMap: { title: 'title', url: 'url', hotScore: 'score' } },
```

任一源 403 / 反复空结果时由用户自行在「采集策略」里 disable。

## 7. 失败处理

- **json-api** 抓取失败（4xx/5xx/timeout/parse 错）：返回 `[]`，console.warn 记录 source id + error message。`runCrawl` 已有 per-source 容错，summary `failedSources` 数组继续累加。
- **browser** 任何阶段失败（load / wait 超时 / extractScript 抛错）：返回 `[]`，同样 warn，不抛。
- 永不阻塞其他源。

## 8. 测试（fixture，全不发网络）

新增 3 个测试文件：

### 8.1 `tests/json-api.test.ts`

- 基础抽取（title/url/hotScore/content/description/publishedAt）
- dataPath 嵌套（`data.items[]`）
- 缺 apiUrl 抛错
- 缺 fieldsMap.title / url 抛错
- 字段取值 = undefined 时该源返回空
- JSON.parse 失败抛错
- headers 透传

### 8.2 `tests/browser-collector.test.ts`

- mock navigate 正常返回数组 → 字段映射 + normalize
- navigate 抛错 → 返回 `[]`，不抛
- navigate 返回非数组 → 返回 `[]`
- 多源共用 navigate（验证错误不污染下一源）

### 8.3 `tests/hot-score.test.ts`

- schema v10：hot_score 列存在
- saveArticle 写入 / 读取 hot_score 正确
- 旧 RSS 文章 hot_score 为 null（迁移兼容）

预期：新增 ~12 测试，总数 123 → ~135。

## 9. UI 改动

**无。** 新源自动出现在「采集策略」勾选列表（`settings:get` 已返回 `allSources`），自动调度与手动采集都会拉到。hot_score 本期落库但不显。

## 10. 调度改动

`electron/main/index.ts` 2 处替换：

```ts
// 原
const collectors = enabledCollectors(getDb(), REAL_SOURCES).map((cfg) => createRssCollector(cfg));
// 新
const collectors = enabledCollectors(getDb(), REAL_SOURCES).map((cfg) => createCollector(cfg));
```

`createCollector` 来自新文件 `electron/main/collectors/factory.ts`。

## 11. 完工标准（DoD）

- tsc clean
- 123 → ~135 测试全过
- `npm run build` 成功（dist-electron 体积增量 < 5KB）
- 至少 1 次手动 `runManualCrawl` 在 fixtures 模式下命中 6 源各 ≥ 1 条（自动调度同跑）
- `npm run capture:shots` 仍能产 8 张图（不影响）
- README：「特性」加中文热点一行；「看板使用」股票段后插入；路线图把"中文热点站"条目标记完成

## 12. 风险与缓解

- **Electron BrowserWindow 反爬**：很多中文站有 UA / Referer / Cookie 检测，已在 adapter 暴露 `headers`；browser 默认设常见 UA；被风控就 disable。
- **extractScript 易碎**：UI 改版即失效。M23 不做自愈；用户禁用 + 等修复。
- **运行时内存**：常驻一个隐藏 BrowserWindow，约 50–100MB。可接受（应用本身已占 200MB+）。
- **自动调度变慢**：6 新源若全开且 browser 走 2 个，1 轮可能多花 ~10s。可接受。