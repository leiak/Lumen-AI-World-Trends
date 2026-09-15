export const ALL_CHANNELS = [
  'engine:status',
  'dashboard:today',
  'topics:list',
  'graph:query',
  'countries:detail',
  'countries:series',
  'causality:list',
  'causality:generate',
  'causality:chain',
  'causality:narratives',
  'causality:summarize',
  'causality:counterfactual',
  'timeline:replay',
  'insights:generate',
  'insights:list',
  'insights:weekly',
  'search:fulltext',
  'collector:manualRun',
  'graph:build',
  'export:snapshot'
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

export interface ExportResult {
  saved: boolean;
  path?: string;
  error?: string;
}




