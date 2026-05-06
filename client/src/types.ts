export type GeneralizationLevel = "low" | "medium" | "high";

export type ModelProvider = "ollama" | "azure-openai";

export type ReviewStatus = "pending" | "approved" | "rejected" | "edited" | "needs_review";

export type KgNode = {
  id: string;
  name: string;
  label: string;
  properties: Record<string, string>;
  confidence: number;
  evidence: string[];
  status: ReviewStatus;
};

export type KgEdge = {
  id: string;
  source: string;
  target: string;
  label: string;
  properties: Record<string, string>;
  confidence: number;
  evidence: string[];
  status: ReviewStatus;
};

export type KgTriple = {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  subject_type: string;
  object_type: string;
  confidence: number;
  evidence: string;
  status: ReviewStatus;
};

export type SchemaSuggestion = {
  id: string;
  subject_type: string;
  predicate: string;
  object_type: string;
  confidence: number;
  evidence: string;
  status: ReviewStatus;
};

export type KgResult = {
  nodes: KgNode[];
  edges: KgEdge[];
  triples: KgTriple[];
  schema: SchemaSuggestion[];
  notes: string;
  generalizationLevel: GeneralizationLevel;
};
