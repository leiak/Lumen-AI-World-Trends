import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEngineStatus } from './engine.js';
import { registerIpc } from './ipc/register.js';
import { openDatabase } from './db/connection.js';
import { setDb, getDb } from './state.js';
import { runCrawl } from './db/persistence.js';
import { createRssCollector } from './collectors/rss.js';
import { REAL_SOURCES } from './collectors/registry.js';
import { searchArticles } from './graph/repository.js';
import { computeTrends } from './trends/engine.js';
import { interpretCausal } from './ai/interpreter.js';
import { createProvider } from './ai/provider.js';
import { buildGraphFromDb as buildGraph, defaultGazetteer } from './graph/build.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    title: 'Lumen',
    webPreferences: {
      preload: path.join(__dirname, 'preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.LUMEN_SMOKE === '1') {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const status = await win.webContents.executeJavaScript(
            'window.lumen ? window.lumen.getEngineStatus() : Promise.resolve(null)'
          );
          const nav = await win.webContents.executeJavaScript(
            'document.body ? document.body.innerText.slice(0, 200) : "?"'
          );
          console.log('LUMEN_SMOKE_OK', JSON.stringify(status), '| NAV', JSON.stringify(nav));
        } catch (err) {
          console.error('LUMEN_SMOKE_FAIL', String(err));
        } finally {
          app.quit();
        }
      }, 1200);
    });
  }

  const target =
    process.env.NODE_ENV === 'development'
      ? win.loadURL('http://localhost:5173')
      : win.loadFile(path.join(__dirname, '../dist/index.html'));
  void target;
}

void app.whenReady().then(async () => {
  const dbPath = path.join(app.getPath('userData'), 'lumen.db');
  let ready = true;
  try {
    setDb(await openDatabase(dbPath));
  } catch (err) {
    ready = false;
    console.error('[lumen] database init failed', err);
  }

  registerIpc({
    getStatus: () => getEngineStatus(ready, dbPath, REAL_SOURCES.map((s) => s.id)),
    runManualCrawl: async () => {
      const collectors = REAL_SOURCES.map((cfg) => createRssCollector(cfg));
      const summary = await runCrawl(getDb(), collectors);
      return { ok: true, data: summary };
    },
    runGraphBuild: async () => ({
      ok: true,
      data: await buildGraph(getDb(), defaultGazetteer())
    }),
    runTopics: async () => ({ ok: true, data: computeTrends(getDb()) }),
    runInsight: async () => ({
      ok: true,
      data: await interpretCausal(createProvider(process.env), computeTrends(getDb()))
    }),
    runSearch: async (payload) => {
      const q =
        typeof payload === 'object' && payload
          ? String((payload as { query?: string }).query ?? '')
          : '';
      return { ok: true, data: searchArticles(getDb(), q) };
    }
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});


