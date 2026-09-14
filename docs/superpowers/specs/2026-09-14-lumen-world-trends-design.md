# Lumen World Trends — 设计文档 (Design Spec)

> 项目代号：Lumen（意为“光”，象征照亮世界趋势）
> 日期：2026-09-14
> 状态：已获方向确认，待用户审阅

## 1. 一句话定位
一个**纯客户端、无服务端**的双语桌面情报台：持续抓取全球热点新闻，用**事件图谱**表达世界元素间的关联，用 **AI 因果解读**讲清“世界为什么在变、往哪变”，全部数据**本地缓存可离线回看**。

## 2. 目标与非目标

### 目标
- 多源热点聚合（国内 + 国际，中英双语）。
- 事件结构化（实体识别、事件去重、关系抽取）→ 事件图谱。
- 趋势分析（热度时间序列、动量、话题聚类、话题漂移）。
- AI 因果解读（事件簇 → 因果链 / 周报 / 洞察）。
- 全部数据落本地磁盘，离线可回看、检索、回放。
- 桌面端单进程自包含，无任何监听端口的后台服务。

### 非目标（v1 范围外）
- 不做云端账号体系、多人协作、云端同步。
- 不做实时流（秒级）推送，以分钟级增量为主。
- 不做专业级舆情测量（情感分/权威指数仅做轻量基础版）。
- 不在 v1 引入本地 LLM 推理（仅预留可插拔接口，默认远程 API）。

## 3. 架构决策

### 3.1 纯客户端前提澄清（关键）
浏览器**渲染进程**直接 `fetch` 外部站点会受 **CORS 跨域 + 混合内容**双重限制，绝大多数热点站会拒绝。因此“无服务端”落地为：
- **Electron 主进程（Node.js）**：拥有完整网络能力，天然绕过 CORS，用 `axios`/`cheerio`/`rss-parser` 抓取解析。
- **渲染进程（React）**：只负责界面展示与交互。
- 二者经 **Electron IPC**（非 HTTP 端口）通信。
- 结论：整个应用**自包含**，不启动任何监听端口的进程。

### 3.2 选型
| 层 | 选型 | 理由 |
|---|---|---|
| 桌面壳 | **Electron** | 主进程 Node 写爬虫/解析最顺；自带 Chromium 可渲染微博/知乎等 JS 页面。不用 Tauri（Rust 处理中文站点繁琐）。 |
| 语言 | **TypeScript**（主 + 渲染全量） | 单一语言、类型安全、主/渲染可共享类型。 |
| 采集 | `axios` + `cheerio` + `rss-parser` | HTML 解析 + RSS 双通道。 |
| 调度 | `node-cron` | 本地定时增量抓取。 |
| 本地缓存 | `better-sqlite3` | 单文件同步 SQLite，零服务端、性能好。 |
| 图谱存储 | SQLite 表建模 nodes/edges | 避免 v1 引入 neo4j 服务端，符合“无服务端”。 |
| 中文分词 | `nodejieba` | 中文实体/关键词提取（Windows 有预编译）。 |
| AI | OpenAI 兼容 SDK（remote），抽象 `provider` 接口 | 默认火山方舟 ARK/OpenAI；预留本地 Ollama 适配器。 |
| 图表 | ECharts + 世界 GeoJSON | 趋势曲线、世界热力地图、关系图。 |
| 前端框架 | React + Vite + TypeScript | 组件生态成熟。 |
| 状态 | `zustand` | 轻量。 |

### 3.3 数据流（单向流水线）
```
[调度器] → [采集器] → 原始快照(SourceArticle)
        → [结构化器] → 实体/事件/关系(Entity, Event, Edge)
        → [图谱存储] (SQLite)
        → [趋势引擎] → 统计结果(TopicTrend, Cluster)
        → [AI 解读]  → 因果链/周报(CausalChain, Insight)
        → [IPC] → [渲染层展示]
```

### 3.4 分层与目录
```
lumen/
  electron/main/        # 主进程
    collectors/         # 采集器（每源一个，实现统一接口）
    parser/             # 结构化：实体/事件/关系抽取
    graph/              # 图谱存储与查询
    trends/             # 趋势引擎
    ai/                 # AI provider + 解读
    scheduler/          # node-cron 调度
    ipc/                # IPC handlers
  src/                  # 渲染进程 (React+Vite)
    components/ pages/ store/ hooks/
  shared/               # 主/渲染共享类型 (IPC contract, 数据模型)
  resources/            # 世界 GeoJSON、停用词表、词典
  data/                 # SQLite 数据库与缓存文件（运行期生成，gitignore）
```

