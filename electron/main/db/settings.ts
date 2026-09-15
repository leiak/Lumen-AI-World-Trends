import type { Database } from 'sql.js';
import type { CollectSettings } from '../../../shared/settings.js';
import type { SourceConfig } from '../collectors/types.js';

const KEY = 'collectSettings';

export const DEFAULT_SETTINGS: CollectSettings = {
  enabledSources: [],
  autoEnabled: true,
  intervalMinutes: 30
};

function readMeta(db: Database, key: string): string | null {
  const stmt = db.prepare('SELECT value FROM meta WHERE key = ?');
  stmt.bind([key]);
  let value: string | null = null;
  if (stmt.step()) value = (stmt.getAsObject() as { value: string }).value;
  stmt.free();
  return value;
}

function writeMeta(db: Database, key: string, value: string): void {
  const stmt = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  stmt.run([key, value]);
  stmt.free();
}

function sanitize(s: CollectSettings): CollectSettings {
  const minutes = Math.round(Number(s.intervalMinutes));
  return {
    enabledSources: Array.isArray(s.enabledSources)
      ? s.enabledSources.filter((x): x is string => typeof x === 'string')
      : [],
    autoEnabled: s.autoEnabled !== false,
    intervalMinutes: Number.isFinite(minutes) ? Math.min(720, Math.max(1, minutes)) : 30
  };
}

export function loadCollectSettings(
  db: Database,
  fallback: Partial<CollectSettings> = {}
): CollectSettings {
  const raw = readMeta(db, KEY);
  const base: CollectSettings = { ...DEFAULT_SETTINGS, ...fallback };
  if (!raw) return sanitize(base);
  try {
    const stored = JSON.parse(raw) as Partial<CollectSettings>;
    return sanitize({ ...base, ...stored });
  } catch {
    return sanitize(base);
  }
}

export function saveCollectSettings(
  db: Database,
  patch: Partial<CollectSettings>,
  knownIds: Set<string>
): CollectSettings {
  const current = loadCollectSettings(db);
  const next: CollectSettings = {
    enabledSources:
      patch.enabledSources === undefined
        ? current.enabledSources
        : patch.enabledSources.filter((id) => knownIds.has(id)),
    autoEnabled: patch.autoEnabled === undefined ? current.autoEnabled : patch.autoEnabled,
    intervalMinutes:
      patch.intervalMinutes === undefined ? current.intervalMinutes : patch.intervalMinutes
  };
  const clean = sanitize(next);
  writeMeta(db, KEY, JSON.stringify(clean));
  return clean;
}

/** enabledSources 空数组表示「全部启用」（未配置默认）。 */
export function enabledCollectors(db: Database, all: SourceConfig[]): SourceConfig[] {
  const { enabledSources } = loadCollectSettings(db);
  if (enabledSources.length === 0) return all;
  return all.filter((s) => enabledSources.includes(s.id));
}