import { useState } from 'react';
import DashboardTab from './components/DashboardTab';
import TimelineTab from './components/TimelineTab';
import GraphTab from './components/GraphTab';
import TrendsTab from './components/TrendsTab';
import WorldTab from './components/WorldTab';
import SearchTab from './components/SearchTab';

type Tab = 'dashboard' | 'timeline' | 'graph' | 'trends' | 'world' | 'search';

const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: '总览' },
  { id: 'timeline', label: '时间线' },
  { id: 'graph', label: '图谱' },
  { id: 'trends', label: '趋势' },
  { id: 'world', label: '世界' },
  { id: 'search', label: '检索' }
];

export default function App() {
  const [tab, setTab] = useState<Tab>('dashboard');
  return (
    <main className="app">
      <header className="app-header">
        <h1 className="app-title">Lumen — World Trends</h1>
        <span className="app-sub">双语·事件图谱·趋势·AI 解读</span>
      </header>
      <nav className="nav">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`nav-btn${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {tab === 'dashboard' && <DashboardTab />}
      {tab === 'timeline' && <TimelineTab />}
      {tab === 'graph' && <GraphTab />}
      {tab === 'trends' && <TrendsTab />}
      {tab === 'world' && <WorldTab />}
      {tab === 'search' && <SearchTab />}
    </main>
  );
}
