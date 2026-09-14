import { ipcMain } from 'electron';
import type { EngineStatus, IpcResponse } from '../../../shared/contracts.js';
import type { CrawlSummary } from '../db/persistence.js';

export interface IpcDeps {
  getStatus: () => EngineStatus;
  runManualCrawl?: () => Promise<IpcResponse<CrawlSummary>>;
}

export function registerIpc(deps: IpcDeps): void {
  ipcMain.handle('engine:status', (): IpcResponse<EngineStatus> => ({
    ok: true,
    data: deps.getStatus()
  }));
  if (deps.runManualCrawl) {
    ipcMain.handle('collector:manualRun', async () => deps.runManualCrawl!());
  }
}
