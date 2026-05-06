import type { KgEdge, KgNode, KgResult, KgTriple, ReviewStatus } from "./types";

const validStatuses: ReviewStatus[] = ["pending", "approved", "rejected", "edited", "needs_review"];

export function parseGraphMlToKg(graphml: string): KgResult {
  const doc = new DOMParser().parseFromString(graphml, "application/xml");
  const parseError = doc.querySelector("parsererror");
  if (parseError) {
    throw new Error("The selected file is not valid XML.");
  }

  const graph = doc.querySelector("graph");
  if (!graph) {
    throw new Error("The selected file does not contain a GraphML graph.");
  }

  const keyNames = keyNameMap(doc);
  const graphNodes = Array.from(graph.querySelectorAll(":scope > node"));
  const graphEdges = Array.from(graph.querySelectorAll(":scope > edge"));
  const idByGraphMlNodeId = new Map<string, string>();

  const nodes: KgNode[] = graphNodes.map((element, index) => {
    const graphMlId = element.getAttribute("id") || `imported_node_${index + 1}`;
    const name = dataValue(element, keyNames, ["name", "label"]) || graphMlId;
    const label = dataValue(element, keyNames, ["label", "type"]) || "Entity";
    const id = uniqueId(stableNodeId(name), idByGraphMlNodeId);
    idByGraphMlNodeId.set(graphMlId, id);

    return {
      id,
      name,
      label,
      properties: {},
      confidence: parseConfidence(dataValue(element, keyNames, ["confidence"])),
      evidence: splitEvidence(dataValue(element, keyNames, ["evidence"])),
      status: parseStatus(dataValue(element, keyNames, ["status"]))
    };
  });

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges: KgEdge[] = [];
  const triples: KgTriple[] = [];

  for (const [index, element] of graphEdges.entries()) {
    const source = idByGraphMlNodeId.get(element.getAttribute("source") || "");
    const target = idByGraphMlNodeId.get(element.getAttribute("target") || "");
    if (!source || !target || source === target) {
      continue;
    }

    const sourceNode = nodeById.get(source);
    const targetNode = nodeById.get(target);
    if (!sourceNode || !targetNode) {
      continue;
    }

    const label = cleanPredicate(dataValue(element, keyNames, ["predicate", "label"]) || "related_to");
    const confidence = parseConfidence(dataValue(element, keyNames, ["confidence"]));
    const evidence = dataValue(element, keyNames, ["evidence"]);
    const status = parseStatus(dataValue(element, keyNames, ["status"]));
    const edgeId = stableId(element.getAttribute("id") || `edge-${source}-${label}-${target}-${index + 1}`);

    edges.push({
      id: uniqueEdgeId(edgeId, edges),
      source,
      target,
      label,
      properties: {},
      confidence,
      evidence: splitEvidence(evidence),
      status
    });

    triples.push({
      id: stableId(`triple-${sourceNode.name}-${label}-${targetNode.name}-${index + 1}`),
      subject: sourceNode.name,
      predicate: label,
      object: targetNode.name,
      subject_type: sourceNode.label || "Entity",
      object_type: targetNode.label || "Entity",
      confidence,
      evidence,
      status
    });
  }

  return {
    nodes,
    edges,
    triples,
    schema: [],
    notes: "Imported from GraphML. Review generated triples before export.",
    generalizationLevel: "medium"
  };
}

function keyNameMap(doc: Document): Map<string, string> {
  const keys = new Map<string, string>();
  for (const key of Array.from(doc.querySelectorAll("key"))) {
    const id = key.getAttribute("id");
    const name = key.getAttribute("attr.name");
    if (id && name) {
      keys.set(id, name);
    }
  }
  return keys;
}

function dataValue(element: Element, keyNames: Map<string, string>, names: string[]): string {
  for (const data of Array.from(element.querySelectorAll(":scope > data"))) {
    const key = data.getAttribute("key") || "";
    const normalizedKey = key.toLowerCase();
    const normalizedName = (keyNames.get(key) || "").toLowerCase();
    if (names.some((name) => normalizedKey === name || normalizedName === name)) {
      return (data.textContent || "").trim();
    }
  }
  return "";
}

function parseConfidence(value: string): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0.5;
}

function parseStatus(value: string): ReviewStatus {
  return validStatuses.includes(value as ReviewStatus) ? (value as ReviewStatus) : "needs_review";
}

function splitEvidence(value: string): string[] {
  return value
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

function cleanPredicate(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function stableNodeId(name: string): string {
  return `node_${stableId(name) || "entity"}`;
}

function stableId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
}

function uniqueId(baseId: string, existing: Map<string, string>): string {
  const used = new Set(existing.values());
  let candidate = baseId;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${baseId}_${index}`;
    index += 1;
  }
  return candidate;
}

function uniqueEdgeId(baseId: string, edges: KgEdge[]): string {
  const used = new Set(edges.map((edge) => edge.id));
  let candidate = baseId || "edge";
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${baseId}_${index}`;
    index += 1;
  }
  return candidate;
}
