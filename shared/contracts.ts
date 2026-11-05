export const ALL_CHANNELS = [
  'engine:status',
  'dashboard:today',
  'topics:list',
  'graph:query',
  'countries:detail',
  'countries:series',
  'world:timeline',
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
  'export:snapshot',
  'stocks:list',
  'stocks:refresh',
  'stocks:history',
  'stocks:watch',
  'stocks:add',
  'stocks:remove',
  'stocks:groups:list',
  'stocks:groups:create',
  'stocks:groups:rename',
  'stocks:groups:remove',
  'stocks:groups:setWatch',
  'stocks:alerts:list',
  'stocks:alerts:add',
  'stocks:alerts:remove',
  'stocks:alerts:toggle',
  'articles:byHot',
  'agent:graph',
  'agent:run',
  'agent:resume',
  'agent:runs:resume',
  'agent:runs:resumeCheckpoint',
  'agent:cancel',
  'agent:runs:list',
  'agent:runs:get',
  'agent:runs:events',
  'agent:graphs:list',
  'agent:graphs:get',
  'agent:graphs:save',
  'agent:graphs:delete',
  'agent:graphs:restoreDefault',
  'agent:memory:list',
  'agent:memory:settle',
  'agent:prompts:get',
  'agent:prompts:save',
  'agent:stocks:facts:list',
  'agent:stocks:facts:import',
  'agent:stocks:facts:add',
  'agent:stocks:facts:syncMarket',
  'agent:stocks:sample'
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

export type HotWindow = '24h' | '7d' | '30d' | 'all';

export interface ArticlesByHotRequest {
  window?: HotWindow;
  limit?: number;
  countryEntity?: string;
}




