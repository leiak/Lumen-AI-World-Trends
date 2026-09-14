# M1 Skeleton 实现计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 产出可启动的 Electron + React 空壳，打通主进程 Node 与渲染层的 IPC，并初始化本地 SQLite 缓存。

**Architecture:** Electron 主进程（TypeScript）负责引擎、渲染进程（React + Vite）负责展示，二者仅经 IPC（非 HTTP）通信。无任何监听端口进程。

**Tech Stack:** Electron, TypeScript, Vite, React, better-sqlite3, vitest

**Spec:** `docs/superpowers/specs/2026-09-14-lumen-world-trends-design.md`

## Global Constraints
- 主进程 + 渲染进程 + 共享类型均为 **TypeScript**。
- 无任何监听端口 / HTTP 服务进程；主/渲染只走 Electron IPC。
- SQLite 单文件落盘，路径 `data/lumen.db`（运行期生成，加入 `.gitignore`）。
- 测试框架 **vitest**，主进程测试只测纯函数/数据层，不启动真实 Electron 窗口。
- 环境可能无网：运行 `npm install` 需用户批准（见各任务提交说明）。
- 所有 `Type` / `IPC` 契约集中在 `shared/`，主/渲染双方共同依赖，禁止各自重复定义。

---

### Task 1: 项目脚手架

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `electron/main/index.ts`
- Create: `src/main.tsx`
- Create: `src/App.tsx`
- Create: `.gitignore`
- Create: `electron/vite.config.ts`（Electron 主进程打包配置）

**Interfaces:**
- Produces: 可 `npm run dev` 启动的 Electron 应用（空窗口标题 “Lumen”).

- [x] **Step 1: 初始化 package.json 与依赖脚本**

写入 `package.json`：
```json
{
  "name": "lumen-world-trends",
  "version": "0.1.0",
  "private": true,
  "main": "dist-electron/main/index.js",
  "type": "module",
  "scripts": {
    "dev": "concurrently -k \"npm:dev:renderer\" \"npm:dev:electron\"",
    "dev:renderer": "vite",
    "dev:electron": "wait-on tcp:5173 && cross-env NODE_ENV=development electron .",
    "build": "tsc -p tsconfig.json && vite build && vite build --config electron/vite.config.ts",
    "test": "vitest run"
  },
  "devDependencies": {
    "electron": "^31.0.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vitest": "^2.0.0",
    "concurrently": "^8.2.0",
    "wait-on": "^7.2.0",
    "cross-env": "^7.0.3"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "better-sqlite3": "^11.3.0"
  }
}
```

- [x] **Step 2: 创建 TS 与 Vite 配置**

写入 `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "types": ["vitest/globals", "node"]
  },
  "include": ["src", "shared", "electron", "tests"]
}
```

写入 `vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: { outDir: 'dist' }
});
```

写入 `index.html`（入口）:
```html
<!doctype html>
<html lang="zh-CN">
  <head><meta charset="UTF-8" /><title>Lumen</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

- [x] **Step 3: 创建 Electron 主进程最小入口**

写入 `electron/main/index.ts`:
```ts
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Lumen',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.NODE_ENV === 'development') {
    void win.loadURL('http://localhost:5173');
  } else {
    void win.loadFile(path.join(__dirname, '../../dist/index.html'));
  }
}

void app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

Note: preload 文件由 Task 4 创建，此处路径先占位，Task 4 完成前 `dev` 运行主进程会因缺 preload 报错——因此本任务结束的验证只确认**目录与配置存在**，真正可启动在 Task 4 达成。

- [x] **Step 4: 创建渲染进程最小入口与 App**

写入 `src/main.tsx`:
```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

const root = createRoot(document.getElementById('root')!);
root.render(<React.StrictMode><App /></React.StrictMode>);
```

写入 `src/App.tsx`:
```tsx
export default function App() {
  return <main><h1>Lumen — World Trends</h1></main>;
}
```

- [x] **Step 5: 创建 .gitignore 与 electron 主进程 vite 配置**

写入 `.gitignore`:
```
node_modules/
dist/
dist-electron/
data/
*.log
```

写入 `electron/vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';

export default defineConfig({
  build: {
    outDir: '../dist-electron',
    rollupOptions: {
      external: ['electron', ...builtinModules]
    },
    lib: { entry: 'electron/main/index.ts', formats: ['es'] }
  }
});
```

