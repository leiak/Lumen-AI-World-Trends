import { useState } from 'react';
import DashboardTab from './components/DashboardTab';
import TrendsTab from './components/TrendsTab';
import WorldTab from './components/WorldTab';
import SearchTab from './components/SearchTab';

type Tab = 'dashboard' | 'trends' | 'world' | 'search';

const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: '总览' },
  { id: 'trends', label: '趋势' },
  { id: 'world', label: '世界' },
  { id: 'search', label: '检索' }
];

export default function App() {
  const [tab, setTab] = useState<Tab>('dashboard');
  return (
    <main style={{ fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif', padding: 16 }}>
      <h1>Lumen — World Trends</h1>
      <nav style={{ marginBottom: 16 }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              marginRight: 8,
              padding: '6px 16px',
              cursor: 'pointer',
              fontWeight: tab === t.id ? 700 : 400
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {tab === 'dashboard' && <DashboardTab />}
      {tab === 'trends' && <TrendsTab />}
      {tab === 'world' && <WorldTab />}
      {tab === 'search' && <SearchTab />}
    </main>
  );
}
