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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Lumen',
    webPreferences: {
      preload: path.join(__dirname, 'preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.LUMEN_SMOKE === '1') {
    win.webContents.once('did-finish-load', async () => {
      try {
        const status = await win.webContents.executeJavaScript(
          'window.lumen ? window.lumen.getEngineStatus() : Promise.resolve(null)'
        );
        console.log('LUMEN_SMOKE_OK', JSON.stringify(status));
      } catch (err) {
        console.error('LUMEN_SMOKE_FAIL', String(err));
      } finally {
        app.quit();
      }
    });
  }

  const target =
    process.env.NODE_ENV === 'development'
      ? win.loadURL('http://localhost:5173')
      : win.loadFile(path.join(__dirname, '../dist/index.html'));
  void target;

  if (process.env.LUMEN_DEBUG === '1') {
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error('[renderer] did-fail-load', code, desc);
    });
    win.webContents.on('console-message', (payload) => {
      const e = payload as { message?: string };
      console.log('[renderer]', e.message ?? '');
    });
    const dumpDom = async () => {
      try {
        const info = await win.webContents.executeJavaScript(
          `JSON.stringify({
             body: document.body ? document.body.innerText.slice(0, 200) : null,
             hasLumen: typeof window.lumen,
             hasRoot: !!document.getElementById('root')
           })`
        );
        console.log('[renderer] DOM', info);
      } catch (e) {
        console.error('[renderer] eval fail', String(e));
      }
    };
    win.webContents.on('did-finish-load', () => {
      void dumpDom();
      setTimeout(() => void dumpDom(), 2000);
    });
  }
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



