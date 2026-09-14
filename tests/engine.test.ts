import { describe, it, expect } from 'vitest';
import { getEngineStatus } from '../electron/main/engine.js';

describe('engine', () => {
  it('返回状态包含数据库路径与源列表', () => {
    const s = getEngineStatus(true, '/tmp/lumen.db', ['weibo', 'reuters']);
    expect(s.ready).toBe(true);
    expect(s.dbPath).toBe('/tmp/lumen.db');
    expect(s.sources).toEqual(['weibo', 'reuters']);
  });
});
