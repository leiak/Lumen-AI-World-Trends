# M21 截图捕获模式 实现计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-KILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Lumen 看板新增"一键截图捕获模式"开发工具：跑一条 `npm run capture:shots` 即可让 Electron 自动遍历 8 个 Tab，给每个 Tab 截图保存到本地目录，给 README / 文档 / 发布稿提供 PNG 物料。生成的产物不入源码仓（`.gitignore` 屏蔽），工具本身入仓。

**Architecture:**
- 主进程新增 `electron/main/capture.ts`：`captureAllTabs(win, dir?)` 依次 `executeJavaScript('document.querySelectorAll('.nav-btn')[i]?.click()')` 切换 Tab、`sleep(2600ms)` 等图表/地图渲染完成、`webContents.capturePage()` 截图、`writeFile(<tab>.png)`。默认输出目录 `path.join(__dirname, '..', 'images')`（即 `dist-electron/main` 退一层到项目根 `images/`），可通过 `LUMEN_CAPTURE_DIR` 环境变量自定义。
- `electron/main/index.ts` 入口：在 `webContents.once('did-finish-load', ...)` 钩子上判断 `process.env.LUMEN_CAPTURE === '1'`，延迟 1500ms 调 `captureAllTabs(win)`，完成后 `app.quit()`（成功或失败都退出，避免卡住 CI）。
- `package.json` 新增脚本 `capture:shots`: `npm run build && cross-env LUMEN_CAPTURE=1 electron .`（先 build 出 `dist/` + `dist-electron/`，再启动 Electron 自动捕获）。
- 8 个 Tab 顺序固定：`dashboard / timeline / graph / insights / trends / world / stocks / search`，与 README 截图章节顺序一致。

**Tech Stack:** Electron `webContents.capturePage` + `executeJavaScript`、纯 Node `fs/promises`。零新依赖。

**Spec:** `docs/superpowers/specs/2026-09-14-lumen-world-trends-design.md`（§截图工具约定）。

## Global Constraints

- 零新 npm 依赖；只动 `package.json` 的 `scripts`。
- 捕获逻辑必须在主进程（Node），不允许渲染层写文件系统。
- 输出目录默认 `images/`，加入 `.gitignore`，**只入库工具、不入库产物**。
- 已入库的 8 张 PNG 走 `git rm --cached` 取消跟踪但保留本地文件。
- i18n / 新 IPC：无新增。
- 验证：`tsc` + `npm test` + `npm run build` + `npm run capture:shots`（仅本地手验，CI 不跑）。

---

### Task 1: 实现 capture 模块（WIP 已完成 ✅）

**Files:**
- Create: `electron/main/capture.ts`
- Modify: `electron/main/index.ts`
- Modify: `package.json`

- [x] Step 1 `capture.ts`：8 个 Tab 列表 + `switchTab(win, i)` + `captureAllTabs(win, dir?)`，默认输出 `images/`。
- [x] Step 2 `index.ts`：`LUMEN_CAPTURE=1` 时 `did-finish-load` 后跑捕获并 `app.quit()`。
- [x] Step 3 `package.json`：新增 `capture:shots` 脚本。

### Task 2: Plan 文档

**Files:** Create `docs/superpowers/plans/2026-09-14-lumen-m21-screenshots.md`

- [x] Step 4 写本文件。

### Task 3: .gitignore + 取消跟踪

**Files:** Modify `.gitignore`

- [x] Step 5 `.gitignore` 追加 `images/`。
- [x] Step 6 `git rm --cached images/*.png`（8 个文件）取消跟踪但本地文件保留。

### Task 4: README 文档

**Files:** Modify `README.md`

- [x] Step 7 「命令与脚本」表加 `npm run capture:shots` 一行。
- [x] Step 8 「环境变量」段加 `LUMEN_CAPTURE_DIR`。
- [x] Step 9 新增一节「开发工具：截图捕获」说明用途与默认输出目录、git 策略。

### Task 5: 验证

- [x] Step 10 `npx tsc -p tsconfig.json --noEmit` 通过。
- [x] Step 11 `npm test` 全绿。
- [x] Step 12 `npm run build` 通过。
- [x] Step 13 `npm run capture:shots` 本地跑一次，8 张 PNG 落盘。

### Task 6: 提交与推送

- [x] Step 14 `git add` 所有 M21 文件（含取消跟踪后的 `.gitignore` 与 `README.md`）。
- [x] Step 15 `git commit -m "feat: M21 screenshot capture mode"`。
- [x] Step 16 `git push origin main`。