import type { BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const TABS: { id: string; name: string }[] = [
  { id: 'dashboard', name: 'dashboard' },
  { id: 'timeline', name: 'timeline' },
  { id: 'graph', name: 'graph' },
  { id: 'insights', name: 'insights' },
  { id: 'trends', name: 'trends' },
  { id: 'world', name: 'world' },
  { id: 'stocks', name: 'stocks' },
  { id: 'search', name: 'search' }
];

function resolveOutputDir(): string {
  if (process.env.LUMEN_CAPTURE_DIR) return process.env.LUMEN_CAPTURE_DIR;
  // dist-electron/main -> project root images/
  return path.join(__dirname, '..', 'images');
}

async function switchTab(win: BrowserWindow, index: number): Promise<void> {
  await win.webContents.executeJavaScript(
    `document.querySelectorAll('.nav-btn')[${index}]?.click() || document.querySelectorAll('button.nav-btn')[${index}]?.click()`,
    true
  );
  await sleep(2600);
}

export async function captureAllTabs(win: BrowserWindow, dir = resolveOutputDir()): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  for (let i = 0; i < TABS.length; i++) {
    const tab = TABS[i];
    await switchTab(win, i);
    const image = await win.webContents.capturePage();
    const file = path.join(dir, `${tab.name}.png`);
    await writeFile(file, image.toPNG());
    written.push(file);
    console.log('LUMEN_CAPTURE_SHOT', tab.name, file);
  }
  return written;
}
