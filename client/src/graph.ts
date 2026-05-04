import type { Edge, Node } from "reactflow";
import type { KnowledgeEdge, KnowledgeGraph, KnowledgeNode } from "./types";

export const emptyGraph: KnowledgeGraph = { nodes: [], edges: [], notes: "" };

const typeColors: Record<string, string> = {
  concept: "#2563eb",
  tool: "#059669",
  entity: "#9333ea",
  process: "#d97706",
  source: "#64748b",
  unknown: "#475569"
};

export function toFlowNodes(nodes: KnowledgeNode[]): Node[] {
  return nodes.map((node, index) => ({
    id: node.id,
    type: "default",
    position: {
      x: 160 + (index % 4) * 230,
      y: 100 + Math.floor(index / 4) * 150
    },
    data: {
      label: node.label
    },
    style: {
      border: `2px solid ${typeColors[node.type] ?? typeColors.unknown}`,
      borderRadius: 8,
      color: "#172033",
      fontSize: 13,
      minWidth: 150,
      maxWidth: 210,
      padding: 12
    }
  }));
}

export function toFlowEdges(edges: KnowledgeEdge[]): Edge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    animated: false,
    style: { stroke: "#526071", strokeWidth: 1.6 },
    labelStyle: { fill: "#243044", fontWeight: 600 },
    labelBgStyle: { fill: "#f7f9fb", fillOpacity: 0.92 }
  }));
}

export function mergeGraphs(current: KnowledgeGraph, incoming: KnowledgeGraph): KnowledgeGraph {
  const nodes = [...current.nodes];
  const edges = [...current.edges];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeIds = new Set(edges.map((edge) => edge.id));

  for (const node of incoming.nodes) {
    const duplicate = nodes.find((existing) => normalizeLabel(existing.label) === normalizeLabel(node.label));
    if (!nodeIds.has(node.id) && !duplicate) {
      nodes.push(node);
      nodeIds.add(node.id);
    }
  }

  for (const edge of incoming.edges) {
    const hasEndpoints = nodeIds.has(edge.source) && nodeIds.has(edge.target);
    const duplicate = edges.some(
      (existing) =>
        existing.source === edge.source &&
        existing.target === edge.target &&
        normalizeLabel(existing.label) === normalizeLabel(edge.label)
    );

    if (hasEndpoints && !edgeIds.has(edge.id) && !duplicate) {
      edges.push(edge);
      edgeIds.add(edge.id);
    }
  }

  return {
    nodes,
    edges,
    notes: incoming.notes || current.notes
  };
}

export function uniqueId(base: string, usedIds: Set<string>): string {
  const root = slugify(base) || "item";
  let candidate = root;
  let index = 2;

  while (usedIds.has(candidate)) {
    candidate = `${root}-${index}`;
    index += 1;
  }

  return candidate;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}
