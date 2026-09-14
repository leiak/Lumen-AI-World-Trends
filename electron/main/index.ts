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
