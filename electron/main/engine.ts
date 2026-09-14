import type { EngineStatus } from '../../shared/contracts.js';

export function getEngineStatus(
  ready: boolean,
  dbPath: string,
  sources: string[]
): EngineStatus {
  return { ready, dbPath, sources };
}
