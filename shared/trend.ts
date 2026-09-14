export interface TrendPoint {
  bucketStart: string;
  count: number;
}

export interface TopicTrend {
  key: string;
  name: string;
  count: number;
  buckets: TrendPoint[];
  momentum: number;
  rising: boolean;
}

export interface CountryHeat {
  name: string;
  count: number;
}

export interface TrendsResult {
  trends: TopicTrend[];
  countries: CountryHeat[];
  generatedAt: string;
}
