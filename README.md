# Lumen — World Trends

一个**纯客户端、无服务端的双语热点台**：持续抓取全球热点新闻，用**事件图谱**表达世界元素间的关系，用**趋势引擎**量化话题的变动，用 **AI 因果解读**讲清“世界为什么在变”，全部数据**本地缓存、可离线回看/检索**。

> 名字 *Lumen* 取意“光”，寓意照亮世界趋势。

---

## ✨ 特性

- **双语聚合**：内置五路 RSS（BBC World / The Guardian World / NYT World / 36氪 / IT之家），中英双语；界面支持一键中/英切换。
- **事件图谱**：实体抽取（词典 gazetteer）→ 共现关系 → 共享实体聚类成事件，落库为 entity / event / edge。
- **趋势引擎**：按时间桶计算话题热度序列、动量（涨/跌）、世界热点（国家维度）。
- **AI 因果解读**：对最热话题生成中文因果解读；provider 可插拔（火山方舟 ARK / Mock）。
- **因果链**：输入任意实体，把其相关事件按时间串成链路（共享实体作锚点），可选 AI 逐段补因果断言 + 整体摘要。
- **全局叙事**：把跨实体的因果链按共享事件自动合并成更大的叙事（如“制裁 China → 油价 Oil → 通胀 US”），从局部链到世界叙事一张图；支持一键 **AI 整体摘要** 与 **反事实推演**（“如果首个事件没有发生会怎样”）。
- **解读中心体验**：AI 解读 / 因果链双栏布局；新手三步引导（采集→建图→生成）；一键导出 Markdown/JSON 快照。
- **桌面看板**：7 个 Tab（总览 / 时间线 / 图谱 / 解读 / 趋势 / 世界 / 检索）。
- **总览数据**：文章/实体/事件/关系边/今日新增指标卡 + 今日热点 + 调度状态（`dashboard:today`）。
- **AI 解读中心**：因果解读 + 周报生成 + 实体因果链，历史本地缓存。
- **时间线回放**：把聚类出的事件按时间倒序组织成可回看的时间线，附其关联文章。
- **事件图谱可视化**：以力导向图展示实体节点与共现边，可开/关事件节点（菱形）+ 事件→实体边，可拖拽、滚轮缩放。
- **自动调度**：冷启动即自行跑一轮「采集→图谱→趋势」，此后每 30 分钟自动刷新（`LUMEN_INTERVAL_MINUTES` 可调）。
- **双语界面**：中文/English 一键切换，选择本地记忆（`src/i18n/`，零新依赖）。
- **世界热力地图**：世界 GeoJSON choropleth（110m），国家热度着色、可缩放拖动，点击区域联动国家详情/对比。
- **本地缓存**：SQLite 落盘（`sql.js`），采集/建图/解读后与退出前自动持久化，离线可回看/检索。
- **无服务端**：主进程 Node 完成采集/图谱/趋势/AI，渲染层仅展示；二者只走 Electron IPC，不监听任何端口。

## 架构

```
可视化层 (React + Vite + ECharts)          ← Electron IPC（非 HTTP）→
主进程 (Electron Main / Node/TS)
   ├─ 采集 collector (rss / html 适配器)
   ├─ 图谱 graph (entity/event/edge + 聚类)
   ├─ 趋势 trends (时间序列 / 动量 / 热力)
   ├─ 因果 causal (规则链构建 + 跨链合并 + AI 断言)
   ├─ 导出 export (快照 Markdown/JSON)
   └─ AI ai (ARK / Mock 可插拔 provider)
数据层: SQLite (sql.js)  →  %APPDATA%\lumen-world-trends\lumen.db
```

