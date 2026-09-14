export type InsightType = 'causal' | 'weekly';

export interface Insight {
  id: string;
  type: InsightType;
  title: string;
  content: string;
  generatedAt: string;
  model: string;
}