- [x] **Step 6: 安装依赖（需联网）**

Run: `npm install`
说明：`better-sqlite3` 为原生模块会触发 postinstall 编译。如环境无网，向用户申请一次网络批准后执行。

- [x] **Step 7: 运行测试，确认空跑通过**

Run: `npm test`
Expected: vitest 提示 “No test files found”，退出码可控（0 或有 0 个用例）。此步是为 Task 2 起的 TDD 打通测试命令。

- [x] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold electron + react + vite skeleton"
```

---

### Task 2: 共享 IPC 契约类型

**Files:**
- Create: `shared/contracts.ts`
- Create: `shared/data-model.ts`
- Create: `tests/contracts.test.ts`

**Interfaces:**
- Consumes: （无，首个共享契约）
- Produces:
  - `export type Channel = 'dashboard:today' | 'engine:status' | ...`
  - `export interface EngineStatus { ready: boolean; dbPath: string; sources: string[] }`
  - `export interface IpcRequest { channel: Channel; payload: unknown }`
  - `export interface IpcResponse<T> { ok: boolean; data?: T; error?: string }`
  - `type IpcHandler = (payload: unknown) => IpcResponse<unknown>`

**Files 说明:** `shared/` 同时被主进程（tsc 出 es）与渲染进程（vite esm）包含，TypeScript 编译期校验类型一致性。

- [x] **Step 1: 写失败测试（校验类型注册表覆盖）**

写入 `tests/contracts.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { ALL_CHANNELS, type Channel } from '../shared/contracts.js';

describe('IPC contract', () => {
  it('渠道表非空且唯一', () => {
    const set = new Set(ALL_CHANNELS);
    expect(set.size).toBe(ALL_CHANNELS.length);
    expect(ALL_CHANNELS.length).toBeGreaterThan(0);
  });

  it('含关键渠道', () => {
    expect(ALL_CHANNELS).toContain('engine:status');
    expect(ALL_CHANNELS).toContain('dashboard:today');
  });
});
```

- [x] **Step 2: 运行测试确认为失败**

Run: `npm test`
Expected: 报 “Cannot find module ... contracts.js” (文件不存在)。

- [x] **Step 3: 实现契约文件**

写入 `shared/contracts.ts`:
```ts
export const ALL_CHANNELS = [
  'engine:status',
  'dashboard:today',
  'topics:list',
  'graph:query',
  'timeline:replay',
  'insights:generate',
  'search:fulltext',
  'collector:manualRun'
] as const;

export type Channel = (typeof ALL_CHANNELS)[number];

export interface EngineStatus {
  ready: boolean;
  dbPath: string;
  sources: string[];
}

export interface IpcRequest {
  channel: Channel;
  payload?: unknown;
}

export interface IpcResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export type IpcHandler = (payload: unknown) => IpcResponse<unknown>;
```

- [x] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 2 passed。

- [x] **Step 5: Commit**

```bash
git add shared/contracts.ts tests/contracts.test.ts
git commit -m "feat: define shared ipc contract types"
```

---

### Task 3: 本地 SQLite 数据层

**Files:**
- Create: `electron/main/db/connection.ts`
- Create: `electron/main/db/migrate.ts`
- Create: `tests/db.test.ts`

**Interfaces:**
- Consumes: 无（独立数据层）
- Produces:
  - `openDatabase(dbPath: string): Database` — 打开/创建 SQLite 连接，PRAGMA WAL。
  - `migrate(db: Database): void` — 执行迁移创建表。
  - 初始迁移表: `source_state(id INTEGER PK, source TEXT UNIQUE, last_cursor TEXT, last_crawled_at TEXT)` 与 `meta(key TEXT PK, value TEXT)` 用于 schema_version。

**Files 说明:** `better-sqlite3` 原生模块，测试用 `:memory:`，运行期写 `data/lumen.db`。

- [x] **Step 1: 写失败测试**

写入 `tests/db.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../electron/main/db/migrate.js';

describe('database', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:');
    migrate(db);
  });

  it('迁移后存在 meta 与 source_state 表', () => {
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('meta');
    expect(names).toContain('source_state');
  });

  it('写入 schema_version', () => {
    const row = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe('1');
  });
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL (module not found)。

- [x] **Step 3: 实现连接与迁移**

