import { ipcMain } from 'electron';
import type { EngineStatus, IpcResponse } from '../../../shared/contracts.js';

export function registerIpc(getStatus: () => EngineStatus): void {
  ipcMain.handle('engine:status', (): IpcResponse<EngineStatus> => ({
    ok: true,
    data: getStatus()
  }));
}
