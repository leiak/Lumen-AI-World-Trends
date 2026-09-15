import { ipcMain } from 'electron';
import type { EngineStatus, IpcResponse } from '../../../shared/contracts.js';
import type { TrendsResult } from '../../../shared/trend.js';
import type { Insight } from '../../../shared/insight.js';
import type { SourceArticle } from '../../../shared/models.js';
import type { TimelineEvent } from '../../../shared/timeline.js';
import type { GraphView } from '../../../shared/graph-view.js';
import type { DashboardSnapshot } from '../../../shared/dashboard.js';
import type { CountryDetail, CountrySeriesResult } from '../../../shared/world.js';
import type { CausalChain } from '../../../shared/causal.js';
import type { ExportResult } from '../../../shared/contracts.js';
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
  runCountryDetail?: (payload: unknown) => Promise<IpcResponse<CountryDetail | null>>;
  runCausalityList?: (payload: unknown) => Promise<IpcResponse<CausalChain[]>>;
  runCausalityGenerate?: (payload: unknown) => Promise<IpcResponse<CausalChain>>;
  runCausalityChain?: (payload: unknown) => Promise<IpcResponse<CausalChain | null>>;
  runCausalityNarratives?: (payload: unknown) => Promise<IpcResponse<CausalChain[]>>;
  runCountrySeries?: (payload: unknown) => Promise<IpcResponse<CountrySeriesResult>>;
  runExportSnapshot?: (payload: unknown) => Promise<IpcResponse<ExportResult>>;
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
  if (deps.runCountryDetail) ipcMain.handle('countries:detail', (_e, payload) => deps.runCountryDetail!(payload));
  if (deps.runCausalityList) ipcMain.handle('causality:list', (_e, payload) => deps.runCausalityList!(payload));
  if (deps.runCausalityGenerate) ipcMain.handle('causality:generate', (_e, payload) => deps.runCausalityGenerate!(payload));
  if (deps.runCausalityChain) ipcMain.handle('causality:chain', (_e, payload) => deps.runCausalityChain!(payload));
  if (deps.runCausalityNarratives) ipcMain.handle('causality:narratives', (_e, payload) => deps.runCausalityNarratives!(payload));
  if (deps.runCountrySeries) ipcMain.handle('countries:series', (_e, payload) => deps.runCountrySeries!(payload));
  if (deps.runExportSnapshot) ipcMain.handle('export:snapshot', (_e, payload) => deps.runExportSnapshot!(payload));
}

