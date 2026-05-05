import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Download,
  FileText,
  Pencil,
  RefreshCcw,
  TableProperties,
  Trash2,
  X,
  XCircle
} from "lucide-react";
import { ApiLogEntry, analyzeText, exportGraphMl, makeLog } from "./api";
import { confidenceLabel, emptyKgResult, filenameFromText, reviewedTriples, statusLabel } from "./graph";
import type { GeneralizationLevel, KgResult, KgTriple, ReviewStatus } from "./types";

const storageKey = "text2kg-state-v1";

type SavedState = {
  sourceText: string;
  generalizationLevel: GeneralizationLevel;
  kg: KgResult;
};

type ActiveView = "triples" | "nodes" | "edges" | "schema";

export function App() {
  const initialState = loadState();
  const [sourceText, setSourceText] = useState(initialState.sourceText);
  const [generalizationLevel, setGeneralizationLevel] = useState<GeneralizationLevel>(initialState.generalizationLevel);
  const [kg, setKg] = useState<KgResult>(initialState.kg);
  const [activeView, setActiveView] = useState<ActiveView>("triples");
  const [editingTripleId, setEditingTripleId] = useState<string | null>(null);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [approvedOnlyExport, setApprovedOnlyExport] = useState(false);
  const [logs, setLogs] = useState<ApiLogEntry[]>(() => [
    makeLog("info", "Text2KG diagnostics ready. Backend logs are printed in the dev terminal.")
  ]);

  function addLog(entry: ApiLogEntry) {
    setLogs((items) => [entry, ...items].slice(0, 80));
  }

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify({ sourceText, generalizationLevel, kg }));
  }, [sourceText, generalizationLevel, kg]);

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
    setIsLoading(true);
    setError("");
    setStatus("Analyzing text with local Ollama...");
    addLog(makeLog("info", `Analyze clicked with ${sourceText.length} source chars.`));

    try {
      const result = await analyzeText(sourceText, generalizationLevel, addLog);
      setKg(result);
      setActiveView("triples");
      setEditingTripleId(null);
      setStatus(`Detected ${result.triples.length} suggested triples from ${result.nodes.length} possible nodes.`);
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
    setKg((current) => ({
      ...current,
      triples: current.triples.map((triple) =>
        triple.id === id ? { ...triple, ...patch, status: patch.status ?? "edited" } : triple
      )
    }));
  }

  function setTripleStatus(id: string, nextStatus: ReviewStatus) {
    setKg((current) => ({
      ...current,
      triples: current.triples.map((triple) => (triple.id === id ? { ...triple, status: nextStatus } : triple))
    }));
  }

  function deleteTriple(id: string) {
    setKg((current) => ({
      ...current,
      triples: current.triples.map((triple) => (triple.id === id ? { ...triple, status: "rejected" } : triple))
    }));
    setEditingTripleId(null);
  }

  function resetWorkspace() {
    setSourceText("");
    setGeneralizationLevel("medium");
    setKg(emptyKgResult);
    setEditingTripleId(null);
    setError("");
    setStatus("Ready");
    addLog(makeLog("info", "Workspace cleared."));
  }

  async function downloadGraphMl() {
    setIsLoading(true);
    setError("");
    try {
      const graphml = await exportGraphMl(kg, approvedOnlyExport, addLog);
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
            {activeView === "schema" ? <SchemaView kg={kg} /> : null}
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

function SchemaView({ kg }: { kg: KgResult }) {
  if (kg.schema.length === 0) {
    return <EmptyState title="No schema suggestions yet" body="Use medium or high generalization to request reusable KG patterns." />;
  }

  return (
    <div className="schema-list">
      {kg.schema.map((schema) => (
        <article className="schema-row" key={schema.id}>
          <span>{schema.subject_type}</span>
          <strong>{schema.predicate}</strong>
          <span>{schema.object_type}</span>
          <em>{schema.confidence.toFixed(2)}</em>
        </article>
      ))}
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

function loadState(): SavedState {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return { sourceText: "", generalizationLevel: "medium", kg: emptyKgResult };
    }

    const parsed = JSON.parse(raw) as Partial<SavedState>;
    return {
      sourceText: parsed.sourceText ?? "",
      generalizationLevel: parsed.generalizationLevel ?? "medium",
      kg: parsed.kg?.triples && parsed.kg?.nodes && parsed.kg?.edges ? parsed.kg : emptyKgResult
    };
  } catch {
    return { sourceText: "", generalizationLevel: "medium", kg: emptyKgResult };
  }
}
