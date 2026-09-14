import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEngineStatus } from './engine.js';
import { registerIpc } from './ipc/register.js';
import { openDatabase, saveDatabase } from './db/connection.js';
import { setDb, getDb } from './state.js';
import { runCrawl } from './db/persistence.js';
import { saveInsight, listInsights } from './db/insights.js';
import { createRssCollector } from './collectors/rss.js';
import { REAL_SOURCES } from './collectors/registry.js';
import {
  searchArticles,
  listEvents,
  queryGraph
} from './graph/repository.js';
import { buildGraphFromDb, defaultGazetteer } from './graph/build.js';
import { computeTrends } from './trends/engine.js';
import { interpretCausal, interpretWeekly } from './ai/interpreter.js';
import { createProvider } from './ai/provider.js';
import { startScheduler, resolveIntervalMs } from './scheduler.js'
import { loadDashboardSnapshot } from './dash/summary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let lastAutoRunAt: string | null = null;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    title: 'Lumen',
    backgroundColor: '#0f1419',
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

  const persist = (): void => {
    try {
      saveDatabase(getDb(), dbPath);
    } catch (err) {
      console.error('[lumen] persist failed', err);
    }
  };

  const intervalMs = resolveIntervalMs(process.env);

  const provider = createProvider(process.env);

  registerIpc({
    getStatus: () => getEngineStatus(ready, dbPath, REAL_SOURCES.map((s) => s.id)),
    runDashboard: async () => ({
      ok: true,
      data: loadDashboardSnapshot(getDb(), {
        intervalMinutes: Math.round(intervalMs / 60000),
        lastAutoRunAt
      })
    }),
    runManualCrawl: async () => {
      const collectors = REAL_SOURCES.map((cfg) => createRssCollector(cfg));
      const summary = await runCrawl(getDb(), collectors);
      persist();
      return { ok: true, data: summary };
    },
    runGraphBuild: async () => {
      const result = await buildGraphFromDb(getDb(), defaultGazetteer());
      persist();
      return { ok: true, data: result };
    },
    runTopics: async () => ({ ok: true, data: computeTrends(getDb()) }),
    runInsight: async () => {
      try {
        const insight = await interpretCausal(provider, computeTrends(getDb()));
        saveInsight(getDb(), insight);
        persist();
        return { ok: true, data: insight };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    runInsightList: async (payload) => {
      const limit =
        typeof payload === 'object' && payload
          ? Number((payload as { limit?: number }).limit) || 50
          : 50;
      return { ok: true, data: listInsights(getDb(), limit) };
    },
    runInsightWeekly: async () => {
      try {
        const insight = await interpretWeekly(provider, computeTrends(getDb()));
        saveInsight(getDb(), insight);
        persist();
        return { ok: true, data: insight };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    runSearch: async (payload) => {
      const q =
        typeof payload === 'object' && payload
          ? String((payload as { query?: string }).query ?? '')
          : '';
      return { ok: true, data: searchArticles(getDb(), q) };
    },
    runTimeline: async () => ({ ok: true, data: listEvents(getDb()) }),
    runGraphQuery: async (payload) => {
      const opts =
        typeof payload === 'object' && payload
          ? (payload as { topN?: number; includeEvents?: boolean; eventLimit?: number })
          : {};
      const topN = Number(opts.topN) || 20;
      const includeEvents = Boolean(opts.includeEvents);
      const eventLimit = Number(opts.eventLimit) || 10;
      return { ok: true, data: queryGraph(getDb(), { topN, includeEvents, eventLimit }) };
    }
  });

  startScheduler({
    job: async () => {
      lastAutoRunAt = new Date().toISOString();
      const db = getDb();
      const collectors = REAL_SOURCES.map((cfg) => createRssCollector(cfg));
      await runCrawl(db, collectors);
      await buildGraphFromDb(db, defaultGazetteer());
      computeTrends(db);
      persist();
    },
    intervalMs: resolveIntervalMs(process.env),
    onError: (e) => console.error('[lumen] auto job failed', e)
  });

  createWindow();
  app.on('before-quit', () => persist());
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
