import cors from "cors";
import express from "express";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type GeneralizationLevel = "low" | "medium" | "high";
type ModelProvider = "ollama" | "azure-openai";
type ReviewStatus = "pending" | "approved" | "rejected" | "edited" | "needs_review";

type KgNode = {
  id: string;
  name: string;
  label: string;
  properties: Record<string, string>;
  confidence: number;
  evidence: string[];
  status: ReviewStatus;
};

type KgEdge = {
  id: string;
  source: string;
  target: string;
  label: string;
  properties: Record<string, string>;
  confidence: number;
  evidence: string[];
  status: ReviewStatus;
};

type KgTriple = {
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

type SchemaSuggestion = {
  id: string;
  subject_type: string;
  predicate: string;
  object_type: string;
  confidence: number;
  evidence: string;
  status: ReviewStatus;
};

type KgPayload = {
  nodes: KgNode[];
  edges: KgEdge[];
  triples: KgTriple[];
  schema: SchemaSuggestion[];
  notes: string;
  generalizationLevel: GeneralizationLevel;
};

type RawKgPayload = Partial<{
  nodes: unknown[];
  edges: unknown[];
  triples: unknown[];
  schema: unknown[];
  notes: unknown;
}>;

const app = express();
loadDotEnv();
const port = Number(process.env.PORT ?? 5174);
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const ollamaModel = process.env.OLLAMA_KG_MODEL ?? process.env.OLLAMA_MEDIA_TITLE_MODEL ?? "gemma4:e4b";
const azureOpenAiApiKey = process.env.OPENAI_AZURE_API_KEY;
const azureOpenAiEndpoint = process.env.OPENAI_AZURE_API_ENDPOINT;
const azureOpenAiDeployment = process.env.OPENAI_AZURE_GPT52_MODEL ?? process.env.OPENAI_AZURE_DEPLOYMENT ?? "gpt-5";
const azureOpenAiApiVersion =
  process.env.OPENAI_AZURE_API_VERSION ?? process.env.OPENAI_AZURE_GPT52_MODEL_VERSION ?? "2025-03-01-preview";
const timeoutMs = Number(process.env.OLLAMA_GENERATE_TIMEOUT_SEC ?? 180) * 1000;
const minMeaningfulTextChars = 80;
let requestCounter = 0;

app.use(cors());
app.use(express.json({ limit: "3mb" }));
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
  res.json({
    ok: true,
    providers: {
      ollama: { baseUrl: ollamaBaseUrl, model: ollamaModel },
      azureOpenAi: {
        configured: Boolean(azureOpenAiApiKey && azureOpenAiEndpoint),
        deployment: azureOpenAiDeployment,
        apiVersion: azureOpenAiApiVersion
      }
    },
    timeoutSec: timeoutMs / 1000
  });
});

app.post("/api/kg/analyze", async (req, res) => {
  try {
    const { text, generalizationLevel, modelProvider } = req.body as {
      text?: string;
      generalizationLevel?: GeneralizationLevel;
      modelProvider?: ModelProvider;
    };
    const sourceText = typeof text === "string" ? text.trim() : "";
    const level = normalizeGeneralizationLevel(generalizationLevel);
    const provider = normalizeModelProvider(modelProvider);
    const requestId = getRequestId(res);

    if (!sourceText) {
      res.status(400).json({ error: "Paste text before requesting KG suggestions." });
      return;
    }
    if (sourceText.length < minMeaningfulTextChars) {
      res.status(400).json({ error: "Paste a longer English text so the system can suggest meaningful triples." });
      return;
    }

    console.log(
      `[${new Date().toISOString()}] ${requestId} analyze textChars=${sourceText.length} generalization=${level} provider=${provider}`
    );

    const raw = await askModel(buildKgPrompt(sourceText, level), provider, requestId);
    const payload = normalizeKgPayload(raw, sourceText, level);
    console.log(
      `[${new Date().toISOString()}] ${requestId} analyze result triples=${payload.triples.length} nodes=${payload.nodes.length} edges=${payload.edges.length} schema=${payload.schema.length}`
    );
    res.json(payload);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ${getRequestId(res)} analyze error ${toErrorMessage(error)}`);
    res.status(502).json({ error: toErrorMessage(error) });
  }
});

app.post("/api/kg/export/graphml", (req, res) => {
  try {
    const { kg, approvedOnly } = req.body as { kg?: KgPayload; approvedOnly?: boolean };
    if (!kg || !Array.isArray(kg.triples)) {
      res.status(400).json({ error: "Reviewed KG data is required for GraphML export." });
      return;
    }

    const graphml = buildGraphMl(kg, Boolean(approvedOnly));
    res.type("application/graphml+xml").send(graphml);
  } catch (error) {
    res.status(400).json({ error: toErrorMessage(error) });
  }
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Text2KG API listening on http://127.0.0.1:${port}`);
});

