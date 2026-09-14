import { ipcMain } from 'electron';
import type { EngineStatus, IpcResponse } from '../../../shared/contracts.js';
import type { TrendsResult } from '../../../shared/trend.js';
import type { Insight } from '../../../shared/insight.js';
import type { SourceArticle } from '../../../shared/models.js';
import type { TimelineEvent } from '../../../shared/timeline.js';
import type { GraphView } from '../../../shared/graph-view.js';
import type { DashboardSnapshot } from '../../../shared/dashboard.js';
import type { CrawlSummary } from '../db/persistence.js';
import type { GraphBuildResult } from '../graph/build.js';

export interface IpcDeps {
  getStatus: () => EngineStatus;
  runDashboard?: () => Promise<IpcResponse<DashboardSnapshot>>;
  runManualCrawl?: () => Promise<IpcResponse<CrawlSummary>>;
  runGraphBuild?: () => Promise<IpcResponse<GraphBuildResult>>;
  runTopics?: () => Promise<IpcResponse<TrendsResult>>;
  runInsight?: () => Promise<IpcResponse<Insight>>;
  runInsightList?: (payload: unknown) => Promise<IpcResponse<Insight[]>>;
  runInsightWeekly?: () => Promise<IpcResponse<Insight>>;
  runSearch?: (payload: unknown) => Promise<IpcResponse<SourceArticle[]>>;
  runTimeline?: () => Promise<IpcResponse<TimelineEvent[]>>;
  runGraphQuery?: (payload: unknown) => Promise<IpcResponse<GraphView>>;
}

export function registerIpc(deps: IpcDeps): void {
  ipcMain.handle('engine:status', (): IpcResponse<EngineStatus> => ({
    ok: true,
    data: deps.getStatus()
  }));
  const attach = (channel: string, fn: () => Promise<unknown>): void => {
    ipcMain.handle(channel, () => fn());
  };
  if (deps.runDashboard) attach('dashboard:today', deps.runDashboard);
  if (deps.runManualCrawl) attach('collector:manualRun', deps.runManualCrawl);
  if (deps.runGraphBuild) attach('graph:build', deps.runGraphBuild);
  if (deps.runTopics) attach('topics:list', deps.runTopics);
  if (deps.runInsight) attach('insights:generate', deps.runInsight);
  if (deps.runInsightList) ipcMain.handle('insights:list', (_e, payload) => deps.runInsightList!(payload));
  if (deps.runInsightWeekly) attach('insights:weekly', deps.runInsightWeekly);
  if (deps.runTimeline) attach('timeline:replay', deps.runTimeline);
  if (deps.runSearch) ipcMain.handle('search:fulltext', (_e, payload) => deps.runSearch!(payload));
  if (deps.runGraphQuery) ipcMain.handle('graph:query', (_e, payload) => deps.runGraphQuery!(payload));
}