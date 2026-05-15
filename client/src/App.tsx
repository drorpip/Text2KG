import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Download,
  FileUp,
  FileText,
  Pencil,
  Plus,
  RefreshCcw,
  TableProperties,
  Trash2,
  X,
  XCircle
} from "lucide-react";
import { ApiLogEntry, analyzeText, exportGraphMl, makeLog } from "./api";
import { GraphEditor, type GraphLayout } from "./GraphEditor";
import { confidenceLabel, emptyKgResult, filenameFromText, reviewedTriples, statusLabel } from "./graph";
import { parseGraphMlToKg } from "./graphml";
import type { GeneralizationLevel, KgNode, KgResult, KgTriple, ModelProvider, ReviewStatus, SchemaSuggestion } from "./types";

const storageKey = "text2kg-state-v1";

type SavedState = {
  sourceText: string;
  generalizationLevel: GeneralizationLevel;
  modelProvider: ModelProvider;
  graphLayout: GraphLayout;
  kg: KgResult;
};

type ActiveView = "graph" | "triples" | "nodes" | "edges" | "schema";

export function App() {
  const initialState = loadState();
  const [sourceText, setSourceText] = useState(initialState.sourceText);
  const [generalizationLevel, setGeneralizationLevel] = useState<GeneralizationLevel>(initialState.generalizationLevel);
  const [modelProvider, setModelProvider] = useState<ModelProvider>(initialState.modelProvider);
  const [graphLayout, setGraphLayout] = useState<GraphLayout>(initialState.graphLayout);
  const [kg, setKg] = useState<KgResult>(initialState.kg);
  const kgRef = useRef(initialState.kg);
  const [activeView, setActiveView] = useState<ActiveView>("triples");
  const [editingTripleId, setEditingTripleId] = useState<string | null>(null);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [approvedOnlyExport, setApprovedOnlyExport] = useState(false);
  const workspaceVersionRef = useRef(0);
  const graphMlInputRef = useRef<HTMLInputElement | null>(null);
  const [logs, setLogs] = useState<ApiLogEntry[]>(() => [
    makeLog("info", "Text2KG diagnostics ready. Backend logs are printed in the dev terminal.")
  ]);

  function addLog(entry: ApiLogEntry) {
    setLogs((items) => [entry, ...items].slice(0, 80));
  }

  function updateKg(next: KgResult | ((current: KgResult) => KgResult)) {
    setKg((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      kgRef.current = resolved;
      return resolved;
    });
  }

  useEffect(() => {
    kgRef.current = kg;
    localStorage.setItem(storageKey, JSON.stringify({ sourceText, generalizationLevel, modelProvider, graphLayout, kg }));
  }, [sourceText, generalizationLevel, modelProvider, graphLayout, kg]);

  const stats = useMemo(() => {
    const lowConfidence = kg.triples.filter((triple) => triple.confidence < 0.55 || triple.status === "needs_review").length;
    return {
      nodes: kg.nodes.length,
      edges: kg.edges.length,
      triples: kg.triples.length,
      lowConfidence,
      reviewed: kg.triples.filter((triple) => triple.status === "approved" || triple.status === "rejected").length,
      exportable: reviewedTriples(kg.triples).length
    };
  }, [kg]);

  async function requestAnalysis() {
    const requestWorkspaceVersion = workspaceVersionRef.current;
    const schemaGuidance = kg.schema.filter((schema) => schema.status !== "rejected");
    setIsLoading(true);
    setError("");
    setStatus(`Analyzing text with ${modelProviderLabel(modelProvider)}...`);
    addLog(
      makeLog(
        "info",
        `Analyze clicked with ${sourceText.length} source chars using ${modelProviderLabel(modelProvider)} and ${schemaGuidance.length} schema rows.`
      )
    );

    try {
      const result = await analyzeText(sourceText, generalizationLevel, modelProvider, schemaGuidance, addLog);
      if (workspaceVersionRef.current !== requestWorkspaceVersion) {
        setStatus("Ignored analysis result because the workspace was reset.");
        addLog(makeLog("info", "Ignored stale analysis result after reset."));
        return;
      }
      const merge = mergeKgResults(kgRef.current, result);
      updateKg(merge.kg);
      setActiveView("triples");
      setEditingTripleId(null);
      setStatus(
        `Appended ${merge.added.triples} triples, ${merge.added.nodes} nodes, ${merge.added.edges} relationships, and ${merge.added.schema} schema rows.`
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Analysis failed.";
      setError(message);
      setStatus(message);
      addLog(makeLog("error", message));
    } finally {
      setIsLoading(false);
    }
  }

  function updateTriple(id: string, patch: Partial<KgTriple>) {
    updateKg((current) => ({
      ...current,
      triples: current.triples.map((triple) =>
        triple.id === id ? { ...triple, ...patch, status: patch.status ?? "edited" } : triple
      )
    }));
  }

  function setTripleStatus(id: string, nextStatus: ReviewStatus) {
    updateKg((current) => ({
      ...current,
      triples: current.triples.map((triple) => (triple.id === id ? { ...triple, status: nextStatus } : triple))
    }));
  }

  function deleteTriple(id: string) {
    updateKg((current) => ({
      ...current,
      triples: current.triples.map((triple) => (triple.id === id ? { ...triple, status: "rejected" } : triple))
    }));
    setEditingTripleId(null);
  }

  function addSchema() {
    updateKg((current) => {
      const nextIndex = current.schema.length + 1;
      return {
        ...current,
        schema: [
          ...current.schema,
          {
            id: uniqueSchemaId(`schema_entity_related_to_entity_${nextIndex}`, current.schema),
            subject_type: "Entity",
            predicate: "related_to",
            object_type: "Entity",
            confidence: 0.5,
            evidence: "",
            status: "edited"
          }
        ]
      };
    });
    setStatus("Added schema pattern.");
  }

  function updateSchema(id: string, patch: Partial<SchemaSuggestion>) {
    updateKg((current) => ({
      ...current,
      schema: current.schema.map((schema) =>
        schema.id === id
          ? {
              ...schema,
              ...patch,
              confidence: patch.confidence === undefined ? schema.confidence : clampConfidence(patch.confidence),
              status: patch.status ?? "edited"
            }
          : schema
      )
    }));
  }

  function setSchemaStatus(id: string, nextStatus: ReviewStatus) {
    updateKg((current) => ({
      ...current,
      schema: current.schema.map((schema) => (schema.id === id ? { ...schema, status: nextStatus } : schema))
    }));
  }

  function deleteSchema(id: string) {
    updateKg((current) => ({
      ...current,
      schema: current.schema.filter((schema) => schema.id !== id)
    }));
    setStatus("Deleted schema pattern.");
  }

  function resetWorkspace() {
    workspaceVersionRef.current += 1;
    setSourceText("");
    setGeneralizationLevel("medium");
    setModelProvider("ollama");
    setGraphLayout({});
    updateKg(emptyKgResult);
    localStorage.setItem(
      storageKey,
      JSON.stringify({ sourceText: "", generalizationLevel: "medium", modelProvider: "ollama", graphLayout: {}, kg: emptyKgResult })
    );
    setEditingTripleId(null);
    setError("");
    setStatus("Ready");
    addLog(makeLog("info", "Workspace cleared."));
  }

  async function downloadGraphMl() {
    setIsLoading(true);
    setError("");
    try {
      const graphml = await exportGraphMl(kg, approvedOnlyExport, sourceText, addLog);
      const blob = new Blob([graphml], { type: "application/graphml+xml" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filenameFromText(sourceText);
      link.click();
      URL.revokeObjectURL(url);
      setStatus(`Exported ${approvedOnlyExport ? "approved" : "reviewed"} graph as GraphML.`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "GraphML export failed.";
      setError(message);
      setStatus(message);
    } finally {
      setIsLoading(false);
    }
  }

  async function importGraphMl(file: File | undefined) {
    if (!file) {
      return;
    }

    try {
      const parsed = parseGraphMlToKg(await file.text());
      if (
        (kg.nodes.length || kg.edges.length || kg.triples.length || sourceText.trim()) &&
        !window.confirm("Replace the current graph and source text with this GraphML file?")
      ) {
        return;
      }

      updateKg(parsed.kg);
      setGraphLayout({});
      setSourceText(parsed.sourceText);
      setActiveView("graph");
      setEditingTripleId(null);
      setError("");
      setStatus(
        `Imported GraphML with ${parsed.kg.nodes.length} nodes and ${parsed.kg.edges.length} edges${
          parsed.sourceText ? ", including source text" : ""
        }.`
      );
      addLog(makeLog("info", `Imported GraphML (${parsed.kg.nodes.length} nodes, ${parsed.kg.edges.length} edges).`));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "GraphML import failed.";
      setError(message);
      setStatus(message);
      addLog(makeLog("error", message));
    } finally {
      if (graphMlInputRef.current) {
        graphMlInputRef.current.value = "";
      }
    }
  }

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div>
          <h1>Text2KG</h1>
          <p>Knowledge Graph Understanding Assistant</p>
        </div>
        <div className="top-actions">
          <button type="button" className="secondary-button" onClick={resetWorkspace} title="Clear workspace">
            <RefreshCcw size={17} />
            Reset
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => graphMlInputRef.current?.click()}
            disabled={isLoading}
            title="Import GraphML"
          >
            <FileUp size={17} />
            Import GraphML
          </button>
          <input
            ref={graphMlInputRef}
            className="hidden-file-input"
            type="file"
            accept=".graphml,.xml,application/xml,text/xml"
            onChange={(event) => void importGraphMl(event.target.files?.[0])}
          />
          <button type="button" onClick={downloadGraphMl} disabled={isLoading || stats.exportable === 0} title="Export GraphML">
            <Download size={17} />
            Export GraphML
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className="input-panel">
          <div className="panel-heading">
            <FileText size={18} />
            <div>
              <h2>Source Text</h2>
              <p>Paste a long English article or business document.</p>
            </div>
          </div>

          <textarea
            value={sourceText}
            onChange={(event) => setSourceText(event.target.value)}
            placeholder="Paste a long English text. Text2KG will suggest triples, evidence, confidence, and useful types."
          />

          <label className="field">
            Generalization level
            <select
              value={generalizationLevel}
              onChange={(event) => setGeneralizationLevel(event.target.value as GeneralizationLevel)}
            >
              <option value="low">Low - specific instance facts</option>
              <option value="medium">Medium - typed entities</option>
              <option value="high">High - schema suggestions</option>
            </select>
          </label>

          <label className="field">
            Model
            <select value={modelProvider} onChange={(event) => setModelProvider(event.target.value as ModelProvider)}>
              <option value="ollama">Ollama - Gemma</option>
              <option value="azure-openai">Azure OpenAI - GPT-5.2</option>
            </select>
          </label>

          <button type="button" className="analyze-button" onClick={requestAnalysis} disabled={isLoading}>
            <TableProperties size={18} />
            {isLoading ? "Analyzing..." : "Analyze"}
          </button>

          <p className={error ? "status error" : "status"}>{status}</p>
          {error ? <p className="error-box">{error}</p> : null}
        </section>

        <section className="results-panel">
          <Summary stats={stats} notes={kg.notes} />

          <div className="tabs" role="tablist" aria-label="KG result views">
            <TabButton active={activeView === "graph"} onClick={() => setActiveView("graph")}>
              Graph
            </TabButton>
            <TabButton active={activeView === "triples"} onClick={() => setActiveView("triples")}>
              Suggested triples
            </TabButton>
            <TabButton active={activeView === "nodes"} onClick={() => setActiveView("nodes")}>
              Possible nodes
            </TabButton>
            <TabButton active={activeView === "edges"} onClick={() => setActiveView("edges")}>
              Potential relationships
            </TabButton>
            <TabButton active={activeView === "schema"} onClick={() => setActiveView("schema")}>
              Schema view
            </TabButton>
          </div>

          <div className="result-surface">
            {activeView === "graph" ? (
              <GraphEditor
                kg={kg}
                layout={graphLayout}
                onLayoutChange={setGraphLayout}
                onKgChange={updateKg}
                onStatus={(message) => {
                  setStatus(message);
                  addLog(makeLog(message.toLowerCase().includes("failed") || message.toLowerCase().includes("invalid") ? "error" : "info", message));
                }}
              />
            ) : null}
            {activeView === "triples" ? (
              <TriplesTable
                triples={kg.triples}
                editingTripleId={editingTripleId}
                onEdit={setEditingTripleId}
                onUpdate={updateTriple}
                onStatus={setTripleStatus}
                onDelete={deleteTriple}
              />
            ) : null}
            {activeView === "nodes" ? <NodesList kg={kg} /> : null}
            {activeView === "edges" ? <EdgesList kg={kg} /> : null}
            {activeView === "schema" ? (
              <SchemaView
                schema={kg.schema}
                onAdd={addSchema}
                onUpdate={updateSchema}
                onStatus={setSchemaStatus}
                onDelete={deleteSchema}
              />
            ) : null}
          </div>
        </section>

        <aside className="review-panel">
          <section className="panel-block">
            <h2>Export</h2>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={approvedOnlyExport}
                onChange={(event) => setApprovedOnlyExport(event.target.checked)}
              />
              Approved triples only
            </label>
            <p className="muted">
              {approvedOnlyExport
                ? `${kg.triples.filter((triple) => triple.status === "approved").length} approved triples ready.`
                : `${stats.exportable} non-rejected triples ready.`}
            </p>
          </section>

          <section className="panel-block diagnostics-block">
            <div className="panel-title-row">
              <h2>Diagnostics</h2>
              <button type="button" className="secondary-button compact" onClick={() => setLogs([makeLog("info", "Diagnostics cleared.")])}>
                Clear
              </button>
            </div>
            <div className="log-list" aria-live="polite">
              {logs.map((entry) => (
                <div className={`log-entry ${entry.level}`} key={entry.id}>
                  <time>{entry.time}</time>
                  <span>{entry.message}</span>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </main>
    </div>
  );
}

function Summary({
  stats,
  notes
}: {
  stats: { nodes: number; edges: number; triples: number; lowConfidence: number; reviewed: number; exportable: number };
  notes: string;
}) {
  return (
    <section className="summary-band">
      <StatCard label="Possible nodes" value={stats.nodes} />
      <StatCard label="Potential edges" value={stats.edges} />
      <StatCard label="Suggested triples" value={stats.triples} />
      <StatCard label="Needs review" value={stats.lowConfidence} tone={stats.lowConfidence ? "warn" : "normal"} />
      <StatCard label="Reviewed" value={stats.reviewed} />
      {notes ? <p className="notes">{notes}</p> : null}
    </section>
  );
}

function StatCard({ label, value, tone = "normal" }: { label: string; value: number; tone?: "normal" | "warn" }) {
  return (
    <div className={`stat-card ${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function TabButton({ active, children, onClick }: { active: boolean; children: string; onClick: () => void }) {
  return (
    <button type="button" className={active ? "tab active" : "tab"} onClick={onClick}>
      {children}
    </button>
  );
}

function TriplesTable({
  triples,
  editingTripleId,
  onEdit,
  onUpdate,
  onStatus,
  onDelete
}: {
  triples: KgTriple[];
  editingTripleId: string | null;
  onEdit: (id: string | null) => void;
  onUpdate: (id: string, patch: Partial<KgTriple>) => void;
  onStatus: (id: string, status: ReviewStatus) => void;
  onDelete: (id: string) => void;
}) {
  if (triples.length === 0) {
    return <EmptyState title="No suggested triples yet" body="Analyze a text to see reviewable Knowledge Graph suggestions." />;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Subject</th>
            <th>Predicate</th>
            <th>Object</th>
            <th>Types</th>
            <th>Confidence</th>
            <th>Evidence</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {triples.map((triple) => {
            const isEditing = editingTripleId === triple.id;
            return (
              <tr key={triple.id} className={`status-${triple.status}`}>
                <td>
                  {isEditing ? (
                    <input value={triple.subject} onChange={(event) => onUpdate(triple.id, { subject: event.target.value })} />
                  ) : (
                    triple.subject
                  )}
                </td>
                <td>
                  {isEditing ? (
                    <input value={triple.predicate} onChange={(event) => onUpdate(triple.id, { predicate: event.target.value })} />
                  ) : (
                    <strong>{triple.predicate}</strong>
                  )}
                </td>
                <td>
                  {isEditing ? (
                    <input value={triple.object} onChange={(event) => onUpdate(triple.id, { object: event.target.value })} />
                  ) : (
                    triple.object
                  )}
                </td>
                <td>
                  {isEditing ? (
                    <div className="type-edit">
                      <input
                        value={triple.subject_type}
                        aria-label="Subject type"
                        onChange={(event) => onUpdate(triple.id, { subject_type: event.target.value })}
                      />
                      <input
                        value={triple.object_type}
                        aria-label="Object type"
                        onChange={(event) => onUpdate(triple.id, { object_type: event.target.value })}
                      />
                    </div>
                  ) : (
                    <span className="type-pair">
                      {triple.subject_type} {"->"} {triple.object_type}
                    </span>
                  )}
                </td>
                <td>
                  <span className={`confidence ${confidenceClass(triple.confidence)}`}>
                    {triple.confidence.toFixed(2)}
                    <small>{confidenceLabel(triple.confidence)}</small>
                  </span>
                </td>
                <td>
                  <blockquote>{triple.evidence || "No clear evidence"}</blockquote>
                </td>
                <td>
                  <span className={`status-pill ${triple.status}`}>{statusLabel(triple.status)}</span>
                </td>
                <td>
                  <div className="action-row">
                    <button type="button" className="icon-button approve" onClick={() => onStatus(triple.id, "approved")} title="Approve">
                      <Check size={16} />
                    </button>
                    <button type="button" className="icon-button reject" onClick={() => onStatus(triple.id, "rejected")} title="Reject">
                      <X size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => onEdit(isEditing ? null : triple.id)}
                      title={isEditing ? "Finish editing" : "Edit"}
                    >
                      <Pencil size={16} />
                    </button>
                    <button type="button" className="icon-button reject" onClick={() => onDelete(triple.id)} title="Delete triple">
                      <Trash2 size={16} />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function NodesList({ kg }: { kg: KgResult }) {
  if (kg.nodes.length === 0) {
    return <EmptyState title="No possible nodes yet" body="Nodes are derived from the suggested triples and model output." />;
  }

  return (
    <div className="card-grid">
      {kg.nodes.map((node) => (
        <article className="info-card" key={node.id}>
          <div className="card-title-row">
            <h3>{node.name}</h3>
            <span className="type-chip">{node.label}</span>
          </div>
          <p>{confidenceLabel(node.confidence)} · {node.confidence.toFixed(2)}</p>
          {node.evidence.length ? <blockquote>{node.evidence[0]}</blockquote> : null}
        </article>
      ))}
    </div>
  );
}

function EdgesList({ kg }: { kg: KgResult }) {
  const nodeById = new Map(kg.nodes.map((node) => [node.id, node.name]));
  if (kg.edges.length === 0) {
    return <EmptyState title="No potential relationships yet" body="Relationships are created from accepted model triples." />;
  }

  return (
    <div className="card-grid">
      {kg.edges.map((edge) => (
        <article className="info-card" key={edge.id}>
          <h3>{nodeById.get(edge.source) ?? edge.source}</h3>
          <p>
            <strong>{edge.label}</strong> {"->"} {nodeById.get(edge.target) ?? edge.target}
          </p>
          <p>{confidenceLabel(edge.confidence)} · {edge.confidence.toFixed(2)}</p>
          {edge.evidence.length ? <blockquote>{edge.evidence[0]}</blockquote> : null}
        </article>
      ))}
    </div>
  );
}

function SchemaView({
  schema,
  onAdd,
  onUpdate,
  onStatus,
  onDelete
}: {
  schema: SchemaSuggestion[];
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<SchemaSuggestion>) => void;
  onStatus: (id: string, status: ReviewStatus) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="schema-editor">
      <div className="schema-toolbar">
        <button type="button" className="secondary-button compact" onClick={onAdd}>
          <Plus size={15} />
          Schema pattern
        </button>
      </div>
      {schema.length === 0 ? (
        <EmptyState title="No schema patterns yet" body="Add optional reusable KG patterns before analyzing text." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Subject type</th>
                <th>Predicate</th>
                <th>Object type</th>
                <th>Confidence</th>
                <th>Evidence</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {schema.map((item) => (
                <tr key={item.id} className={`status-${item.status}`}>
                  <td>
                    <input
                      value={item.subject_type}
                      aria-label="Subject type"
                      onChange={(event) => onUpdate(item.id, { subject_type: event.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      value={item.predicate}
                      aria-label="Predicate"
                      onChange={(event) => onUpdate(item.id, { predicate: event.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      value={item.object_type}
                      aria-label="Object type"
                      onChange={(event) => onUpdate(item.id, { object_type: event.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      max="1"
                      step="0.01"
                      value={item.confidence}
                      aria-label="Confidence"
                      onChange={(event) => onUpdate(item.id, { confidence: event.target.valueAsNumber })}
                    />
                  </td>
                  <td>
                    <input
                      value={item.evidence}
                      aria-label="Evidence"
                      onChange={(event) => onUpdate(item.id, { evidence: event.target.value })}
                    />
                  </td>
                  <td>
                    <span className={`status-pill ${item.status}`}>{statusLabel(item.status)}</span>
                  </td>
                  <td>
                    <div className="action-row">
                      <button type="button" className="icon-button approve" onClick={() => onStatus(item.id, "approved")} title="Approve">
                        <Check size={16} />
                      </button>
                      <button type="button" className="icon-button reject" onClick={() => onStatus(item.id, "rejected")} title="Reject">
                        <X size={16} />
                      </button>
                      <button type="button" className="icon-button reject" onClick={() => onDelete(item.id)} title="Delete schema pattern">
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <XCircle size={28} />
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

function confidenceClass(confidence: number): string {
  if (confidence >= 0.8) {
    return "high";
  }
  if (confidence >= 0.55) {
    return "medium";
  }
  return "low";
}

function modelProviderLabel(provider: ModelProvider): string {
  return provider === "azure-openai" ? "Azure OpenAI GPT-5.2" : "local Ollama Gemma";
}

function mergeKgResults(current: KgResult, incoming: KgResult): { kg: KgResult; added: { nodes: number; edges: number; triples: number; schema: number } } {
  const nodes = [...current.nodes];
  const nodeIdByIncomingId = new Map<string, string>();
  const nodeKeyToId = new Map(nodes.map((node) => [normalizeKey(node.name), node.id]));
  let addedNodes = 0;

  for (const node of incoming.nodes) {
    const key = normalizeKey(node.name);
    const existingId = nodeKeyToId.get(key);
    if (existingId) {
      nodeIdByIncomingId.set(node.id, existingId);
      continue;
    }

    const id = uniqueNodeId(node.id, nodes);
    nodes.push({ ...node, id });
    nodeKeyToId.set(key, id);
    nodeIdByIncomingId.set(node.id, id);
    addedNodes += 1;
  }

  const triples = [...current.triples];
  const tripleKeys = new Set(triples.map((triple) => tripleKey(triple.subject, triple.predicate, triple.object)));
  let addedTriples = 0;
  for (const triple of incoming.triples) {
    const key = tripleKey(triple.subject, triple.predicate, triple.object);
    if (tripleKeys.has(key)) {
      continue;
    }
    triples.push({ ...triple, id: uniqueItemId(triple.id, triples) });
    tripleKeys.add(key);
    addedTriples += 1;
  }

  const edges = [...current.edges];
  const edgeKeys = new Set(edges.map((edge) => edgeKey(edge.source, edge.label, edge.target)));
  let addedEdges = 0;
  for (const edge of incoming.edges) {
    const source = nodeIdByIncomingId.get(edge.source) ?? edge.source;
    const target = nodeIdByIncomingId.get(edge.target) ?? edge.target;
    const key = edgeKey(source, edge.label, target);
    if (edgeKeys.has(key)) {
      continue;
    }
    edges.push({ ...edge, id: uniqueItemId(edge.id, edges), source, target });
    edgeKeys.add(key);
    addedEdges += 1;
  }

  const schema = [...current.schema];
  const schemaKeys = new Set(schema.map((item) => schemaKey(item.subject_type, item.predicate, item.object_type)));
  let addedSchema = 0;
  for (const item of incoming.schema) {
    const key = schemaKey(item.subject_type, item.predicate, item.object_type);
    if (schemaKeys.has(key)) {
      continue;
    }
    schema.push({ ...item, id: uniqueSchemaId(item.id, schema) });
    schemaKeys.add(key);
    addedSchema += 1;
  }

  return {
    kg: {
      nodes,
      edges,
      triples,
      schema,
      notes: incoming.notes || current.notes,
      generalizationLevel: incoming.generalizationLevel
    },
    added: { nodes: addedNodes, edges: addedEdges, triples: addedTriples, schema: addedSchema }
  };
}

function tripleKey(subject: string, predicate: string, object: string): string {
  return `${normalizeKey(subject)}|${normalizeKey(predicate)}|${normalizeKey(object)}`;
}

function edgeKey(source: string, label: string, target: string): string {
  return `${source}|${normalizeKey(label)}|${target}`;
}

function schemaKey(subjectType: string, predicate: string, objectType: string): string {
  return `${normalizeKey(subjectType)}|${normalizeKey(predicate)}|${normalizeKey(objectType)}`;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function clampConfidence(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
}

function stableId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 96) || "item"
  );
}

function uniqueNodeId(baseId: string, nodes: KgNode[]): string {
  return uniqueId(stableId(baseId), new Set(nodes.map((node) => node.id)));
}

function uniqueSchemaId(baseId: string, schema: SchemaSuggestion[]): string {
  return uniqueId(stableId(baseId), new Set(schema.map((item) => item.id)));
}

function uniqueItemId<T extends { id: string }>(baseId: string, items: T[]): string {
  return uniqueId(stableId(baseId), new Set(items.map((item) => item.id)));
}

function uniqueId(baseId: string, used: Set<string>): string {
  let candidate = baseId || "item";
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${baseId}_${index}`;
    index += 1;
  }
  return candidate;
}

function loadState(): SavedState {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return { sourceText: "", generalizationLevel: "medium", modelProvider: "ollama", graphLayout: {}, kg: emptyKgResult };
    }

    const parsed = JSON.parse(raw) as Partial<SavedState>;
    return {
      sourceText: parsed.sourceText ?? "",
      generalizationLevel: parsed.generalizationLevel ?? "medium",
      modelProvider: parsed.modelProvider === "azure-openai" ? "azure-openai" : "ollama",
      graphLayout: parsed.graphLayout && typeof parsed.graphLayout === "object" ? parsed.graphLayout : {},
      kg: parsed.kg?.triples && parsed.kg?.nodes && parsed.kg?.edges ? parsed.kg : emptyKgResult
    };
  } catch {
    return { sourceText: "", generalizationLevel: "medium", modelProvider: "ollama", graphLayout: {}, kg: emptyKgResult };
  }
}