单向流水线：`采集 → 标准化去重 → 图谱入库 → 趋势 → 因果链/全局叙事 + AI 解读 → IPC → 展示`

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面壳 | Electron |
| 前端 | React + Vite + TypeScript |
| 图表 | ECharts |
| 采集 | axios / cheerio / rss-parser |
| 存储 | sql.js（SQLite WASM，零原生编译） |
| 测试 | vitest（全夹具，不发真实网络） |
| AI | OpenAI 兼容（火山方舟 ARK / Mock） |

## 环境要求

- Node.js ≥ 18（建议 20+）
- 本机 CMake 无关：依赖无原生编译，通常无需 VS 构建工具

## 安装与运行

```bash
# 1) 安装依赖
npm install

# 2) 开发模式（Vite + Electron，会弹桌面窗口）
npm run dev

# 3) 生产构建
npm run build

# 4) 运行测试
npm test
```

> 提示：国内网络下载 Electron 二进制如果不畅，可先设置镜像源：
> ```powershell
> $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> npm install
> ```

## 看板使用（开箱）

启动后顶部有 7 个 Tab（均读本地缓存，离线可用）：

- **总览**：指标卡（文章/实体/事件/边/今日新增）+ 今日热点 chips + 引擎与调度状态 + 操作按钮
  - `手动采集`：抓取当前配置的全部源（`collector:manualRun`）
  - `构建图谱`：对最新文章抽实体/聚类/建边（`graph:build`）
- **趋势**：top 话题热度折线（`topics:list`）
- **世界**：国家热点榜单 + 点击查看国家详情（关联话题/文章）+ 2-4 国热度对比折线（`countries:detail` / `countries:series`）
- **检索**：本地全文搜索已抓文章（`search:fulltext`）
- **时间线**：事件按时间倒序回放，含关联文章（`timeline:replay`）
- **图谱**：实体节点 + 共现边 + 可开关的事件节点（`graph:query`）
- **解读**：AI 因果解读 / 周报生成 + 历史记录（`insights:generate` / `insights:weekly` / `insights:list`）
  - **全局叙事**：自动合并跨实体链，点击查看整条叙事；可一键生成 **AI 摘要** 与 **反事实推演**（`causality:narratives` / `causality:summarize` / `causality:counterfactual`）
  - **因果链**：输入实体名（如 China / 关税）生成事件链，可开/关 AI 断言，历史可回看（`causality:generate` / `causality:list` / `causality:chain`）
  - **三步引导**：无数据时顶部出现新手指引，可直接「去采集 / 去建图」
  - **导出快照**：一键导出 Markdown/JSON 快照（趋势 + 解读 + 因果链 + 全局叙事，系统保存对话框）（`export:snapshot`）

## 启用真实 AI（火山方舟 ARK）

默认无 `ARK_API_KEY` 时走 **Mock**（离线兜底，返回占位解读/规则因果链）。配置真实 ARK：

```powershell
# PowerShell
$env:ARK_API_KEY = "<你的 ARK API Key>"
$env:ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"  # 可选
$env:ARK_MODEL = "ep-xxxxxxxx | doubao-seed-1-6-250615"        # 可选
npm run dev
```

```bash
# macOS / Linux
export ARK_API_KEY="<你的 ARK API Key>"
export ARK_MODEL="ep-xxxx"   # 可选
npm run dev
```

- 鉴权：`Authorization: Bearer <ARK_API_KEY>`
- 端点：`{ARK_BASE_URL}/chat/completions`
- 支持传入模型 id 或推理接入点 `ep-*`

## 命令与脚本

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发运行（Vite + Electron） |
| `npm run build` | 生产构建（renderer + electron main + 拷贝 preload） |
| `npm run build:main` | 仅构建 electron 主进程 |
| `npm test` | 运行全部 vitest 测试（夹具，不发网络） |
| `npx tsc -p tsconfig.json --noEmit` | 类型检查 |

开发辅助环境变量（非必须）：

- `LUMEN_SMOKE=1`：自动加载后打印引擎状态并退出（冒烟自检）
- `LUMEN_INTERVAL_MINUTES`：自动调度间隔（分钟，默认 30）
- `LUMEN_DEBUG=1`：打印渲染层 DOM/console 便于排查白屏

