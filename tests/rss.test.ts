import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRssCollector } from '../electron/main/collectors/rss.js';
import type { SourceConfig } from '../electron/main/collectors/types.js';

const fixture = () =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'rss.xml'), 'utf8');

describe('rss collector', () => {
  it('解析 item 为 SourceArticle', async () => {
    const cfg: SourceConfig = { id: 'bbc', name: 'BBC', lang: 'en', kind: 'rss', url: 'http://example.test/rss' };
    const c = createRssCollector(cfg, async () => fixture());
    const arts = await c.collect();
    expect(arts).toHaveLength(2);
    expect(arts[0].title).toBe('First Fixture Story');
    expect(arts[0].url).toBe('http://example.test/stories/1');
    expect(arts[0].source).toBe('bbc');
  });
});
