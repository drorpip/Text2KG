import type { KgResult, KgTriple, ReviewStatus } from "./types";

export const emptyKgResult: KgResult = {
  nodes: [],
  edges: [],
  triples: [],
  schema: [],
  notes: "",
  generalizationLevel: "medium"
};

export function confidenceLabel(confidence: number): "High confidence" | "Medium confidence" | "Low confidence" {
  if (confidence >= 0.8) {
    return "High confidence";
  }
  if (confidence >= 0.55) {
    return "Medium confidence";
  }
  return "Low confidence";
}

export function statusLabel(status: ReviewStatus): string {
  return status.replace("_", " ");
}

export function reviewedTriples(triples: KgTriple[]): KgTriple[] {
  return triples.filter((triple) => triple.status !== "rejected");
}

export function filenameFromText(text: string): string {
  const firstWords = text
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return firstWords ? `text2kg-${firstWords}.graphml` : "text2kg.graphml";
}
