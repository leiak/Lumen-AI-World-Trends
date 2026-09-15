export interface CausalNode {
  eventId: string;
  title: string;
  occurredAt: string;
  articleCount: number;
}

export interface CausalLink {
  fromEventId: string;
  toEventId: string;
  anchor: string;
  kind: 'rule' | 'ai';
  assertion?: string;
  explanation?: string;
}

export interface CausalChain {
  id: string;
  rootEntity: string;
  entities?: string[];
  generatedAt: string;
  model: string;
  nodes: CausalNode[];
  links: CausalLink[];
  summary?: string;
}

export interface CausalGeneratePayload {
  name?: string;
  maxEvents?: number;
  useAi?: boolean;
}
