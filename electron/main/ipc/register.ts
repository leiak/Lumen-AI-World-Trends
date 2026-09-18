import { ipcMain } from 'electron';
import type { EngineStatus, IpcResponse } from '../../../shared/contracts.js';
import type { TrendsResult } from '../../../shared/trend.js';
import type { Insight } from '../../../shared/insight.js';
import type { SourceArticle } from '../../../shared/models.js';
import type { TimelineEvent } from '../../../shared/timeline.js';
import type { GraphView } from '../../../shared/graph-view.js';
import type { DashboardSnapshot } from '../../../shared/dashboard.js';
import type { CountryDetail, CountrySeriesResult } from '../../../shared/world.js';
import type { WorldTimeline } from '../../../shared/world.js';
import type { CausalChain } from '../../../shared/causal.js';
import type { SettingsView } from '../../../shared/settings.js';
import type {
  StockAlert,
  StockGroup,
  StockHistoryResult,
  StocksAlertsView,
  StocksGroupsView,
  StocksView,
  StocksWatchView
} from '../../../shared/stocks.js';
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
  runCausalitySummarize?: (payload: unknown) => Promise<IpcResponse<CausalChain>>;
  runCausalityCounterfactual?: (payload: unknown) => Promise<IpcResponse<{ text: string; model: string }>>;
  runCountrySeries?: (payload: unknown) => Promise<IpcResponse<CountrySeriesResult>>;
  runWorldTimeline?: (payload: unknown) => Promise<IpcResponse<WorldTimeline>>;
  runExportSnapshot?: (payload: unknown) => Promise<IpcResponse<ExportResult>>;
  runSettingsGet?: () => Promise<IpcResponse<SettingsView>>;
  runSettingsUpdate?: (payload: unknown) => Promise<IpcResponse<SettingsView>>;
  runStocksList?: () => Promise<IpcResponse<StocksView>>;
  runStocksRefresh?: () => Promise<IpcResponse<StocksView>>;
  runStocksHistory?: (payload: unknown) => Promise<IpcResponse<StockHistoryResult>>;
  runStocksWatch?: () => Promise<IpcResponse<StocksWatchView>>;
  runStocksAdd?: (payload: unknown) => Promise<IpcResponse<StocksWatchView>>;
  runStocksRemove?: (payload: unknown) => Promise<IpcResponse<StocksWatchView>>;
  runStocksGroupsList?: () => Promise<IpcResponse<StocksGroupsView>>;
  runStocksGroupsCreate?: (payload: unknown) => Promise<IpcResponse<StockGroup>>;
  runStocksGroupsRename?: (payload: unknown) => Promise<IpcResponse<StocksGroupsView>>;
  runStocksGroupsRemove?: (payload: unknown) => Promise<IpcResponse<StocksGroupsView>>;
  runStocksGroupsSetWatch?: (payload: unknown) => Promise<IpcResponse<StocksWatchView>>;
  runStocksAlertsList?: (payload: unknown) => Promise<IpcResponse<StocksAlertsView>>;
  runStocksAlertsAdd?: (payload: unknown) => Promise<IpcResponse<StockAlert>>;
  runStocksAlertsRemove?: (payload: unknown) => Promise<IpcResponse<{ ok: true }>>;
  runStocksAlertsToggle?: (payload: unknown) => Promise<IpcResponse<StockAlert>>;
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
  if (deps.runCausalitySummarize) ipcMain.handle('causality:summarize', (_e, payload) => deps.runCausalitySummarize!(payload));
  if (deps.runCausalityCounterfactual) ipcMain.handle('causality:counterfactual', (_e, payload) => deps.runCausalityCounterfactual!(payload));
  if (deps.runCountrySeries) ipcMain.handle('countries:series', (_e, payload) => deps.runCountrySeries!(payload));
  if (deps.runWorldTimeline) ipcMain.handle('world:timeline', (_e, payload) => deps.runWorldTimeline!(payload));
  if (deps.runExportSnapshot) ipcMain.handle('export:snapshot', (_e, payload) => deps.runExportSnapshot!(payload));
  if (deps.runSettingsGet) ipcMain.handle('settings:get', () => deps.runSettingsGet!());
  if (deps.runSettingsUpdate) ipcMain.handle('settings:update', (_e, payload) => deps.runSettingsUpdate!(payload));
  if (deps.runStocksList) attach('stocks:list', deps.runStocksList);
  if (deps.runStocksRefresh) attach('stocks:refresh', deps.runStocksRefresh);
  if (deps.runStocksHistory) ipcMain.handle('stocks:history', (_e, payload) => deps.runStocksHistory!(payload));
  if (deps.runStocksWatch) attach('stocks:watch', deps.runStocksWatch);
  if (deps.runStocksAdd) ipcMain.handle('stocks:add', (_e, payload) => deps.runStocksAdd!(payload));
  if (deps.runStocksRemove) ipcMain.handle('stocks:remove', (_e, payload) => deps.runStocksRemove!(payload));
  if (deps.runStocksGroupsList) attach('stocks:groups:list', deps.runStocksGroupsList);
  if (deps.runStocksGroupsCreate) ipcMain.handle('stocks:groups:create', (_e, payload) => deps.runStocksGroupsCreate!(payload));
  if (deps.runStocksGroupsRename) ipcMain.handle('stocks:groups:rename', (_e, payload) => deps.runStocksGroupsRename!(payload));
  if (deps.runStocksGroupsRemove) ipcMain.handle('stocks:groups:remove', (_e, payload) => deps.runStocksGroupsRemove!(payload));
  if (deps.runStocksGroupsSetWatch) ipcMain.handle('stocks:groups:setWatch', (_e, payload) => deps.runStocksGroupsSetWatch!(payload));
  if (deps.runStocksAlertsList) ipcMain.handle('stocks:alerts:list', (_e, payload) => deps.runStocksAlertsList!(payload));
  if (deps.runStocksAlertsAdd) ipcMain.handle('stocks:alerts:add', (_e, payload) => deps.runStocksAlertsAdd!(payload));
  if (deps.runStocksAlertsRemove) ipcMain.handle('stocks:alerts:remove', (_e, payload) => deps.runStocksAlertsRemove!(payload));
  if (deps.runStocksAlertsToggle) ipcMain.handle('stocks:alerts:toggle', (_e, payload) => deps.runStocksAlertsToggle!(payload));
}



