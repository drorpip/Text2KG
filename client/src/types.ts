export type GraphNodeType = "concept" | "tool" | "entity" | "process" | "source" | "unknown";

export type KnowledgeNode = {
  id: string;
  label: string;
  type: GraphNodeType;
  description?: string;
  confidence?: number;
  source?: string;
};

export type KnowledgeEdge = {
  id: string;
  source: string;
  target: string;
  label: string;
  description?: string;
  confidence?: number;
};

export type KnowledgeGraph = {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  notes?: string;
};

export type Suggestion = KnowledgeGraph & {
  createdAt: number;
};