function buildKgPrompt(text: string, level: GeneralizationLevel): string {
  return [
    "You are Text2KG, a knowledge graph understanding assistant.",
    "Your job is to suggest an initial Knowledge Graph from English text. Treat every output as a suggestion for human review, not a final truth.",
    "Prioritize precision over recall. Suggest fewer high-quality triples rather than many weak relationships.",
    "Return 5-12 strong triples unless the text clearly contains fewer. Avoid exhaustive extraction.",
    "Every triple must have a short evidence span copied exactly from the source text. Keep evidence under 180 characters. If a relationship is only implied, lower confidence and mark it needs_review.",
    "Do not include markdown, comments, ellipses, explanations, or text outside the JSON object.",
    `Generalization level: ${level}. Low means specific instance facts. Medium means include useful entity types. High means include schema suggestions without becoming generic like Thing -> relatedTo -> Thing.`,
    kgJsonContract(),
    `Source text:\n${text}`
  ].join("\n\n");
}

function kgJsonContract(): string {
  return `Return only valid JSON with this exact shape:
{
  "triples": [
    {
      "id": "triple_1",
      "subject": "OpenAI",
      "predicate": "developed",
      "object": "ChatGPT",
      "subject_type": "Organization",
      "object_type": "Product",
      "confidence": 0.92,
      "evidence": "OpenAI developed ChatGPT",
      "status": "pending"
    }
  ],
  "nodes": [
    {
      "id": "node_openai",
      "name": "OpenAI",
      "label": "Organization",
      "properties": {},
      "confidence": 0.92,
      "evidence": ["OpenAI developed ChatGPT"],
      "status": "pending"
    }
  ],
  "edges": [
    {
      "id": "edge_openai_developed_chatgpt",
      "source": "node_openai",
      "target": "node_chatgpt",
      "label": "developed",
      "properties": {},
      "confidence": 0.92,
      "evidence": ["OpenAI developed ChatGPT"],
      "status": "pending"
    }
  ],
  "schema": [
    {
      "id": "schema_organization_developed_product",
      "subject_type": "Organization",
      "predicate": "develops",
      "object_type": "Product",
      "confidence": 0.72,
      "evidence": "OpenAI developed ChatGPT",
      "status": "pending"
    }
  ],
  "notes": "Brief assumptions, ambiguities, and contradictions."
}`;
}

async function askModel(prompt: string, provider: ModelProvider, requestId: string): Promise<RawKgPayload> {
  return provider === "azure-openai" ? askAzureOpenAi(prompt, requestId) : askOllama(prompt, requestId);
}

