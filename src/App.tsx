import { Suspense, lazy, useState } from 'react';
import { I18nProvider, useI18n } from './i18n/I18n';
import DashboardTab from './components/DashboardTab';
import type { I18nKey } from './i18n/dict';

// P5：按 Tab 懒加载，避免 ECharts / React Flow 全部进入首屏主包。
const TimelineTab = lazy(() => import('./components/TimelineTab'));
const GraphTab = lazy(() => import('./components/GraphTab'));
const InsightsTab = lazy(() => import('./components/InsightsTab'));
const TrendsTab = lazy(() => import('./components/TrendsTab'));
const WorldTab = lazy(() => import('./components/WorldTab'));
const StocksTab = lazy(() => import('./components/StocksTab'));
const SearchTab = lazy(() => import('./components/SearchTab'));
const AgentTab = lazy(() => import('./components/AgentTab'));
const StockAgentTab = lazy(() => import('./components/StockAgentTab'));

type Tab =
  | 'dashboard'
  | 'timeline'
  | 'graph'
  | 'insights'
  | 'trends'
  | 'world'
  | 'stocks'
  | 'search'
  | 'agent'
  | 'stock-agent';

const TABS: { id: Tab; labelKey: I18nKey }[] = [
  { id: 'dashboard', labelKey: 'nav.dashboard' },
  { id: 'timeline', labelKey: 'nav.timeline' },
  { id: 'graph', labelKey: 'nav.graph' },
  { id: 'insights', labelKey: 'nav.insights' },
  { id: 'trends', labelKey: 'nav.trends' },
  { id: 'world', labelKey: 'nav.world' },
  { id: 'stocks', labelKey: 'nav.stocks' },
  { id: 'search', labelKey: 'nav.search' },
  { id: 'agent', labelKey: 'nav.agent' },
  { id: 'stock-agent', labelKey: 'nav.stockAgent' }
];

function Shell() {
  const { t, lang, setLang } = useI18n();
  const [tab, setTab] = useState<Tab>('dashboard');
  return (
    <main className="app">
      <header className="app-header">
        <h1 className="app-title">Lumen — World Trends</h1>
        <span className="app-sub">{t('app.subtitle')}</span>
        <button
          className="btn lang-btn"
          onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
          title={lang === 'zh' ? 'Switch to English' : '切换中文'}
        >
          {lang === 'zh' ? 'EN' : '中文'}
        </button>
      </header>
      <nav className="nav">
        {TABS.map((tabDef) => (
          <button
            key={tabDef.id}
            className={`nav-btn${tab === tabDef.id ? ' active' : ''}`}
            data-testid={`nav-${tabDef.id}`}
            onClick={() => setTab(tabDef.id)}
          >
            {t(tabDef.labelKey)}
          </button>
        ))}
      </nav>
      <Suspense fallback={<div className="tab-loading" data-testid="tab-loading">…</div>}>
        {tab === 'dashboard' && <DashboardTab />}
        {tab === 'timeline' && <TimelineTab />}
        {tab === 'graph' && <GraphTab />}
        {tab === 'insights' && <InsightsTab />}
        {tab === 'trends' && <TrendsTab />}
        {tab === 'world' && <WorldTab />}
        {tab === 'stocks' && <StocksTab />}
        {tab === 'search' && <SearchTab />}
        {tab === 'agent' && <AgentTab />}
        {tab === 'stock-agent' && <StockAgentTab />}
      </Suspense>
    </main>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <Shell />
    </I18nProvider>
  );
}
