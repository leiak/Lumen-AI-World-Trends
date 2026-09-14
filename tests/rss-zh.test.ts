import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRssCollector } from '../electron/main/collectors/rss.js';
import { REAL_SOURCES } from '../electron/main/collectors/registry.js';
import type { SourceConfig } from '../electron/main/collectors/types.js';

const fixture = () =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'rss-zh.xml'), 'utf8');

describe('中文 RSS 采集', () => {
  it('解析中文 item 为 lang=zh 的 SourceArticle', async () => {
    const cfg: SourceConfig = { id: 'zhsrc', name: '中文源', lang: 'zh', kind: 'rss', url: 'http://example.test/feed' };
    const c = createRssCollector(cfg, async () => fixture());
    const arts = await c.collect();
    expect(arts).toHaveLength(2);
    expect(arts[0].lang).toBe('zh');
    expect(arts[0].title).toBe('中国与欧盟举行新一轮经贸磋商');
    expect(arts[1].title).toBe('美国大选最新民调出炉');
    expect(arts[0].source).toBe('zhsrc');
  });

  it('REAL_SOURCES 含中文源且 lang=zh', () => {
    const zh = REAL_SOURCES.filter((s) => s.lang === 'zh');
    expect(zh.length).toBeGreaterThanOrEqual(1);
    expect(zh.every((s) => s.kind === 'rss')).toBe(true);
  });
});