async function askOllama(prompt: string, requestId: string): Promise<RawKgPayload> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  console.log(
    `[${new Date().toISOString()}] ${requestId} ollama -> model=${ollamaModel} baseUrl=${ollamaBaseUrl} promptChars=${prompt.length} timeoutMs=${timeoutMs}`
  );

  try {
    const response = await fetch(`${ollamaBaseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ollamaModel,
        prompt,
        stream: false,
        format: "json",
        options: { temperature: 0.15 }
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

    return await parseModelJson(body.response, "ollama", requestId);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Ollama request timed out after ${timeoutMs / 1000} seconds.`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Ollama returned invalid JSON: ${error.message}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function askAzureOpenAi(prompt: string, requestId: string): Promise<RawKgPayload> {
  const missing = [
    ["OPENAI_AZURE_API_KEY", azureOpenAiApiKey],
    ["OPENAI_AZURE_API_ENDPOINT", azureOpenAiEndpoint]
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  const endpoint = `${azureOpenAiEndpoint!.replace(/\/+$/, "")}/openai/deployments/${encodeURIComponent(
    azureOpenAiDeployment
  )}/chat/completions?api-version=${encodeURIComponent(azureOpenAiApiVersion)}`;

  console.log(
    `[${new Date().toISOString()}] ${requestId} azure-openai -> deployment=${azureOpenAiDeployment} endpoint=${azureOpenAiEndpoint} promptChars=${prompt.length} timeoutMs=${timeoutMs}`
  );

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": azureOpenAiApiKey!
      },
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content:
              "You are Text2KG. Return only a valid JSON object that matches the requested knowledge graph schema."
          },
          { role: "user", content: prompt }
        ],
        response_format: { type: "json_object" },
        max_completion_tokens: 4096
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Azure OpenAI returned ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Azure OpenAI returned an empty response.");
    }

    console.log(
      `[${new Date().toISOString()}] ${requestId} azure-openai <- status=${response.status} elapsedMs=${Date.now() - startedAt} responseChars=${content.length} preview=${preview(content)}`
    );

    return await parseModelJson(content, "azure-openai", requestId);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Azure OpenAI request timed out after ${timeoutMs / 1000} seconds.`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Azure OpenAI returned invalid JSON: ${error.message}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function parseModelJson(responseText: string, provider: ModelProvider, requestId: string): Promise<RawKgPayload> {
  const attempts = buildJsonParseAttempts(responseText);
  const errors: string[] = [];

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate) as RawKgPayload;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "unknown parse error");
    }
  }

  const repaired = await repairJsonWithModel(responseText, provider, requestId);
  for (const candidate of buildJsonParseAttempts(repaired)) {
    try {
      return JSON.parse(candidate) as RawKgPayload;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "unknown repaired parse error");
    }
  }

  console.error(
    `[${new Date().toISOString()}] ${requestId} json parse failed attempts=${errors.slice(0, 4).join(" | ")} responsePreview=${preview(responseText)}`
  );
  throw new SyntaxError(`${providerLabel(provider)} produced malformed JSON even after repair.`);
}

function buildJsonParseAttempts(responseText: string): string[] {
  const trimmed = responseText.trim();
  const withoutFence = stripMarkdownFence(trimmed);
  const extracted = extractFirstJsonObject(withoutFence) ?? withoutFence;
  const withoutTrailingCommas = removeTrailingCommas(extracted);
  const withEscapedControls = escapeControlCharactersInStrings(withoutTrailingCommas);

  return Array.from(new Set([trimmed, withoutFence, extracted, withoutTrailingCommas, withEscapedControls]));
}

async function repairJsonWithModel(responseText: string, provider: ModelProvider, requestId: string): Promise<string> {
  if (provider === "azure-openai") {
    return repairJsonWithAzureOpenAi(responseText, requestId);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(timeoutMs, 60000));

  console.log(
    `[${new Date().toISOString()}] ${requestId} ollama repair -> malformedChars=${responseText.length}`
  );

  try {
    const response = await fetch(`${ollamaBaseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ollamaModel,
        stream: false,
        format: "json",
        options: { temperature: 0 },
        prompt: [
          "Repair the following malformed JSON into valid JSON only.",
          "Keep the same data and the same top-level keys. Do not add explanations or markdown.",
          "If a field is incomplete, use an empty string, empty object, empty array, or 0.5 confidence.",
          responseText
        ].join("\n\n")
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Ollama repair returned ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as { response?: string };
    const repaired = body.response ?? "";
    console.log(
      `[${new Date().toISOString()}] ${requestId} ollama repair <- responseChars=${repaired.length} preview=${preview(repaired)}`
    );
    return repaired;
  } finally {
    clearTimeout(timeout);
  }
}

