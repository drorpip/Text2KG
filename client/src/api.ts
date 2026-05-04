import type { KnowledgeGraph } from "./types";

export type ApiLogEntry = {
  id: string;
  time: string;
  level: "info" | "error";
  message: string;
};

type LogSink = (entry: ApiLogEntry) => void;

export async function suggestGraph(text: string, graph: KnowledgeGraph, log?: LogSink): Promise<KnowledgeGraph> {
  return postGraph("/api/graph/suggest", { text, graph }, log);
}

export async function expandGraph(selection: unknown, graph: KnowledgeGraph, log?: LogSink): Promise<KnowledgeGraph> {
  return postGraph("/api/graph/expand", { selection, graph }, log);
}

async function postGraph(path: string, body: unknown, log?: LogSink): Promise<KnowledgeGraph> {
  const startedAt = performance.now();
  log?.(makeLog("info", `POST ${path} started (${summarizeBody(body)})`));

  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const payload = await response.json();
  const elapsedMs = Math.round(performance.now() - startedAt);

  if (!response.ok) {
    log?.(makeLog("error", `POST ${path} failed ${response.status} after ${elapsedMs}ms: ${payload.error ?? "unknown error"}`));
    throw new Error(payload.error ?? "Graph request failed.");
  }

  log?.(
    makeLog(
      "info",
      `POST ${path} succeeded after ${elapsedMs}ms (${payload.nodes?.length ?? 0} nodes, ${payload.edges?.length ?? 0} edges)`
    )
  );

  return payload;
}

export function makeLog(level: ApiLogEntry["level"], message: string): ApiLogEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    time: new Date().toLocaleTimeString(),
    level,
    message
  };
}

function summarizeBody(body: unknown): string {
  if (!body || typeof body !== "object") {
    return "empty";
  }

  const value = body as { text?: string; graph?: KnowledgeGraph; selection?: unknown };
  const parts: string[] = [];
  if (typeof value.text === "string") {
    parts.push(`${value.text.length} text chars`);
  }
  if (value.graph) {
    parts.push(`${value.graph.nodes.length} nodes/${value.graph.edges.length} edges`);
  }
  if (value.selection) {
    parts.push("selection included");
  }

  return parts.join(", ") || "graph request";
}
