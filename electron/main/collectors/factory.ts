import { createRssCollector } from './rss.js';
import { createHtmlCollector } from './html.js';
import { createJsonApiCollector } from './jsonApi.js';
import { createBrowserCollector } from './browser.js';
import { browserNavigate } from '../browser/headless.js';
import type { Collector, SourceConfig } from './types.js';

export function createCollector(cfg: SourceConfig): Collector {
  switch (cfg.kind) {
    case 'rss':
      return createRssCollector(cfg);
    case 'html':
      return createHtmlCollector(cfg);
    case 'json-api':
      return createJsonApiCollector(cfg);
    case 'browser':
      return createBrowserCollector(cfg, browserNavigate);
  }
}
