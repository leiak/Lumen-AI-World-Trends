import { app, BrowserWindow, dialog } from 'electron';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
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
import { countryDetail, countrySeries } from './world/detail.js';
import { buildCausalChain } from './causal/build.js';
import { interpretCausalChain } from './causal/interpret.js';
import { saveCausalChain, listCausalChains, getCausalChain } from './causal/repository.js';
import { buildMarkdownSnapshot, buildJsonSnapshot, type ExportSnapshotInput } from './export/snapshot.js';

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
    },
    runCountryDetail: async (payload) => {
      const name =
        typeof payload === 'object' && payload
          ? String((payload as { name?: string }).name ?? '')
          : '';
      return { ok: true, data: name ? countryDetail(getDb(), name) : null };
    },
    runCountrySeries: async (payload) => {
      const names =
        typeof payload === 'object' && payload
          ? Array.isArray((payload as { names?: unknown }).names)
            ? ((payload as { names?: unknown }).names as string[])
            : []
          : [];
      return { ok: true, data: countrySeries(getDb(), names) };
    },
    runCausalityList: async (payload) => {
      const limit =
        typeof payload === 'object' && payload
          ? Number((payload as { limit?: number }).limit) || 50
          : 50;
      return { ok: true, data: listCausalChains(getDb(), limit) };
    },
    runCausalityGenerate: async (payload) => {
      const p = (payload ?? {}) as { name?: string; maxEvents?: number; useAi?: boolean };
      const name = String(p.name ?? '').trim();
      if (!name) return { ok: false, error: 'missing entity name' };
      const maxEvents = Number(p.maxEvents) || 5;
      const useAi = p.useAi !== false;
      const rule = buildCausalChain(getDb(), name, { maxEvents });
      if (!rule) return { ok: false, error: `no causal chain for "${name}"` };
      let chain = rule;
      if (useAi) {
        try {
          chain = await interpretCausalChain(provider, rule);
        } catch (e) {
          console.warn('[lumen] causal AI failed, keep rule chain', e);
        }
      }
      saveCausalChain(getDb(), chain);
      persist();
      return { ok: true, data: chain };
    },
    runCausalityChain: async (payload) => {
      const id =
        typeof payload === 'object' && payload
          ? String((payload as { id?: string }).id ?? '')
          : '';
      return { ok: true, data: id ? getCausalChain(getDb(), id) : null };
    },
    runExportSnapshot: async (payload) => {
      const p = (payload ?? {}) as { format?: 'md' | 'json'; path?: string };
      const format = p.format === 'json' ? 'json' : 'md';
      const ext = format === 'json' ? 'json' : 'md';
      const stamp = new Date().toISOString().slice(0, 16).replace(/:|T/g, '-');
      const db = getDb();
      const input: ExportSnapshotInput = {
        generatedAt: new Date().toISOString(),
        insights: listInsights(db),
        chains: listCausalChains(db),
        trends: computeTrends(db)
      };
      const content = format === 'json' ? buildJsonSnapshot(input) : buildMarkdownSnapshot(input);
      try {
        let target = p.path;
        if (!target) {
          const win = BrowserWindow.getAllWindows()[0];
          const opts: Electron.SaveDialogOptions = {
            title: 'Lumen 导出快照',
            defaultPath: `lumen-snapshot-${stamp}.${ext}`,
            filters: format === 'json'
              ? [{ name: 'JSON', extensions: ['json'] }]
              : [{ name: 'Markdown', extensions: ['md'] }]
          };
          const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
          if (res.canceled || !res.filePath) return { ok: true, data: { saved: false } };
          target = res.filePath;
        }
        await writeFile(target, content, 'utf8');
        return { ok: true, data: { saved: true, path: target } };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
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



