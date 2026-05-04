import cors from "cors";
import express from "express";

type GraphNodeType = "concept" | "tool" | "entity" | "process" | "source" | "unknown";

type GraphNode = {
  id: string;
  label: string;
  type: GraphNodeType;
  description?: string;
  confidence?: number;
  source?: string;
};

type GraphEdge = {
  id: string;
  source: string;
  target: string;
  label: string;
  description?: string;
  confidence?: number;
};

type GraphPayload = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  notes?: string;
};

const app = express();
const port = Number(process.env.PORT ?? 5174);
const ollamaHost = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const ollamaModel = process.env.OLLAMA_MEDIA_TITLE_MODEL ?? "gemma4:e4b";
const timeoutMs = Number(process.env.OLLAMA_GENERATE_TIMEOUT_SEC ?? 180) * 1000;
let requestCounter = 0;

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  const requestId = `req-${Date.now().toString(36)}-${(++requestCounter).toString(36)}`;
  const startedAt = Date.now();
  res.locals.requestId = requestId;

  console.log(
    `[${new Date().toISOString()}] ${requestId} -> ${req.method} ${req.path} ${formatBodySummary(req.body)}`
  );

  res.on("finish", () => {
    console.log(
      `[${new Date().toISOString()}] ${requestId} <- ${res.statusCode} ${req.method} ${req.path} ${Date.now() - startedAt}ms`
    );
  });

  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ollamaHost, ollamaModel });
});

app.post("/api/graph/suggest", async (req, res) => {
  try {
    const { text, graph } = req.body as { text?: string; graph?: GraphPayload };
    const requestId = getRequestId(res);

    if (!text || !text.trim()) {
      res.status(400).json({ error: "Paste text before requesting graph suggestions." });
      return;
    }

    console.log(
      `[${new Date().toISOString()}] ${requestId} suggest textChars=${text.length} currentNodes=${graph?.nodes.length ?? 0} currentEdges=${graph?.edges.length ?? 0}`
    );

    const result = await askOllama(buildSuggestPrompt(text, graph), requestId);
    console.log(
      `[${new Date().toISOString()}] ${requestId} suggest result nodes=${result.nodes.length} edges=${result.edges.length}`
    );
    res.json(result);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ${getRequestId(res)} suggest error ${toErrorMessage(error)}`);
    res.status(502).json({ error: toErrorMessage(error) });
  }
});

app.post("/api/graph/expand", async (req, res) => {
  try {
    const { selection, graph } = req.body as { selection?: unknown; graph?: GraphPayload };
    const requestId = getRequestId(res);

    if (!graph) {
      res.status(400).json({ error: "A current graph is required for expansion." });
      return;
    }

    console.log(
      `[${new Date().toISOString()}] ${requestId} expand currentNodes=${graph.nodes.length} currentEdges=${graph.edges.length} selection=${summarizeValue(selection)}`
    );

    const result = await askOllama(buildExpandPrompt(selection, graph), requestId);
    console.log(
      `[${new Date().toISOString()}] ${requestId} expand result nodes=${result.nodes.length} edges=${result.edges.length}`
    );
    res.json(result);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ${getRequestId(res)} expand error ${toErrorMessage(error)}`);
    res.status(502).json({ error: toErrorMessage(error) });
  }
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Knowledge graph API listening on http://127.0.0.1:${port}`);
});

function buildSuggestPrompt(text: string, graph?: GraphPayload): string {
  return [
    "You propose exploratory knowledge graphs from pasted text.",
    "The graph is a hypothesis for a human to edit, not a final answer.",
    jsonContract(),
    "Use concise labels. Prefer 6-14 nodes and 6-18 relationships unless the text is tiny.",
    "Allowed node types: concept, tool, entity, process, source, unknown.",
    "Relationship labels should be short verbs such as uses, depends on, enables, contains, contrasts with, causes, supports.",
    "Avoid duplicate concepts already present in the current graph.",
    `Current graph JSON: ${JSON.stringify(graph ?? { nodes: [], edges: [] })}`,
    `Source text: ${text}`
  ].join("\n\n");
}

function buildExpandPrompt(selection: unknown, graph: GraphPayload): string {
  return [
    "You suggest expansions and alternative structures for an editable knowledge graph.",
    "The graph is a hypothesis for a human to edit, not a final answer.",
    jsonContract(),
    "Focus on missing concepts, useful bridge concepts, and relationship alternatives.",
    "Do not repeat existing node ids. Keep suggestions small and actionable.",
    `Selected context JSON: ${JSON.stringify(selection ?? null)}`,
    `Current graph JSON: ${JSON.stringify(graph)}`
  ].join("\n\n");
}

