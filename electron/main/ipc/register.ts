import { ipcMain } from 'electron';
import type { EngineStatus, IpcResponse } from '../../../shared/contracts.js';
import type { TrendsResult } from '../../../shared/trend.js';
import type { Insight } from '../../../shared/insight.js';
import type { SourceArticle } from '../../../shared/models.js';
import type { CrawlSummary } from '../db/persistence.js';
import type { GraphBuildResult } from '../graph/build.js';

export interface IpcDeps {
  getStatus: () => EngineStatus;
  runManualCrawl?: () => Promise<IpcResponse<CrawlSummary>>;
  runGraphBuild?: () => Promise<IpcResponse<GraphBuildResult>>;
  runTopics?: () => Promise<IpcResponse<TrendsResult>>;
  runInsight?: () => Promise<IpcResponse<Insight>>;
  runSearch?: (payload: unknown) => Promise<IpcResponse<SourceArticle[]>>;
}

export function registerIpc(deps: IpcDeps): void {
  ipcMain.handle('engine:status', (): IpcResponse<EngineStatus> => ({
    ok: true,
    data: deps.getStatus()
  }));
  if (deps.runManualCrawl) {
    ipcMain.handle('collector:manualRun', async () => deps.runManualCrawl!());
  }
  if (deps.runGraphBuild) {
    ipcMain.handle('graph:build', async () => deps.runGraphBuild!());
  }
  if (deps.runTopics) {
    ipcMain.handle('topics:list', async () => deps.runTopics!());
  }
  if (deps.runInsight) {
    ipcMain.handle('insights:generate', async () => deps.runInsight!());
  }
  if (deps.runSearch) {
    ipcMain.handle('search:fulltext', async (_e, payload) => deps.runSearch!(payload));
  }
}
