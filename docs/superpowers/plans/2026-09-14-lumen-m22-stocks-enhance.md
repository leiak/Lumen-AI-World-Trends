# M22 股票增强 实现计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-KILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 M18–M21 已落地的「行情缓存 + 自选股 + K 线 + 叠加视图」从「看」升级到「看 + 管 + 警」，完成 4 件事：① **自选分组**（多组分仓管理）② **涨跌幅排序**（点列头切升降序）③ **财务指标栏**（PE/PB/市值/换手/振幅/量比）④ **价格预警**（阈值命中 → 系统通知 + 同日去重）。

**Architecture:**

1. **分组**：DB 新表 `stock_group(id, name, sort)` + `stock_watch` 加列 `group_id INTEGER REFERENCES stock_group(id) ON DELETE SET NULL`。启动时 `seedDefaultGroup()` 把现有自选股全归入 `默认` 组。新增 `electron/main/db/stocksGroups.ts`（listGroups/createGroup/renameGroup/removeGroup/setWatchGroup/seedDefaultGroup）。
2. **排序**：纯前端 `useState`，列头点击切 `sortBy/sortDir`，不动 IPC。
3. **财务指标**：`StockQuote` 接口加可选字段 `pe/pb/marketCap/turnoverPct/amplitudePct/volumeRatio`，`parseQuoteLine` 解析 `f[39]/f[43]/f[44]/f[45]/f[49]`（HK/US 字段缺失时落空 undefined，前端显示 '—'）。Mock provider 同步加这些字段。
4. **预警**：DB 新表 `stock_alert(id, symbol, kind, threshold, enabled, last_fired_at, created_at)`，纯函数 `scanAlerts(quotes, alerts)` 在 `refreshStockQuotes` 之后调用，命中则发 Electron `Notification` 并写 `last_fired_at` 实现同日去重。新增 `electron/main/db/stocksAlerts.ts`。

