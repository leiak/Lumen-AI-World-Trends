import { normalizeArticle } from './ids.js';
import { pluck, numOrNull } from './jsonApi.js';
import type { BrowserSourceConfig, Collector } from './types.js';
import type { SourceArticle } from '../../../shared/models.js';

export type BrowserNavigate = (
  url: string,
  opts: { waitSel?: string; waitMs?: number; extractScript: string }
) => Promise<unknown>;

export function createBrowserCollector(
  config: BrowserSourceConfig,
  navigate: BrowserNavigate
): Collector {
  return {
    config,
    async collect(): Promise<SourceArticle[]> {
      if (!config.browserExtractScript) {
        throw new Error('browserExtractScript required');
      }
      try {
        const raw = await navigate(config.browserUrl, {
          waitSel: config.browserWaitSelector,
          waitMs: config.browserWaitMs,
          extractScript: config.browserExtractScript
        });
        if (!Array.isArray(raw)) return [];
        const out: SourceArticle[] = [];
        for (const item of raw) {
          const title = pluck(item, config.fieldsMap.title!);
          const url = pluck(item, config.fieldsMap.url!);
          if (!title || !url) continue;
          const article = normalizeArticle(config, {
            title: String(title),
            url: String(url),
            content: config.fieldsMap.content
              ? (pluck(item, config.fieldsMap.content) as string | undefined)
              : undefined,
            publishedAt: config.fieldsMap.publishedAt
              ? (pluck(item, config.fieldsMap.publishedAt) as string | undefined)
              : undefined
          });
          article.hotScore = numOrNull(
            config.fieldsMap.hotScore
              ? pluck(item, config.fieldsMap.hotScore)
              : undefined
          );
          out.push(article);
        }
        return out;
      } catch (err) {
        console.warn(
          '[browser]',
          config.id,
          'failed:',
          err instanceof Error ? err.message : err
        );
        return [];
      }
    }
  };
}