async function repairJsonWithAzureOpenAi(responseText: string, requestId: string): Promise<string> {
  if (!azureOpenAiApiKey || !azureOpenAiEndpoint) {
    throw new Error("Azure OpenAI JSON repair is unavailable because Azure credentials are missing.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(timeoutMs, 60000));
  const endpoint = `${azureOpenAiEndpoint.replace(/\/+$/, "")}/openai/deployments/${encodeURIComponent(
    azureOpenAiDeployment
  )}/chat/completions?api-version=${encodeURIComponent(azureOpenAiApiVersion)}`;

  console.log(
    `[${new Date().toISOString()}] ${requestId} azure-openai repair -> malformedChars=${responseText.length}`
  );

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": azureOpenAiApiKey
      },
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content: "Repair malformed JSON. Return valid JSON only, with no markdown or explanation."
          },
          {
            role: "user",
            content: [
              "Repair the following malformed JSON into valid JSON only.",
              "Keep the same data and the same top-level keys.",
              "If a field is incomplete, use an empty string, empty object, empty array, or 0.5 confidence.",
              responseText
            ].join("\n\n")
          }
        ],
        response_format: { type: "json_object" },
        max_completion_tokens: 4096
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Azure OpenAI repair returned ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const repaired = body.choices?.[0]?.message?.content ?? "";
    console.log(
      `[${new Date().toISOString()}] ${requestId} azure-openai repair <- responseChars=${repaired.length} preview=${preview(repaired)}`
    );
    return repaired;
  } finally {
    clearTimeout(timeout);
  }
}

function stripMarkdownFence(value: string): string {
  return value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractFirstJsonObject(value: string): string | null {
  const start = value.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < value.length; index += 1) {
    const char = value[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, index + 1);
      }
    }
  }

  return value.slice(start);
}

function removeTrailingCommas(value: string): string {
  return value.replace(/,\s*([}\]])/g, "$1");
}

function escapeControlCharactersInStrings(value: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (const char of value) {
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      output += char;
      escaped = true;
      continue;
    }
    if (char === "\"") {
      output += char;
      inString = !inString;
      continue;
    }
    if (inString && char === "\n") {
      output += "\\n";
      continue;
    }
    if (inString && char === "\r") {
      output += "\\r";
      continue;
    }
    if (inString && char === "\t") {
      output += "\\t";
      continue;
    }
    output += char;
  }

  return output;
}

function normalizeKgPayload(value: RawKgPayload, sourceText: string, level: GeneralizationLevel): KgPayload {
  if (!value || typeof value !== "object") {
    throw new Error("Ollama response was not a KG extraction object.");
  }

  const triples = dedupeTriples(
    Array.isArray(value.triples)
      ? value.triples.map((triple, index) => normalizeTriple(triple, sourceText, index)).filter(isTruthy)
      : []
  );

  const nodeByName = new Map<string, KgNode>();
  for (const node of Array.isArray(value.nodes) ? value.nodes.map((item) => normalizeNode(item, sourceText)).filter(isTruthy) : []) {
    nodeByName.set(normalizeKey(node.name), node);
  }

  for (const triple of triples) {
    ensureNode(nodeByName, triple.subject, triple.subject_type, triple.confidence, triple.evidence, triple.status);
    ensureNode(nodeByName, triple.object, triple.object_type, triple.confidence, triple.evidence, triple.status);
  }

  const nodes = Array.from(nodeByName.values()).map((node) => ({ ...node, id: stableNodeId(node.name) }));
  const nodeIdByName = new Map(nodes.map((node) => [normalizeKey(node.name), node.id]));
  const modelEdges = Array.isArray(value.edges)
    ? value.edges.map((item) => normalizeEdge(item, sourceText, nodeIdByName)).filter(isTruthy)
    : [];
  const tripleEdges = triples.map((triple) => edgeFromTriple(triple, nodeIdByName)).filter(isTruthy);
  const edges = dedupeEdges([...modelEdges, ...tripleEdges]);
  const schema = dedupeSchema(
    Array.isArray(value.schema)
      ? value.schema.map((item, index) => normalizeSchema(item, sourceText, index)).filter(isTruthy)
      : []
  );

  return {
    nodes,
    edges,
    triples,
    schema,
    notes: typeof value.notes === "string" ? value.notes.trim() : "",
    generalizationLevel: level
  };
}

