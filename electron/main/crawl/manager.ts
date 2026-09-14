import type { SourceArticle } from '../../shared/models.js';
import type { Collector } from '../collectors/types.js';

export interface CrawlError {
  sourceId: string;
  message: string;
}

export interface CollectResult {
  articles: SourceArticle[];
  errors: CrawlError[];
}

export async function runCollectors(collectors: Collector[]): Promise<CollectResult> {
  const errors: CrawlError[] = [];
  const articles: SourceArticle[] = [];
  await Promise.all(
    collectors.map(async (c) => {
      try {
        articles.push(...(await c.collect()));
      } catch (err) {
        errors.push({
          sourceId: c.config.id,
          message: err instanceof Error ? err.message : String(err)
        });
      }
    })
  );
  return { articles, errors };
}

export function dedupById(articles: SourceArticle[]): SourceArticle[] {
  const seen = new Set<string>();
  const out: SourceArticle[] = [];
  for (const a of articles) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out;
}
