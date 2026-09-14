export interface SourceArticle {
  id: string;
  source: string;
  title: string;
  content?: string;
  url: string;
  lang: 'zh' | 'en';
  publishedAt: string | null;
  crawledAt: string;
  rawHash: string;
}
