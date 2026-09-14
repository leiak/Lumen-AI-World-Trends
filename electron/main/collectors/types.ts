import type { SourceArticle } from '../../../shared/models.js';

export interface SourceConfig {
  id: string;
  name: string;
  lang: 'zh' | 'en';
  kind: 'rss' | 'html';
  url: string;
  itemSelector?: string;
  titleSelector?: string;
  linkSelector?: string;
  contentSelector?: string;
}

export interface Collector {
  readonly config: SourceConfig;
  collect(): Promise<SourceArticle[]>;
}