function normalizeTriple(value: unknown, sourceText: string, index: number): KgTriple | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Partial<KgTriple>;
  const subject = cleanString(raw.subject);
  const predicate = cleanPredicate(raw.predicate);
  const object = cleanString(raw.object);
  if (!subject || !predicate || !object) {
    return null;
  }

  const evidence = cleanString(raw.evidence);
  const evidenceMatches = evidenceAppearsInText(evidence, sourceText);
  const confidence = evidenceMatches ? clampConfidence(raw.confidence) : Math.min(clampConfidence(raw.confidence), 0.45);
  const status = normalizeStatus(raw.status, confidence, evidenceMatches);

  return {
    id: stableId(raw.id ?? `triple-${index + 1}-${subject}-${predicate}-${object}`),
    subject,
    predicate,
    object,
    subject_type: cleanString(raw.subject_type) || "Entity",
    object_type: cleanString(raw.object_type) || "Entity",
    confidence,
    evidence,
    status
  };
}

function normalizeNode(value: unknown, sourceText: string): KgNode | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Partial<KgNode>;
  const name = cleanString(raw.name);
  if (!name) {
    return null;
  }

  const evidence = normalizeEvidenceArray(raw.evidence);
  const evidenceMatches = evidence.length === 0 || evidence.some((item) => evidenceAppearsInText(item, sourceText));
  const confidence = evidenceMatches ? clampConfidence(raw.confidence) : Math.min(clampConfidence(raw.confidence), 0.45);

  return {
    id: stableNodeId(name),
    name,
    label: cleanString(raw.label) || "Entity",
    properties: normalizeProperties(raw.properties),
    confidence,
    evidence,
    status: normalizeStatus(raw.status, confidence, evidenceMatches)
  };
}

function normalizeEdge(value: unknown, sourceText: string, nodeIdByName: Map<string, string>): KgEdge | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Partial<KgEdge>;
  const source = cleanString(raw.source);
  const target = cleanString(raw.target);
  const label = cleanPredicate(raw.label);
  const sourceId = nodeIdByName.get(normalizeKey(source)) ?? (source.startsWith("node_") ? source : "");
  const targetId = nodeIdByName.get(normalizeKey(target)) ?? (target.startsWith("node_") ? target : "");

  if (!sourceId || !targetId || sourceId === targetId || !label) {
    return null;
  }

  const evidence = normalizeEvidenceArray(raw.evidence);
  const evidenceMatches = evidence.length === 0 || evidence.some((item) => evidenceAppearsInText(item, sourceText));
  const confidence = evidenceMatches ? clampConfidence(raw.confidence) : Math.min(clampConfidence(raw.confidence), 0.45);

  return {
    id: stableId(raw.id ?? `edge-${sourceId}-${label}-${targetId}`),
    source: sourceId,
    target: targetId,
    label,
    properties: normalizeProperties(raw.properties),
    confidence,
    evidence,
    status: normalizeStatus(raw.status, confidence, evidenceMatches)
  };
}

function normalizeSchema(value: unknown, sourceText: string, index: number): SchemaSuggestion | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Partial<SchemaSuggestion>;
  const subjectType = cleanString(raw.subject_type);
  const predicate = cleanPredicate(raw.predicate);
  const objectType = cleanString(raw.object_type);
  if (!subjectType || !predicate || !objectType) {
    return null;
  }

  const evidence = cleanString(raw.evidence);
  const evidenceMatches = evidenceAppearsInText(evidence, sourceText);
  const confidence = evidenceMatches ? clampConfidence(raw.confidence) : Math.min(clampConfidence(raw.confidence), 0.45);

  return {
    id: stableId(raw.id ?? `schema-${index + 1}-${subjectType}-${predicate}-${objectType}`),
    subject_type: subjectType,
    predicate,
    object_type: objectType,
    confidence,
    evidence,
    status: normalizeStatus(raw.status, confidence, evidenceMatches)
  };
}

function ensureNode(
  nodes: Map<string, KgNode>,
  name: string,
  label: string,
  confidence: number,
  evidence: string,
  status: ReviewStatus
) {
  const key = normalizeKey(name);
  const current = nodes.get(key);
  if (current) {
    current.confidence = Math.max(current.confidence, confidence);
    current.evidence = Array.from(new Set([...current.evidence, evidence].filter(Boolean)));
    if (current.status !== "needs_review") {
      current.status = status === "needs_review" ? "needs_review" : current.status;
    }
    return;
  }

  nodes.set(key, {
    id: stableNodeId(name),
    name,
    label: label || "Entity",
    properties: {},
    confidence,
    evidence: evidence ? [evidence] : [],
    status
  });
}

