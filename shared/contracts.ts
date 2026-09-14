export const ALL_CHANNELS = [
  'engine:status',
  'dashboard:today',
  'topics:list',
  'graph:query',
  'timeline:replay',
  'insights:generate',
  'search:fulltext',
  'collector:manualRun',
  'graph:build'
] as const;

export type Channel = (typeof ALL_CHANNELS)[number];

export interface EngineStatus {
  ready: boolean;
  dbPath: string;
  sources: string[];
}

export interface IpcRequest {
  channel: Channel;
  payload?: unknown;
}

export interface IpcResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export type IpcHandler = (payload: unknown) => IpcResponse<unknown>;
