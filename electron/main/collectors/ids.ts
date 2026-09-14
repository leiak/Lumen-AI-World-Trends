import { createHash } from 'node:crypto';
import type { SourceArticle } from '../../../shared/models.js';

export function articleId(source: string, url: string, title: string): string {
  return createHash('sha1').update(`${source}|${url}|${title}`).digest('hex');
}

export function normalizeArticle(
  cfg: { id: string; lang: 'zh' | 'en' },
  part: { title: string; url: string; content?: string; publishedAt?: string }
): SourceArticle {
  const id = articleId(cfg.id, part.url, part.title);
  return {
    id,
    source: cfg.id,
    title: part.title,
    url: part.url,
    content: part.content,
    lang: cfg.lang,
    publishedAt: part.publishedAt ?? null,
    crawledAt: new Date().toISOString(),
    rawHash: id
  };
}
