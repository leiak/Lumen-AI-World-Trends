import type { TopTopic } from './dashboard.js';
import type { TimelineArticle } from './timeline.js';
import type { TrendPoint } from './trend.js';

export interface CountryDetail {
  name: string;
  count: number;
  topics: TopTopic[];
  articles: TimelineArticle[];
}

export interface CountrySeriesResult {
  series: { name: string; points: TrendPoint[] }[];
}