写入 `electron/main/db/connection.ts`:
```ts
import Database from 'better-sqlite3';
import { migrate } from './migrate.js';

export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
```

写入 `electron/main/db/migrate.ts`:
```ts
import type Database from 'better-sqlite3';

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT UNIQUE NOT NULL,
  last_cursor TEXT,
  last_crawled_at TEXT
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');
`;

export function migrate(db: Database.Database): void {
  db.exec('BEGIN');
  try {
    db.exec(MIGRATION_1);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 2 passed。

- [x] **Step 5: Commit**

```bash
git add electron/main/db tests/db.test.ts
git commit -m "feat: local sqlite data layer"
```

---

### Task 4: IPC 桥接 + 引擎状态

**Files:**
- Create: `electron/main/engine.ts`
- Create: `electron/main/ipc/register.ts`
- Create: `electron/preload/index.cjs`
- Modify: `electron/main/index.ts`（调用 `registerIpc` 与引擎）
- Create: `tests/engine.test.ts`

**Interfaces:**
- Consumes: `EngineStatus`, `IpcResponse` 来自 `shared/contracts.ts`; `openDatabase` 来自 `electron/main/db/connection.ts`.
- Produces:
  - `getEngineStatus(ready: boolean, dbPath: string, sources: string[]): EngineStatus`
  - `registerIpc(getStatus: () => EngineStatus): void` — 在 `ipcMain.handle('engine:status', ...)` 注册，走 `contextBridge` 暴露 `window.lumen`.
  - `preload` 暴露 `window.lumen.getEngineStatus(): Promise<EngineStatus>` 与通用的 `window.lumen.invoke(channel) `.

**Files 说明:** 主进程侧用 `ipcMain.handle`，渲染侧用 `contextBridge.exposeInMainWorld`。测试只覆盖 `getEngineStatus` 纯函数。

- [x] **Step 1: 写失败测试**

写入 `tests/engine.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { getEngineStatus } from '../electron/main/engine.js';

describe('engine', () => {
  it('返回状态包含数据库路径与源列表', () => {
    const s = getEngineStatus(true, '/tmp/lumen.db', ['weibo', 'reuters']);
    expect(s.ready).toBe(true);
    expect(s.dbPath).toBe('/tmp/lumen.db');
    expect(s.sources).toEqual(['weibo', 'reuters']);
  });
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL (module not found)。

- [x] **Step 3: 实现引擎与 IPC 注册**

写入 `electron/main/engine.ts`:
```ts
import type { EngineStatus } from '../../shared/contracts.js';

export function getEngineStatus(
  ready: boolean,
  dbPath: string,
  sources: string[]
): EngineStatus {
  return { ready, dbPath, sources };
}
```

写入 `electron/main/ipc/register.ts`:
```ts
import { ipcMain } from 'electron';
import type { EngineStatus, IpcResponse } from '../../../shared/contracts.js';

export function registerIpc(getStatus: () => EngineStatus): void {
  ipcMain.handle('engine:status', (): IpcResponse<EngineStatus> => ({
    ok: true,
    data: getStatus()
  }));
}
```

写入 `electron/preload/index.cjs`:
```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lumen', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  getEngineStatus: () => ipcRenderer.invoke('engine:status')
});
```

- [x] **Step 4: 修改主进程入口接通引擎**

修改 `electron/main/index.ts`：在 `app.whenReady()` 内、`createWindow()` 之前加入：
```ts
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEngineStatus } from './engine.js';
import { registerIpc } from './ipc/register.js';

// ...
void app.whenReady().then(() => {
  registerIpc(() => getEngineStatus(true, path.join(app.getPath('userData'), 'lumen.db'), []));
  createWindow();
  // ... 其余保持不变
});
```

- [x] **Step 5: 运行测试确认通过**

Run: `npm test`
Expected: 全部通过。

- [x] **Step 6: 端到端冒烟（需显示窗口，人工确认）**

Run: `npm run dev`
Expected: 出现 Lumen 空窗口（标题 “Lumen”）。此步需图形环境，若 CI 无窗口可跳过。

- [x] **Step 7: Commit**

```bash
git add electron tests
git commit -m "feat: wire up ipc and engine status"
```

---

### Task 5: 渲染层展示引擎状态

**Files:**
- Modify: `src/App.tsx`
- Create: `src/hooks/useEngineStatus.ts`
- Create: `src/env.d.ts`

**Interfaces:**
- Consumes: `EngineStatus` 来自 `shared/contracts.ts`; `window.lumen`（preload 暴露）。
- Produces: `useEngineStatus(): { status?: EngineStatus; error?: string }`.

**Files 说明:** `env.d.ts` 为 `window.lumen` 声明全局类型。

- [x] **Step 1: 写全局类型声明**

写入 `src/env.d.ts`:
```ts
import type { EngineStatus } from '../shared/contracts';

