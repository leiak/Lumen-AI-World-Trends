import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHtmlCollector } from '../electron/main/collectors/html.js';
import type { SourceConfig } from '../electron/main/collectors/types.js';

const fixture = () =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'page.html'), 'utf8');

describe('html collector', () => {
  it('按选择器解析 item 并解析相对 URL', async () => {
    const cfg: SourceConfig = {
      id: 'demo',
      name: 'Demo',
      lang: 'en',
      kind: 'html',
      url: 'http://example.test/',
      itemSelector: 'article.item',
      titleSelector: 'h2.t',
      linkSelector: 'a.l',
      contentSelector: 'p.c'
    };
    const c = createHtmlCollector(cfg, async () => fixture());
    const arts = await c.collect();
    expect(arts).toHaveLength(2);
    expect(arts[0].title).toBe('HTML Story Alpha');
    expect(arts[0].url).toBe('http://example.test/news/alpha');
    expect(arts[0].content).toContain('Alpha body');
  });

  it('缺少 itemSelector 时抛错', async () => {
    const cfg: SourceConfig = { id: 'demo', name: 'Demo', lang: 'en', kind: 'html', url: 'http://example.test/' };
    const c = createHtmlCollector(cfg, async () => fixture());
    await expect(c.collect()).rejects.toThrow('itemSelector required');
  });
});
