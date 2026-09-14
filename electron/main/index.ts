import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEngineStatus } from './engine.js';
import { registerIpc } from './ipc/register.js';

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
    win.webContents.once('did-finish-load', () => {
      console.log('LUMEN_SMOKE_OK');
      app.quit();
    });
  }

  const target =
    process.env.NODE_ENV === 'development'
      ? win.loadURL('http://localhost:5173')
      : win.loadFile(path.join(__dirname, '../dist/index.html'));
  void target;
}

void app.whenReady().then(() => {
  const dbPath = path.join(app.getPath('userData'), 'lumen.db');
  registerIpc(() => getEngineStatus(true, dbPath, []));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