function jsonContract(): string {
  return `Return only valid JSON with this exact shape:
{
  "nodes": [
    {
      "id": "stable-kebab-case-id",
      "label": "Display label",
      "type": "concept|tool|entity|process|source|unknown",
      "description": "optional short description",
      "confidence": 0.7,
      "source": "optional evidence phrase"
    }
  ],
  "edges": [
    {
      "id": "stable-kebab-case-edge-id",
      "source": "source-node-id",
      "target": "target-node-id",
      "label": "uses",
      "description": "optional short description",
      "confidence": 0.7
    }
  ],
  "notes": "Brief assumptions and alternatives."
}`;
}

async function askOllama(prompt: string, requestId: string): Promise<GraphPayload> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  console.log(
    `[${new Date().toISOString()}] ${requestId} ollama -> model=${ollamaModel} host=${ollamaHost} promptChars=${prompt.length} timeoutMs=${timeoutMs}`
  );

  try {
    const response = await fetch(`${ollamaHost}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ollamaModel,
        prompt,
        stream: false,
        format: "json",
        options: {
          temperature: 0.25
        }
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as { response?: string };
    if (!body.response) {
      throw new Error("Ollama returned an empty response.");
    }

    console.log(
      `[${new Date().toISOString()}] ${requestId} ollama <- status=${response.status} elapsedMs=${Date.now() - startedAt} responseChars=${body.response.length} preview=${preview(body.response)}`
    );

    return normalizeGraphPayload(JSON.parse(body.response));
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Ollama request timed out after ${timeoutMs / 1000} seconds.`);
    }
    if (error instanceof SyntaxError) {
      throw new Error("Ollama returned invalid JSON. Try again or reduce the pasted text.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeGraphPayload(value: unknown): GraphPayload {
  if (!value || typeof value !== "object") {
    throw new Error("Ollama response was not a graph object.");
  }

  const raw = value as Partial<GraphPayload>;
  const nodes = Array.isArray(raw.nodes)
    ? raw.nodes.map(normalizeNode).filter((node): node is GraphNode => Boolean(node))
    : [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = Array.isArray(raw.edges)
    ? raw.edges.map(normalizeEdge).filter((edge): edge is GraphEdge => Boolean(edge && nodeIds.has(edge.source) && nodeIds.has(edge.target)))
    : [];

  return {
    nodes,
    edges,
    notes: typeof raw.notes === "string" ? raw.notes : ""
  };
}

function normalizeNode(node: unknown): GraphNode | null {
  if (!node || typeof node !== "object") {
    return null;
  }

  const raw = node as Partial<GraphNode>;
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  const id = stableId(typeof raw.id === "string" ? raw.id : label);
  if (!id || !label) {
    return null;
  }

  return {
    id,
    label,
    type: normalizeNodeType(raw.type),
    description: optionalString(raw.description),
    confidence: optionalConfidence(raw.confidence),
    source: optionalString(raw.source)
  };
}

function normalizeEdge(edge: unknown): GraphEdge | null {
  if (!edge || typeof edge !== "object") {
    return null;
  }

  const raw = edge as Partial<GraphEdge>;
  const source = stableId(raw.source ?? "");
  const target = stableId(raw.target ?? "");
  const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : "relates to";

  if (!source || !target || source === target) {
    return null;
  }

  return {
    id: stableId(raw.id ?? `${source}-${label}-${target}`),
    source,
    target,
    label,
    description: optionalString(raw.description),
    confidence: optionalConfidence(raw.confidence)
  };
}

function normalizeNodeType(type: unknown): GraphNodeType {
  const allowed: GraphNodeType[] = ["concept", "tool", "entity", "process", "source", "unknown"];
  return allowed.includes(type as GraphNodeType) ? (type as GraphNodeType) : "unknown";
}

function stableId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalConfidence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : undefined;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown server error.";
}

function getRequestId(res: express.Response): string {
  return typeof res.locals.requestId === "string" ? res.locals.requestId : "req-unknown";
}

function formatBodySummary(body: unknown): string {
  if (!body || typeof body !== "object") {
    return "";
  }

  const value = body as { text?: string; graph?: GraphPayload; selection?: unknown };
  const parts: string[] = [];
  if (typeof value.text === "string") {
    parts.push(`textChars=${value.text.length}`);
  }
  if (value.graph) {
    parts.push(`graph=${value.graph.nodes?.length ?? 0}n/${value.graph.edges?.length ?? 0}e`);
  }
  if (value.selection) {
    parts.push(`selection=${summarizeValue(value.selection)}`);
  }

  return parts.length ? `(${parts.join(" ")})` : "";
}

function summarizeValue(value: unknown): string {
  return preview(JSON.stringify(value ?? null));
}

function preview(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 180);
}