## 项目结构

```
lumen/
  electron/main/         # 主进程
    collectors/          # 采集适配器 (rss/html) + 源注册表
    extract/             # 实体词典 (gazetteer)
    graph/               # 聚类 / 关系 / 图谱仓储 / buildGraph
    trends/              # 趋势引擎 / 热力 / 实体时序
    causal/              # 因果链构建 (规则) + 跨链合并 (merge) + AI 断言 + 仓储
    export/              # 快照导出 (Markdown/JSON)
    world/               # 国家详情 / 多国对比（countries:*）
    ai/                  # provider(ARK/Mock) + 解读器
    dash/                # 总览汇总（dashboard:today）
    db/                  # sql.js 连接 / 迁移 / 持久化
    ipc/                 # IPC handlers
    index.ts             # 入口
  src/                   # 渲染层 (React)
    components/          # 总览 / 时间线 / 图谱 / 解读 / 趋势 / 世界 / 检索
    world/               # 世界地图 GeoJSON 归一化/数据
    i18n/                # 中/英字典 + Provider(hook)
    hooks/               # useInvoke / useEngineStatus
  resources/             # 世界 GeoJSON（110m，生成物）
  shared/                # 主/渲染共享类型与契约
  tests/                 # vitest 夹具测试
  docs/superpowers/      # specs + 里程碑计划 + 交付记录
```

## 测试

- 单元/集成测试全用 **fixture**（RSS/HTML 字符串、内存 SQLite），**不依赖真实网络**。
- `npm test` 覆盖：契约、数据层、采集适配（含中文 RSS）、图谱聚类/仓储、趋势引擎、总览汇总、国家详情/对比、i18n 字典、AI provider/解读（含周报）、insight 仓储、因果链（规则构建/AI 断言/仓储）、跨链合并/全局叙事、叙事 AI 摘要/反事实推演、快照导出（Markdown/JSON）、检索。
- 真实抓取/真实 ARK 由你在应用里点按钮触发，不在 CI 中验证（本机网络对 GitHub 等不稳）。

## 局限与路线图

- **中文热点站（微博/知乎等）**：依赖 JS 渲染 + 反爬，当前未接；下一步可用无头浏览器型采集器适配。
- **世界热力地图**：已实现 choropleth（110m 粒度）；大洲/更细行政区可换用 50m GeoJSON 重生成（`scripts/gen-world-geo.mjs`）。
- **实体识别**：当前为词典 + 句法匹配；可升级为本地 NLP 或交给 AI 做更细抽取与上下位关系。
- **图谱**：关系类型 v1 仅 `co-occurrence`；真正的因果/包含关系交给 AI 解读阶段。
- **因果链**：v1 基于共享实体的时间相邻锚点，AI 断言可选；v2 支持跨实体合并成全局叙事 + AI 摘要 + 反事实推演；下一步可做时序因果/影响量化。
- **导出快照**：v1 为 Markdown/JSON 全文导出；可扩展为图表 PNG、订阅式自动归档。
- **AI**：解读聚焦最热话题（≤400 字）；可按需扩展周报/月报样式与模型切换。

## IPC 契约一览

主/渲染经 `shared/contracts.ts` 统一定义渠道：`engine:status` `dashboard:today` `collector:manualRun` `graph:build` `topics:list` `insights:generate` `insights:list` `insights:weekly` `causality:list` `causality:generate` `causality:chain` `causality:narratives` `causality:summarize` `causality:counterfactual` `export:snapshot` `search:fulltext` `graph:query` `timeline:replay` `countries:detail` `countries:series`。

## 授权说明

本仓库专注“爬取公开新闻 → 结构化 → 洞察”的工程质量；请遵守各新闻源的使用条款与所在法律法规，控制抓取频率，尊重版权。