function edgeFromTriple(triple: KgTriple, nodeIdByName: Map<string, string>): KgEdge | null {
  const source = nodeIdByName.get(normalizeKey(triple.subject));
  const target = nodeIdByName.get(normalizeKey(triple.object));
  if (!source || !target || source === target) {
    return null;
  }

  return {
    id: stableId(`edge-${source}-${triple.predicate}-${target}`),
    source,
    target,
    label: triple.predicate,
    properties: {},
    confidence: triple.confidence,
    evidence: triple.evidence ? [triple.evidence] : [],
    status: triple.status
  };
}

function buildGraphMl(kg: KgPayload, approvedOnly: boolean): string {
  const triples = kg.triples.filter((triple) => (approvedOnly ? triple.status === "approved" : triple.status !== "rejected"));
  const nodeByName = new Map<string, KgNode>();
  for (const node of kg.nodes) {
    nodeByName.set(normalizeKey(node.name), node);
  }

  for (const triple of triples) {
    ensureExportNode(nodeByName, triple.subject, triple.subject_type, triple.confidence, triple.evidence, triple.status);
    ensureExportNode(nodeByName, triple.object, triple.object_type, triple.confidence, triple.evidence, triple.status);
  }

  const tripleNodeNames = new Set(triples.flatMap((triple) => [normalizeKey(triple.subject), normalizeKey(triple.object)]));
  const nodes = Array.from(nodeByName.values()).filter((node) => tripleNodeNames.has(normalizeKey(node.name)));
  const nodeIdByName = new Map(nodes.map((node) => [normalizeKey(node.name), node.id]));
  const edgeLines = triples
    .map((triple) => {
      const source = nodeIdByName.get(normalizeKey(triple.subject));
      const target = nodeIdByName.get(normalizeKey(triple.object));
      if (!source || !target) {
        return "";
      }
      return [
        `    <edge id="${xmlAttr(triple.id)}" source="${xmlAttr(source)}" target="${xmlAttr(target)}">`,
        `      <data key="predicate">${xmlText(triple.predicate)}</data>`,
        `      <data key="confidence">${triple.confidence.toFixed(2)}</data>`,
        `      <data key="status">${xmlText(triple.status)}</data>`,
        `      <data key="evidence">${xmlText(triple.evidence)}</data>`,
        "    </edge>"
      ].join("\n");
    })
    .filter(Boolean);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    '  <key id="label" for="node" attr.name="label" attr.type="string"/>',
    '  <key id="name" for="node" attr.name="name" attr.type="string"/>',
    '  <key id="confidence" for="all" attr.name="confidence" attr.type="double"/>',
    '  <key id="status" for="all" attr.name="status" attr.type="string"/>',
    '  <key id="evidence" for="all" attr.name="evidence" attr.type="string"/>',
    '  <key id="predicate" for="edge" attr.name="predicate" attr.type="string"/>',
    '  <graph id="Text2KG" edgedefault="directed">',
    ...nodes.map((node) =>
      [
        `    <node id="${xmlAttr(node.id)}">`,
        `      <data key="name">${xmlText(node.name)}</data>`,
        `      <data key="label">${xmlText(node.label)}</data>`,
        `      <data key="confidence">${node.confidence.toFixed(2)}</data>`,
        `      <data key="status">${xmlText(node.status)}</data>`,
        `      <data key="evidence">${xmlText(node.evidence.join(" | "))}</data>`,
        "    </node>"
      ].join("\n")
    ),
    ...edgeLines,
    "  </graph>",
    "</graphml>",
    ""
  ].join("\n");
}

function ensureExportNode(
  nodes: Map<string, KgNode>,
  name: string,
  label: string,
  confidence: number,
  evidence: string,
  status: ReviewStatus
) {
  const key = normalizeKey(name);
  const current = nodes.get(key);
  if (current) {
    current.confidence = Math.max(current.confidence, confidence);
    current.evidence = Array.from(new Set([...current.evidence, evidence].filter(Boolean)));
    return;
  }

  nodes.set(key, {
    id: stableNodeId(name),
    name,
    label: label || "Entity",
    properties: {},
    confidence,
    evidence: evidence ? [evidence] : [],
    status
  });
}

