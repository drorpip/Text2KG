import type { GeneralizationLevel, KgResult, ModelProvider, SchemaSuggestion } from "./types";

export type ApiLogEntry = {
  id: string;
  time: string;
  level: "info" | "error";
  message: string;
};

type LogSink = (entry: ApiLogEntry) => void;

export async function analyzeText(
  text: string,
  generalizationLevel: GeneralizationLevel,
  modelProvider: ModelProvider,
  schemaGuidance: SchemaSuggestion[],
  log?: LogSink
): Promise<KgResult> {
  const startedAt = performance.now();
  log?.(
    makeLog(
      "info",
      `POST /api/kg/analyze started (${text.length} chars, ${generalizationLevel}, ${modelProvider}, ${schemaGuidance.length} schema rows)`
    )
  );

  const response = await fetch("/api/kg/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      generalizationLevel,
      modelProvider,
      ...(schemaGuidance.length ? { schemaGuidance } : {})
    })
  });

  const payload = await response.json();
  const elapsedMs = Math.round(performance.now() - startedAt);

  if (!response.ok) {
    log?.(makeLog("error", `Analysis failed ${response.status} after ${elapsedMs}ms: ${payload.error ?? "unknown error"}`));
    throw new Error(payload.error ?? "KG analysis failed.");
  }

  log?.(
    makeLog(
      "info",
      `Analysis succeeded after ${elapsedMs}ms (${payload.triples?.length ?? 0} triples, ${payload.nodes?.length ?? 0} nodes)`
    )
  );

  return payload;
}

export async function exportGraphMl(kg: KgResult, approvedOnly: boolean, log?: LogSink): Promise<string> {
  const startedAt = performance.now();
  log?.(makeLog("info", `POST /api/kg/export/graphml started (${approvedOnly ? "approved only" : "reviewed graph"})`));

  const response = await fetch("/api/kg/export/graphml", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kg, approvedOnly })
  });

  const elapsedMs = Math.round(performance.now() - startedAt);

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: "GraphML export failed." }));
    log?.(makeLog("error", `GraphML export failed ${response.status} after ${elapsedMs}ms: ${payload.error}`));
    throw new Error(payload.error ?? "GraphML export failed.");
  }

  const graphml = await response.text();
  log?.(makeLog("info", `GraphML export succeeded after ${elapsedMs}ms (${graphml.length} chars)`));
  return graphml;
}

export function makeLog(level: ApiLogEntry["level"], message: string): ApiLogEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    time: new Date().toLocaleTimeString(),
    level,
    message
  };
}