## 4. 数据模型（SQLite 表）
- **SourceArticle**：`id, source, title, content, url, lang, published_at, crawled_at, raw_hash`
- **Entity**：`id, name, name_en, type(人/组织/国家/行业/话题/地点/事件), lang, meta`
- **Event**：`id, title, summary, source_articles(外键), occurred_at, severity, lang`
- **Edge**：`id, source_entity, target_entity, event_id, relation_type, weight, first_seen_at, last_seen_at`
- **TopicTrend**：`id, topic_key, lang, window_start, window_end, mention_count, momentum, articles_json`
- **Cluster**：`id, name, articles_json, generated_at`
- **CausalChain**：`id, cluster_id, chain_json, summary, model_used, generated_at`
- **Insight**：`id, type(weekly/monthly/event), title, content_md, timeframe, generated_at`
- **SourceState**：`id, source, last_cursor, last_crawled_at`（增量抓取游标）

## 5. IPC 契约（type 摘要）
| 通道 | 方向 | 载荷 |
|---|---|---|
| `dashboard:today` | 主→渲染 | 今日热点、趋势、事件数概览 |
| `topics:list` | req/resp | 分页话题趋势 |
| `graph:query` | req/resp | 按实体/时间返回 nodes/edges |
| `timeline:replay` | req/resp | 按窗口返回事件时间线 |
| `insights:generate` | req/resp(可取消) | 触发 AI 解读并流式返回 |
| `search:fulltext` | req/resp | 本地全文检索 |
| `collector:manualRun` | req/resp | 手动触发一轮采集 |

## 6. 错误处理与可靠性
- 采集器**逐源失败隔离**：单站失败不阻断整轮。
- 超时/重试：axios 超时 + 指数退避重试（上限 3 次）。
- 读写用事务，`better-sqlite3` 同步执行，单 WAL 写线程。
- AI 调用失败降级：保留上次结果，UI 提示“解读失败，可重试”。
- 应用退出前 flush 缓存、保存增量游标。
- 日志：主进程本地轮转日志文件（`data/logs/`）。

## 7. 测试策略
- 采集器：用 header 投递 **fixture HTML/RSS**，不依赖真实网络。
- 结构化：用双语小样本断言实体/关系抽取正确。
- 图谱/趋势/搜索：纯函数 + SQLite 内存库测试。
- AI provider：mock 返回，断言 prompt 组装与结果解析。
- IPC：e2e 用 `mock` 层验证请求/响应而非真实抓取。

## 8. 里程碑
- **M1 骨架**：Electron+React+Vite+TS+IPC+SQLite 空壳能启动。
- **M2 采集**：国内 3 源 + 国际 3 源落地，增量抓取。
- **M3 结构化**：实体/事件/关系抽取 → 图谱入库。
- **M4 趋势**：时间序列 + 动量 + 聚类 + 世界热力地图。
- **M5 AI 解读**：因果链 + 周报，可插拔 provider。
- **M6 看板**：时间线回放 + 本地全文检索 + 离线模式。

## 9. 风险与对策
- **反爬**：热点站可能封 IP → 控制频率、随机延迟、退避；优先 RSS/公开 API。
- **中文 NLP 质量**：nodejieba 词表有限 → 维护自定义词典 + 词典可热更新。
- **AI 依赖联网**：离线时采集/图谱/趋势仍可用，解读降级。
- **Electron 体积/内存**：小字体重、懒加载页面、生产剔除 devtools。
- **图谱规模**：定期聚合旧 edge，滚动清理过时期数据。

## 10. 已确认决策（用户拍板）
1. 核心：**事件图谱 + AI 因果解读**。
2. 双语（中/英）+ 国际事件。
3. **Tauri/Electron + 前端**，最终选 **Electron**。
4. 需要**本地缓存**，可离线回看。
5. **无服务端**：Electron 主进程 Node 采集，渲染层展示，走 IPC。
6. AI 解读走可插拔 provider，v1 默认远程 OpenAI 兼容 API（火山方舟 ARK/OpenAI）。
