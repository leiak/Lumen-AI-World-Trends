export interface GraphNode {
  id: string;
  name: string;
  type: string;
  count: number;
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
