export interface DashboardMetrics {
  articles: number;
  entities: number;
  events: number;
  edges: number;
  addedToday: number;
}

export interface TopTopic {
  name: string;
  count: number;
  rising: boolean;
}

export interface DashboardSnapshot {
  metrics: DashboardMetrics;
  topTopics: TopTopic[];
  generatedAt: string;
  lastAutoRunAt: string | null;
  autoIntervalMinutes: number;
  lastCrawlAt: string | null;
}