declare global {
  interface Window {
    lumen: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      getEngineStatus: () => Promise<EngineStatus>;
    };
  }
}
export {};
```

- [x] **Step 2: 实现 hook**

写入 `src/hooks/useEngineStatus.ts`:
```ts
import { useEffect, useState } from 'react';
import type { EngineStatus } from '../../shared/contracts';

export function useEngineStatus(): {
  status?: EngineStatus;
  error?: string;
} {
  const [status, setStatus] = useState<EngineStatus>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    window.lumen
      .getEngineStatus()
      .then(setStatus)
      .catch((e: Error) => setError(e.message));
  }, []);

  return { status, error };
}
```

- [x] **Step 3: 修改 App 展示状态**

修改 `src/App.tsx`:
```tsx
import { useEngineStatus } from './hooks/useEngineStatus';

export default function App() {
  const { status, error } = useEngineStatus();
  return (
    <main>
      <h1>Lumen — World Trends</h1>
      {error && <p style={{ color: 'red' }}>错误：{error}</p>}
      {status && (
        <pre>
          ready: {String(status.ready)}
          {'\n'}dbPath: {status.dbPath}
          {'\n'}sources: {status.sources.join(', ')}
        </pre>
      )}
    </main>
  );
}
```

Note: 本任务为 UI 展示，无单独单元测试；由 Task 4 的 `npm run dev` 冒烟验证（App 显示引擎状态）。

- [x] **Step 4: 类型检查**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: 无错误。

- [x] **Step 5: Commit**

```bash
git add src
git commit -m "feat: render engine status in react shell"
```

---

## Self-Review 记录
- **Spec 覆盖**：M1 对应 spec 第 3 节（架构/选型）、第 5 节（IPC 契约骨架）、第 4 节（本地缓存初始化）。M2-M6 留待后续独立计划。
- **占位符扫描**：所有代码块均已给出实际内容，无 TBD/TODO。
- **类型一致性**：`EngineStatus`、`IpcResponse`、`EngineStatus` 字段在 Task 2/3/4/5 中签名一致；`shared/contracts.ts` 为唯一来源。
- **依赖顺序**：Task 4/5 依赖 Task 2 契约与 Task 3 数据层；Task 1 提供运行骨架。

## 交付检查
- M1 完成后应有：可 `npm run dev` 启动的空壳、`window.lumen` IPC 可用、本地 `lumen.db` 在建库路径生成。

---

## M1 交付记录（2026-09-14）
- Task 1 commit `8cd67da` · Task 2 `8f8886a` · Task 3 `ff6d184` · Task 4 `5033ccc` · Task 5 `8a9a5a3`
- 测试 `npm test`：5/5 通过（contract / db / engine）。
- `npm run build`：renderer（`dist/`）+ electron 主进程（`dist-electron/index.js`）+ preload 拷贝均成功。
- 端到端冒烟：`LUMEN_SMOKE_OK {"ok":true,"data":{"ready":true,"dbPath":"...userData\\lumen.db","sources":[]}}`。

## Rulings（裁定记录）
- **Ruling 1 — SQLite 库改 `sql.js`**：`better-sqlite3` 预编译下载持续 ECONNRESET（GitHub 源）且本机缺 VS C++ 工具链无法源码编译；改用纯 JS/WASM 的 `sql.js`，零原生编译、更易跨机运行。`sql.js` 需手动 `saveDatabase` 持久化、取行前先 `stmt.step()`（接口差异）。若误判，代价是后续需在数据层替换持久化实现。
- **Ruling 2 — Electron 主进程用 SSR 构建**：Vite 默认浏览器目标会把 `node:path/node:url` 打成空浏览器垫片导致构建失败；改 `build.ssr` 目标 node，产物扁平化为 `dist-electron/index.js`，并据此修正 `package.json#main` 与主进程相对路径。若误判，代价是打包分发需重新评估产物布局。
