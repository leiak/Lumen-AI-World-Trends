import { useEngineStatus } from './hooks/useEngineStatus';

export default function App() {
  const { status, error } = useEngineStatus();
  return (
    <main>
      <h1>Lumen — World Trends</h1>
      {error && <p style={{ color: 'red' }}>错误：{error}</p>}
      {status && (
        <pre>
          ready: {String(status.ready)}
          {'\n'}dbPath: {status.dbPath}
          {'\n'}sources: {status.sources.join(', ')}
        </pre>
      )}
    </main>
  );
}
