export interface GraphNode {
  id: string;
  name: string;
  type: string;
  count: number;
  kind?: 'entity' | 'event';
  occurredAt?: string;
}

export interface GraphLink {
  source: string;
  target: string;
  weight: number;
}

export interface GraphView {
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface GraphQueryOptions {
  topN?: number;
  includeEvents?: boolean;
  eventLimit?: number;
}