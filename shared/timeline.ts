export interface TimelineArticle {
  id: string;
  title: string;
  url: string;
  source: string;
}

export interface TimelineEvent {
  id: string;
  title: string;
  occurredAt: string;
  articleCount: number;
  articles: TimelineArticle[];
}
