import type { TopTopic } from './dashboard.js';
import type { TimelineArticle } from './timeline.js';
import type { CountryHeat, TrendPoint } from './trend.js';

export interface CountryDetail {
  name: string;
  count: number;
  topics: TopTopic[];
  articles: TimelineArticle[];
}

export interface CountrySeriesResult {
  series: { name: string; points: TrendPoint[] }[];
}

export interface WorldTimelineEntry {
  date: string;
  countries: CountryHeat[];
}

export interface WorldTimeline {
  dates: string[];
  byDate: WorldTimelineEntry[];
}
