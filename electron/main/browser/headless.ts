import { BrowserWindow } from 'electron';
import type { BrowserNavigate } from '../collectors/browser.js';

let win: BrowserWindow | null = null;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

async function getWin(): Promise<BrowserWindow> {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      offscreen: false,
      sandbox: true,
      contextIsolation: true
    }
  });
  win.webContents.setUserAgent(UA);
  return win;
}

async function runOne(url: string, opts: { waitSel?: string; waitMs?: number; extractScript: string }): Promise<unknown> {
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
}

// Serialize calls so concurrent browser collectors don't race on the singleton window.
// runCollectors uses Promise.all, so without this mutex loadURL/executeJavaScript
// interleave against whichever page is currently loaded.
let chain: Promise<unknown> = Promise.resolve();

export const browserNavigate: BrowserNavigate = (url, opts) => {
  const next = chain.then(() => runOne(url, opts));
  chain = next.catch(() => undefined); // don't poison the chain on failure
  return next;
};

export function disposeHeadless(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}