function dedupeTriples(triples: KgTriple[]): KgTriple[] {
  const seen = new Set<string>();
  return triples.filter((triple) => {
    const key = `${normalizeKey(triple.subject)}|${normalizeKey(triple.predicate)}|${normalizeKey(triple.object)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupeEdges(edges: KgEdge[]): KgEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.source}|${normalizeKey(edge.label)}|${edge.target}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupeSchema(schema: SchemaSuggestion[]): SchemaSuggestion[] {
  const seen = new Set<string>();
  return schema.filter((item) => {
    const key = `${normalizeKey(item.subject_type)}|${normalizeKey(item.predicate)}|${normalizeKey(item.object_type)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function normalizeGeneralizationLevel(value: unknown): GeneralizationLevel {
  return value === "low" || value === "medium" || value === "high" ? value : "medium";
}

function normalizeModelProvider(value: unknown): ModelProvider {
  return value === "azure-openai" ? "azure-openai" : "ollama";
}

function providerLabel(provider: ModelProvider): string {
  return provider === "azure-openai" ? "Azure OpenAI" : "Ollama";
}

function normalizeStatus(value: unknown, confidence: number, hasEvidence: boolean): ReviewStatus {
  const allowed: ReviewStatus[] = ["pending", "approved", "rejected", "edited", "needs_review"];
  if (!hasEvidence || confidence < 0.55) {
    return "needs_review";
  }
  return allowed.includes(value as ReviewStatus) ? (value as ReviewStatus) : "pending";
}

function normalizeEvidenceArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(cleanString).filter(Boolean);
  }
  const single = cleanString(value);
  return single ? [single] : [];
}

function normalizeProperties(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const properties: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    const propertyKey = cleanString(key);
    const propertyValue = typeof item === "string" || typeof item === "number" || typeof item === "boolean" ? String(item) : "";
    if (propertyKey && propertyValue) {
      properties[propertyKey] = propertyValue;
    }
  }
  return properties;
}

function evidenceAppearsInText(evidence: string, sourceText: string): boolean {
  if (!evidence) {
    return false;
  }
  return sourceText.toLowerCase().includes(evidence.toLowerCase());
}

function clampConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanPredicate(value: unknown): string {
  return cleanString(value).replace(/\s+/g, " ");
}

function stableNodeId(name: string): string {
  return `node_${stableId(name) || "entity"}`;
}

function stableId(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function xmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xmlAttr(value: string): string {
  return xmlText(value).replace(/"/g, "&quot;");
}

function isTruthy<T>(value: T | null | undefined | false): value is T {
  return Boolean(value);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown server error.";
}

function getRequestId(res: express.Response): string {
  return typeof res.locals.requestId === "string" ? res.locals.requestId : "req-unknown";
}

function loadDotEnv() {
  for (const envPath of [path.resolve(process.cwd(), ".env"), path.resolve(process.cwd(), "..", ".env")]) {
    if (!existsSync(envPath)) {
      continue;
    }

    const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separator = trimmed.indexOf("=");
      if (separator <= 0) {
        continue;
      }

      const key = trimmed.slice(0, separator).trim();
      const rawValue = trimmed.slice(separator + 1).trim();
      const value = rawValue.replace(/^(['"])(.*)\1$/, "$2");
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

function formatBodySummary(body: unknown): string {
  if (!body || typeof body !== "object") {
    return "";
  }

  const value = body as { text?: string; generalizationLevel?: string; modelProvider?: string; kg?: KgPayload };
  const parts: string[] = [];
  if (typeof value.text === "string") {
    parts.push(`textChars=${value.text.length}`);
  }
  if (typeof value.generalizationLevel === "string") {
    parts.push(`generalization=${value.generalizationLevel}`);
  }
  if (typeof value.modelProvider === "string") {
    parts.push(`provider=${value.modelProvider}`);
  }
  if (value.kg) {
    parts.push(`kg=${value.kg.triples?.length ?? 0}t`);
  }

  return parts.length ? `(${parts.join(" ")})` : "";
}

function preview(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 180);
}
