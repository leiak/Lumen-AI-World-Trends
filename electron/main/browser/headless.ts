import { BrowserWindow } from 'electron';
import type { BrowserNavigate } from '../collectors/browser.js';

let win: BrowserWindow | null = null;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function getWin(): Promise<BrowserWindow> {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      offscreen: false,
      sandbox: false,
      contextIsolation: true
    }
  });
  win.webContents.setUserAgent(UA);
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
  return w.webContents.executeJavaScript(
    `(function(){${opts.extractScript}})()`
  );
};

export function disposeHeadless(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}