**Tech Stack:** Electron Notification API、sql.js（迁移）、React（UI）、vitest。零新 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-09-14-lumen-world-trends-design.md`（§股票 Tab）。

## Global Constraints

- 零新 npm 依赖；只新增/修改 `package.json` 的 scripts（如需要）。
- `MIGRATION_9` 加 ALTER TABLE 用 try/catch 包（sql.js 不支持 `ADD COLUMN IF NOT EXISTS`）。
- Notification API 需 `Notification.isSupported()` 守卫；不支持时仅写日志不抛错。
- 预警同日去重：`last_fired_at.slice(0, 10) === today` 且仍命中 → 不重复通知；价格回到阈值另一侧再触发才允许重发。
- i18n：中英文 key 集合一致（`tests/i18n.test.ts` 自动校验）。
- 测试：`tests/stocks-groups.test.ts` + `tests/stocks-alerts.test.ts` 用 `tests/db.test.ts` 已有的内存 SQLite fixture；`tests/stocks-provider.test.ts` 加财务指标解析用例。
- 验证：`tsc` + `npm test`（期望 ≥ 105 tests） + `npm run build` + `npm run capture:shots`。

---

### Task 1: MIGRATION_9 + DB 模块骨架

**Files:**
- Modify `electron/main/db/migrate.ts`：加 `MIGRATION_9`，每个 ALTER 用 try/catch 包（避免「duplicate column」）。
- Create `electron/main/db/stocksGroups.ts`：`listGroups/createGroup/renameGroup/removeGroup/setWatchGroup/seedDefaultGroup` + 类型。
- Create `electron/main/db/stocksAlerts.ts`：`listAlerts/addAlert/removeAlert/toggleAlert/scanAlerts(quotes, alerts, now=Date)` + 类型。
- Modify `electron/main/db/stocks.ts`：扩展 `saveQuotes/loadQuotes` 写入/读取财务指标列；`seedDefaultWatch` 接受可选 groupId。

- [x] Step 1.1 MIGRATION_9 设计：`stock_group` 表 + ALTER stock_watch 加 group_id + ALTER stock_quote 加 6 个财务列 + `stock_alert` 表 + index。
- [x] Step 1.2 `migrate.ts` 加 `safeAlter(db, sql)` 帮助函数。
- [x] Step 1.3 stocksGroups.ts + stocksAlerts.ts 骨架（先空函数占位）。

### Task 2: 财务指标 provider 解析（TDD）

**Files:**
- Modify `shared/stocks.ts`：扩展 `StockQuote` 加 6 个可选字段。
- Modify `electron/main/stocks/provider.ts`：扩展 `parseQuoteLine` 解析 `f[39]/f[43]/f[44]/f[45]/f[49]`；`MockStockProvider.fetchQuotes` 同步加测试字段。
- Modify `tests/stocks-provider.test.ts`：加「财务指标字段解析」「缺失字段兜底」2 个 case。

- [x] Step 2.1 写失败测试：财务指标解析。
- [x] Step 2.2 实现扩展 parseQuoteLine + Mock。
- [x] Step 2.3 单测转绿。

### Task 3: groups DB + IPC（TDD）

**Files:**
- Create `tests/stocks-groups.test.ts`：内存 DB + listGroups/createGroup/renameGroup/removeGroup/setWatchGroup/seedDefaultGroup 用例。
- Create `electron/main/db/stocksGroups.ts`：实现上述 6 个函数。
- Modify `electron/main/index.ts`：启动时 `seedDefaultGroup()`，加 `runStocksGroupsList/Create/Rename/Remove/SetWatch` 5 个 IPC handler。
- Modify `electron/main/ipc/register.ts`：5 个新 dep + handler 注册。
- Modify `shared/contracts.ts`：ALL_CHANNELS 加 5 个新 channel。

- [x] Step 3.1 失败测试：groups CRUD + 默认组 + 重命名同名冲突 + remove 把 watch 移回默认组。
- [x] Step 3.2 实现 stocksGroups.ts。
- [x] Step 3.3 IPC 接线（contract + register + index）。
- [x] Step 3.4 全测绿。

### Task 4: alerts DB + 扫描 + IPC（TDD）

**Files:**
- Create `tests/stocks-alerts.test.ts`：DB CRUD + 纯函数 scanAlerts（命中/未命中/同日去重/未启用/未识别 kind）用例。
- Create `electron/main/db/stocksAlerts.ts`：CRUD + `scanAlerts(quotes, alerts, now?)`。
- Modify `electron/main/index.ts`：启动时加载 alerts；`refreshStockQuotes` 之后调用 `scanAlerts` + Notification。
- Modify `electron/main/ipc/register.ts`：4 个新 dep + handler。
- Modify `shared/contracts.ts`：ALL_CHANNELS 加 4 个新 channel。

- [x] Step 4.1 失败测试：scanAlerts 纯函数（price_above/price_below/pct_above/pct_below/同日去重/未启用）。
- [x] Step 4.2 实现 stocksAlerts.ts。
- [x] Step 4.3 IPC 接线。
- [x] Step 4.4 Notification 触发：guard `Notification.isSupported()`，失败 fallback console.log；写 last_fired_at。

### Task 5: StocksTab UI

**Files:**
- Modify `src/components/StocksTab.tsx`：分组 chips（下拉新建/重命名/删除）+ 列头点击排序 + 财务指标列 + 预警铃铛按钮 + 模态框。
- Modify `src/styles.css`：分组 chips + 预警模态框样式。
- Modify `src/i18n/dict.ts`：新增 zh + en 字符串（`stocks.group.*` `stocks.sort.*` `stocks.fin.*` `stocks.alert.*`）。

- [x] Step 5.1 i18n 先加新 key（中英）。
- [x] Step 5.2 分组 chips + 下拉新建/重命名/删除（IPC 5 个）。
- [x] Step 5.3 列头点击切 sortBy + sortDir。
- [x] Step 5.4 财务指标列（默认折叠，点「更多指标」展开）。
- [x] Step 5.5 预警铃铛按钮 + 模态框（设阈值/启停/删除）。

### Task 6: 验证 + 文档 + 提交

- [x] Step 6.1 `npx tsc -p tsconfig.json --noEmit` 通过。
- [x] Step 6.2 `npm test` 全绿（≥ 105 tests）。
- [x] Step 6.3 `npm run build` 通过。
- [x] Step 6.4 `npm run capture:shots` 重新生成截图（股票 Tab 长高了，注意可视区）。
- [x] Step 6.5 README 「股票」段落加 features 介绍；路线图移除对应项。
- [x] Step 6.6 commit `feat: M22 stocks enhance` + push。