import { describe, it, expect } from 'vitest';
import { runCollectors, dedupById } from '../electron/main/crawl/manager.js';
import { createRssCollector } from '../electron/main/collectors/rss.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { SourceConfig } from '../electron/main/collectors/types.js';

const fixture = () =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'rss.xml'), 'utf8');

describe('crawl manager', () => {
  it('逐源采集并隔离失败源', async () => {
    const okCfg: SourceConfig = { id: 'bbc', name: 'BBC', lang: 'en', kind: 'rss', url: 'http://x/rss' };
    const failCfg: SourceConfig = { id: 'bad', name: 'Bad', lang: 'en', kind: 'rss', url: 'http://x/bad' };

    const collectors = [
      createRssCollector(okCfg, async () => fixture()),
      createRssCollector(failCfg, async () => {
        throw new Error('boom');
      })
    ];

    const { articles, errors } = await runCollectors(collectors);
    expect(articles).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0].sourceId).toBe('bad');
    expect(errors[0].message).toContain('boom');
  });

  it('dedupById 保留首次出现', () => {
    const a = { id: 'a', source: 's', title: 'x', url: 'u', lang: 'en' as const, publishedAt: null, crawledAt: '', rawHash: 'a' };
    const b = { ...a, id: 'b' };
    const result = dedupById([a, a, b, a]);
    expect(result.map((r) => r.id)).toEqual(['a', 'b']);
  });
});
