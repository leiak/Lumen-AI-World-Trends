import { describe, it, expect } from 'vitest';
import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import { migrate } from '../electron/main/db/migrate.js';
import {
  loadCollectSettings,
  saveCollectSettings,
  enabledCollectors
} from '../electron/main/db/settings.js';
import type { SourceConfig } from '../electron/main/collectors/types.js';

async function freshDb(): Promise<Database> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  migrate(db);
  return db;
}

const KNOWN = new Set(['bbc-world', 'guardian-world', '36kr']);

const SOURCES: SourceConfig[] = [
  { id: 'bbc-world', name: 'BBC', lang: 'en', kind: 'rss', url: 'http://x/bbc' },
  { id: 'guardian-world', name: 'Guardian', lang: 'en', kind: 'rss', url: 'http://x/g' },
  { id: 'ithome', name: 'IT之家', lang: 'zh', kind: 'rss', url: 'http://x/it' }
];

describe('采集策略设置', () => {
  it('无记录时返回默认（全部启用、自动开、30 分钟，可带 fallback）', async () => {
    const db = await freshDb();
    expect(loadCollectSettings(db)).toEqual({ enabledSources: [], autoEnabled: true, intervalMinutes: 30 });
    expect(loadCollectSettings(db, { intervalMinutes: 5 }).intervalMinutes).toBe(5);
    db.close();
  });

  it('保存后持久化并可回读（round-trip）', async () => {
    const db = await freshDb();
    saveCollectSettings(db, { enabledSources: ['bbc-world'], autoEnabled: false, intervalMinutes: 60 }, KNOWN);
    const loaded = loadCollectSettings(db);
    expect(loaded.enabledSources).toEqual(['bbc-world']);
    expect(loaded.autoEnabled).toBe(false);
    expect(loaded.intervalMinutes).toBe(60);
    db.close();
  });

  it('合并且校验：未知源被过滤、间隔钳制到 1-720、非法 JSON 回退', async () => {
    const db = await freshDb();
    saveCollectSettings(db, { enabledSources: ['bbc-world', 'unknown-id'], intervalMinutes: 9999 }, KNOWN);
    const loaded = loadCollectSettings(db);
    expect(loaded.enabledSources).toEqual(['bbc-world']);
    expect(loaded.intervalMinutes).toBe(720);
    db.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('collectSettings', ':::not-json')`);
    expect(loadCollectSettings(db).intervalMinutes).toBe(30);
    db.close();
  });

  it('enabledCollectors 空数组=全部启用；配置后只返回选中的源', async () => {
    const db = await freshDb();
    expect(enabledCollectors(db, SOURCES).map((s) => s.id)).toEqual(['bbc-world', 'guardian-world', 'ithome']);
    saveCollectSettings(db, { enabledSources: ['bbc-world'] }, KNOWN);
    expect(enabledCollectors(db, SOURCES).map((s) => s.id)).toEqual(['bbc-world']);
    db.close();
  });
});
