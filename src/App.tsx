import { useState } from 'react';
import { I18nProvider, useI18n } from './i18n/I18n';
import DashboardTab from './components/DashboardTab';
import TimelineTab from './components/TimelineTab';
import GraphTab from './components/GraphTab';
import InsightsTab from './components/InsightsTab';
import TrendsTab from './components/TrendsTab';
import WorldTab from './components/WorldTab';
import StocksTab from './components/StocksTab';
import SearchTab from './components/SearchTab';
import type { I18nKey } from './i18n/dict';

type Tab = 'dashboard' | 'timeline' | 'graph' | 'insights' | 'trends' | 'world' | 'stocks' | 'search';

const TABS: { id: Tab; labelKey: I18nKey }[] = [
  { id: 'dashboard', labelKey: 'nav.dashboard' },
  { id: 'timeline', labelKey: 'nav.timeline' },
  { id: 'graph', labelKey: 'nav.graph' },
  { id: 'insights', labelKey: 'nav.insights' },
  { id: 'trends', labelKey: 'nav.trends' },
  { id: 'world', labelKey: 'nav.world' },
  { id: 'stocks', labelKey: 'nav.stocks' },
  { id: 'search', labelKey: 'nav.search' }
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
            onClick={() => setTab(tabDef.id)}
          >
            {t(tabDef.labelKey)}
          </button>
        ))}
      </nav>
      {tab === 'dashboard' && <DashboardTab />}
      {tab === 'timeline' && <TimelineTab />}
      {tab === 'graph' && <GraphTab />}
      {tab === 'insights' && <InsightsTab />}
      {tab === 'trends' && <TrendsTab />}
      {tab === 'world' && <WorldTab />}
      {tab === 'stocks' && <StocksTab />}
      {tab === 'search' && <SearchTab />}
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
