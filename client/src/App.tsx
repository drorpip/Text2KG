import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  Connection,
  Controls,
  Edge,
  MiniMap,
  Node,
  OnEdgesChange,
  OnNodesChange,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow
} from "reactflow";
import {
  Download,
  FileUp,
  GitBranchPlus,
  Plus,
  Save,
  Sparkles,
  Terminal,
  Trash2,
  Wand2
} from "lucide-react";
import { ApiLogEntry, expandGraph, makeLog, suggestGraph } from "./api";
import { emptyGraph, mergeGraphs, toFlowEdges, toFlowNodes, uniqueId } from "./graph";
import type { GraphNodeType, KnowledgeEdge, KnowledgeGraph, KnowledgeNode, Suggestion } from "./types";

const storageKey = "knowledge-graph-tool-state-v1";
const topicsStorageKey = "knowledge-graph-tool-topics-v1";
const nodeTypes: GraphNodeType[] = ["concept", "tool", "entity", "process", "source", "unknown"];

type SavedState = {
  currentTopicId?: string;
  topicName: string;
  sourceText: string;
  graph: KnowledgeGraph;
  suggestions: Suggestion[];
};

type SavedTopic = SavedState & {
  id: string;
  updatedAt: number;
};

export function App() {
  const initialState = loadState();
  const [currentTopicId, setCurrentTopicId] = useState(initialState.currentTopicId);
  const [topicName, setTopicName] = useState(initialState.topicName);
  const [savedTopics, setSavedTopics] = useState<SavedTopic[]>(() => loadTopics());
  const [sourceText, setSourceText] = useState(initialState.sourceText);
  const [graph, setGraph] = useState<KnowledgeGraph>(initialState.graph);
  const [flowNodes, setFlowNodes] = useState<Node[]>(() => toFlowNodes(initialState.graph.nodes));
  const [flowEdges, setFlowEdges] = useState<Edge[]>(() => toFlowEdges(initialState.graph.edges));
  const [suggestions, setSuggestions] = useState<Suggestion[]>(initialState.suggestions);
  const [selected, setSelected] = useState<{ type: "node" | "edge"; id: string } | null>(null);
  const [status, setStatus] = useState("Ready");
  const [isLoading, setIsLoading] = useState(false);
  const [logs, setLogs] = useState<ApiLogEntry[]>(() => [
    makeLog("info", "Diagnostics ready. Server logs are also printed in the dev terminal.")
  ]);
  const importRef = useRef<HTMLInputElement | null>(null);
  const reactFlow = useReactFlow();

  function addLog(entry: ApiLogEntry) {
    setLogs((items) => [entry, ...items].slice(0, 80));
  }

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify({ currentTopicId, topicName, sourceText, graph, suggestions }));
  }, [currentTopicId, topicName, sourceText, graph, suggestions]);

  useEffect(() => {
    localStorage.setItem(topicsStorageKey, JSON.stringify(savedTopics));
  }, [savedTopics]);

  useEffect(() => {
    setFlowNodes((current) => {
      const byId = new Map(current.map((node) => [node.id, node]));
      return toFlowNodes(graph.nodes).map((node) => ({
        ...node,
        position: byId.get(node.id)?.position ?? node.position,
        selected: selected?.type === "node" && selected.id === node.id
      }));
    });
    setFlowEdges(
      toFlowEdges(graph.edges).map((edge) => ({
        ...edge,
        selected: selected?.type === "edge" && selected.id === edge.id
      }))
    );
  }, [graph, selected]);

  const selectedNode = selected?.type === "node" ? graph.nodes.find((node) => node.id === selected.id) : undefined;
  const selectedEdge = selected?.type === "edge" ? graph.edges.find((edge) => edge.id === selected.id) : undefined;

  const graphStats = useMemo(
    () => `${graph.nodes.length} nodes / ${graph.edges.length} edges`,
    [graph.nodes.length, graph.edges.length]
  );

  const onNodesChange: OnNodesChange = (changes) => setFlowNodes((nodes) => applyNodeChanges(changes, nodes));
  const onEdgesChange: OnEdgesChange = (changes) => setFlowEdges((edges) => applyEdgeChanges(changes, edges));

  function syncNodePositions(nodes: Node[]) {
    setFlowNodes(nodes);
  }

  function onConnect(connection: Connection) {
    if (!connection.source || !connection.target || connection.source === connection.target) {
      return;
    }

    const id = uniqueId(`${connection.source}-relates-to-${connection.target}`, new Set(graph.edges.map((edge) => edge.id)));
    const edge: KnowledgeEdge = {
      id,
      source: connection.source,
      target: connection.target,
      label: "relates to"
    };

    setGraph((current) => ({ ...current, edges: [...current.edges, edge] }));
    setFlowEdges((edges) => addEdge({ ...edge, label: edge.label }, edges));
    setSelected({ type: "edge", id });
  }

  async function requestSuggestions() {
    setIsLoading(true);
    setStatus("Asking Ollama for graph suggestions...");
    addLog(makeLog("info", `Suggest graph clicked with ${sourceText.length} source chars and ${graph.nodes.length} existing nodes.`));
    try {
      const result = await suggestGraph(sourceText, graph, addLog);
      setSuggestions((items) => [{ ...result, createdAt: Date.now() }, ...items]);
      setStatus(`Received ${result.nodes.length} node and ${result.edges.length} edge suggestions.`);
      addLog(makeLog("info", `Suggestion queued: ${result.nodes.length} nodes, ${result.edges.length} edges.`));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Suggestion request failed.");
      addLog(makeLog("error", error instanceof Error ? error.message : "Suggestion request failed."));
    } finally {
      setIsLoading(false);
    }
  }

  async function requestExpansion() {
    setIsLoading(true);
    setStatus("Asking Ollama for expansion ideas...");
    addLog(makeLog("info", `Expand clicked with ${selected ? `${selected.type}:${selected.id}` : "whole graph"} selected.`));
    try {
      const selection =
        selectedNode ?? selectedEdge ?? { focus: "whole graph", sourceText: sourceText.slice(0, 2000) };
      const result = await expandGraph(selection, graph, addLog);
      setSuggestions((items) => [{ ...result, createdAt: Date.now() }, ...items]);
      setStatus(`Received ${result.nodes.length} expansion nodes and ${result.edges.length} edges.`);
      addLog(makeLog("info", `Expansion queued: ${result.nodes.length} nodes, ${result.edges.length} edges.`));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Expansion request failed.");
      addLog(makeLog("error", error instanceof Error ? error.message : "Expansion request failed."));
    } finally {
      setIsLoading(false);
    }
  }

  function acceptSuggestion(index: number) {
    const suggestion = suggestions[index];
    setGraph((current) => mergeGraphs(current, suggestion));
    setSuggestions((items) => items.filter((_, itemIndex) => itemIndex !== index));
    setStatus("Suggestion merged into the working graph.");
    addLog(makeLog("info", `Accepted proposal with ${suggestion.nodes.length} nodes and ${suggestion.edges.length} edges.`));
    window.requestAnimationFrame(() => reactFlow.fitView({ padding: 0.2, duration: 300 }));
  }

  function rejectSuggestion(index: number) {
    const suggestion = suggestions[index];
    setSuggestions((items) => items.filter((_, itemIndex) => itemIndex !== index));
    addLog(makeLog("info", `Rejected proposal with ${suggestion.nodes.length} nodes and ${suggestion.edges.length} edges.`));
  }

  function addNode() {
    const usedIds = new Set(graph.nodes.map((node) => node.id));
    const id = uniqueId("new-concept", usedIds);
    const node: KnowledgeNode = { id, label: "New concept", type: "concept" };
    setGraph((current) => ({ ...current, nodes: [...current.nodes, node] }));
    setSelected({ type: "node", id });
    addLog(makeLog("info", `Added node ${id}.`));
  }

  function saveTopic() {
    const now = Date.now();
    const name = topicName.trim() || inferTopicName(sourceText) || "Untitled topic";
    const id = currentTopicId ?? `topic-${now}`;
    const topic: SavedTopic = {
      id,
      updatedAt: now,
      currentTopicId: id,
      topicName: name,
      sourceText,
      graph,
      suggestions
    };

    setCurrentTopicId(id);
    setTopicName(name);
    setSavedTopics((topics) => [topic, ...topics.filter((item) => item.id !== id)].sort((a, b) => b.updatedAt - a.updatedAt));
    setStatus(`Saved "${name}".`);
    addLog(makeLog("info", `Saved topic ${name} with ${graph.nodes.length} nodes and ${graph.edges.length} edges.`));
  }

  function startNewTopic() {
    setCurrentTopicId(undefined);
    setTopicName("Untitled topic");
    setSourceText("");
    setGraph(emptyGraph);
    setSuggestions([]);
    setSelected(null);
    setStatus("Started a new topic.");
    addLog(makeLog("info", "Started a new topic workspace."));
  }

  function loadTopic(topicId: string) {
    const topic = savedTopics.find((item) => item.id === topicId);
    if (!topic) {
      return;
    }

    setCurrentTopicId(topic.id);
    setTopicName(topic.topicName);
    setSourceText(topic.sourceText);
    setGraph(topic.graph);
    setSuggestions(topic.suggestions);
    setSelected(null);
    setStatus(`Loaded "${topic.topicName}".`);
    addLog(makeLog("info", `Loaded topic ${topic.topicName}.`));
    window.requestAnimationFrame(() => reactFlow.fitView({ padding: 0.2, duration: 300 }));
  }

  function deleteTopic(topicId: string) {
    const topic = savedTopics.find((item) => item.id === topicId);
    if (!topic) {
      return;
    }

    const shouldDelete = window.confirm(`Delete saved topic "${topic.topicName}"? This only removes the local saved copy.`);
    if (!shouldDelete) {
      return;
    }

    setSavedTopics((topics) => topics.filter((item) => item.id !== topicId));
    if (currentTopicId === topicId) {
      startNewTopic();
    }
    setStatus(`Deleted "${topic.topicName}".`);
    addLog(makeLog("info", `Deleted saved topic ${topic.topicName}.`));
  }

  function deleteSelected() {
    if (!selected) {
      return;
    }

    if (selected.type === "node") {
      setGraph((current) => ({
        ...current,
        nodes: current.nodes.filter((node) => node.id !== selected.id),
        edges: current.edges.filter((edge) => edge.source !== selected.id && edge.target !== selected.id)
      }));
    } else {
      setGraph((current) => ({
        ...current,
        edges: current.edges.filter((edge) => edge.id !== selected.id)
      }));
    }

    setSelected(null);
    addLog(makeLog("info", `Deleted selected ${selected.type} ${selected.id}.`));
  }

  function updateNode(id: string, patch: Partial<KnowledgeNode>) {
    setGraph((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node))
    }));
  }

  function updateEdge(id: string, patch: Partial<KnowledgeEdge>) {
    setGraph((current) => ({
      ...current,
      edges: current.edges.map((edge) => (edge.id === id ? { ...edge, ...patch } : edge))
    }));
  }

  function mergeNodeIntoTarget(sourceId: string, targetId: string) {
    if (!sourceId || !targetId || sourceId === targetId) {
      return;
    }

    setGraph((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => node.id !== sourceId),
      edges: dedupeEdges(
        current.edges
          .filter((edge) => edge.id !== sourceId)
          .map((edge) => ({
            ...edge,
            source: edge.source === sourceId ? targetId : edge.source,
            target: edge.target === sourceId ? targetId : edge.target
          }))
          .filter((edge) => edge.source !== edge.target)
      )
    }));
    setSelected({ type: "node", id: targetId });
    addLog(makeLog("info", `Merged node ${sourceId} into ${targetId}.`));
  }

  function exportGraph() {
    const blob = new Blob([JSON.stringify({ sourceText, graph }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "knowledge-graph.json";
    link.click();
    URL.revokeObjectURL(url);
    addLog(makeLog("info", `Exported graph with ${graph.nodes.length} nodes and ${graph.edges.length} edges.`));
  }

  function importGraph(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const nextGraph = parsed.graph ?? parsed;
        if (!Array.isArray(nextGraph.nodes) || !Array.isArray(nextGraph.edges)) {
          throw new Error("Imported file does not contain graph nodes and edges.");
        }
        setGraph(nextGraph);
        setSourceText(typeof parsed.sourceText === "string" ? parsed.sourceText : sourceText);
        setSuggestions([]);
        setSelected(null);
        setStatus("Graph imported.");
        addLog(makeLog("info", `Imported graph with ${nextGraph.nodes.length} nodes and ${nextGraph.edges.length} edges.`));
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Could not import graph.");
        addLog(makeLog("error", error instanceof Error ? error.message : "Could not import graph."));
      } finally {
        event.target.value = "";
      }
    };
    reader.readAsText(file);
  }

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div>
          <h1>Knowledge Graph Workspace</h1>
          <p>{graphStats}</p>
        </div>
        <div className="toolbar">
          <button type="button" onClick={addNode} title="Add node">
            <Plus size={18} />
          </button>
          <button type="button" onClick={deleteSelected} disabled={!selected} title="Delete selected">
            <Trash2 size={18} />
          </button>
          <button type="button" onClick={() => importRef.current?.click()} title="Import JSON">
            <FileUp size={18} />
          </button>
          <button type="button" onClick={exportGraph} title="Export JSON">
            <Download size={18} />
          </button>
          <input ref={importRef} type="file" accept="application/json" hidden onChange={importGraph} />
        </div>
      </header>

      <main className="workspace">
        <section className="source-panel">
          <TopicManager
            topicName={topicName}
            currentTopicId={currentTopicId}
            savedTopics={savedTopics}
            onTopicNameChange={setTopicName}
            onSave={saveTopic}
            onNew={startNewTopic}
            onLoad={loadTopic}
            onDelete={deleteTopic}
          />
          <textarea
            value={sourceText}
            onChange={(event) => setSourceText(event.target.value)}
            placeholder="Paste source text here..."
          />
          <div className="source-actions">
            <button type="button" onClick={requestSuggestions} disabled={isLoading || !sourceText.trim()}>
              <Sparkles size={17} />
              Suggest graph
            </button>
            <button type="button" onClick={requestExpansion} disabled={isLoading || graph.nodes.length === 0}>
              <Wand2 size={17} />
              Expand
            </button>
          </div>
          <p className="status">{status}</p>
        </section>

        <section className="canvas-panel">
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodesDelete={() => syncNodePositions(flowNodes)}
            onNodeDragStop={(_, __, nodes) => syncNodePositions(nodes)}
            onConnect={onConnect}
            onNodeClick={(_, node) => setSelected({ type: "node", id: node.id })}
            onEdgeClick={(_, edge) => setSelected({ type: "edge", id: edge.id })}
            onPaneClick={() => setSelected(null)}
            fitView
          >
            <Background gap={18} size={1} color="#d7dee8" />
            <Controls />
            <MiniMap pannable zoomable nodeStrokeWidth={3} />
          </ReactFlow>
        </section>

        <aside className="inspector">
          <Inspector
            graph={graph}
            selectedNode={selectedNode}
            selectedEdge={selectedEdge}
            onUpdateNode={updateNode}
            onUpdateEdge={updateEdge}
            onMergeNode={mergeNodeIntoTarget}
          />
          <SuggestionQueue suggestions={suggestions} onAccept={acceptSuggestion} onReject={rejectSuggestion} />
          <Diagnostics logs={logs} onClear={() => setLogs([makeLog("info", "Diagnostics cleared.")])} />
        </aside>
      </main>
    </div>
  );
}

function Diagnostics({ logs, onClear }: { logs: ApiLogEntry[]; onClear: () => void }) {
  return (
    <section className="panel-block diagnostics-block">
      <div className="panel-title-row">
        <h2>
          <Terminal size={16} />
          Diagnostics
        </h2>
        <button type="button" onClick={onClear}>
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
  );
}

function TopicManager({
  topicName,
  currentTopicId,
  savedTopics,
  onTopicNameChange,
  onSave,
  onNew,
  onLoad,
  onDelete
}: {
  topicName: string;
  currentTopicId?: string;
  savedTopics: SavedTopic[];
  onTopicNameChange: (value: string) => void;
  onSave: () => void;
  onNew: () => void;
  onLoad: (topicId: string) => void;
  onDelete: (topicId: string) => void;
}) {
  return (
    <section className="topic-manager">
      <label>
        Topic
        <input value={topicName} onChange={(event) => onTopicNameChange(event.target.value)} placeholder="Name this exploration" />
      </label>
      <div className="topic-actions">
        <button type="button" onClick={onSave}>
          <Save size={16} />
          Save
        </button>
        <button type="button" onClick={onNew}>
          <Plus size={16} />
          New
        </button>
      </div>
      <div className="saved-topic-list">
        {savedTopics.length === 0 ? (
          <p className="muted">No saved topics yet.</p>
        ) : (
          savedTopics.map((topic) => (
            <article className={topic.id === currentTopicId ? "saved-topic active" : "saved-topic"} key={topic.id}>
              <button type="button" className="saved-topic-main" onClick={() => onLoad(topic.id)}>
                <strong>{topic.topicName}</strong>
                <span>
                  {topic.graph.nodes.length} nodes / {topic.graph.edges.length} edges
                </span>
              </button>
              <button type="button" className="saved-topic-delete" onClick={() => onDelete(topic.id)} title="Delete saved topic">
                <Trash2 size={15} />
              </button>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function Inspector({
  graph,
  selectedNode,
  selectedEdge,
  onUpdateNode,
  onUpdateEdge,
  onMergeNode
}: {
  graph: KnowledgeGraph;
  selectedNode?: KnowledgeNode;
  selectedEdge?: KnowledgeEdge;
  onUpdateNode: (id: string, patch: Partial<KnowledgeNode>) => void;
  onUpdateEdge: (id: string, patch: Partial<KnowledgeEdge>) => void;
  onMergeNode: (sourceId: string, targetId: string) => void;
}) {
  if (selectedNode) {
    return (
      <section className="panel-block">
        <h2>Node</h2>
        <label>
          Label
          <input value={selectedNode.label} onChange={(event) => onUpdateNode(selectedNode.id, { label: event.target.value })} />
        </label>
        <label>
          Type
          <select
            value={selectedNode.type}
            onChange={(event) => onUpdateNode(selectedNode.id, { type: event.target.value as GraphNodeType })}
          >
            {nodeTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label>
          Description
          <textarea
            value={selectedNode.description ?? ""}
            onChange={(event) => onUpdateNode(selectedNode.id, { description: event.target.value })}
          />
        </label>
        <label>
          Source
          <input value={selectedNode.source ?? ""} onChange={(event) => onUpdateNode(selectedNode.id, { source: event.target.value })} />
        </label>
        <label>
          Merge into
          <select defaultValue="" onChange={(event) => onMergeNode(selectedNode.id, event.target.value)}>
            <option value="" disabled>
              Select target
            </option>
            {graph.nodes
              .filter((node) => node.id !== selectedNode.id)
              .map((node) => (
                <option key={node.id} value={node.id}>
                  {node.label}
                </option>
              ))}
          </select>
        </label>
      </section>
    );
  }

  if (selectedEdge) {
    return (
      <section className="panel-block">
        <h2>Relationship</h2>
        <label>
          Label
          <input value={selectedEdge.label} onChange={(event) => onUpdateEdge(selectedEdge.id, { label: event.target.value })} />
        </label>
        <label>
          Source
          <select value={selectedEdge.source} onChange={(event) => onUpdateEdge(selectedEdge.id, { source: event.target.value })}>
            {graph.nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Target
          <select value={selectedEdge.target} onChange={(event) => onUpdateEdge(selectedEdge.id, { target: event.target.value })}>
            {graph.nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Description
          <textarea
            value={selectedEdge.description ?? ""}
            onChange={(event) => onUpdateEdge(selectedEdge.id, { description: event.target.value })}
          />
        </label>
      </section>
    );
  }

  return (
    <section className="panel-block empty-selection">
      <GitBranchPlus size={28} />
      <h2>No selection</h2>
      <p>Select a node or relationship to edit its hypothesis details.</p>
    </section>
  );
}

function SuggestionQueue({
  suggestions,
  onAccept,
  onReject
}: {
  suggestions: Suggestion[];
  onAccept: (index: number) => void;
  onReject: (index: number) => void;
}) {
  return (
    <section className="panel-block suggestion-block">
      <h2>AI proposals</h2>
      {suggestions.length === 0 ? (
        <p className="muted">No pending proposals.</p>
      ) : (
        suggestions.map((suggestion, index) => (
          <article className="suggestion" key={`${suggestion.createdAt}-${index}`}>
            <strong>
              {suggestion.nodes.length} nodes, {suggestion.edges.length} edges
            </strong>
            {suggestion.notes ? <p>{suggestion.notes}</p> : null}
            <div className="suggestion-preview">
              {suggestion.nodes.slice(0, 5).map((node) => (
                <span key={node.id}>{node.label}</span>
              ))}
            </div>
            <div className="proposal-actions">
              <button type="button" onClick={() => onAccept(index)}>
                Accept
              </button>
              <button type="button" onClick={() => onReject(index)}>
                Reject
              </button>
            </div>
          </article>
        ))
      )}
    </section>
  );
}

function loadState(): SavedState {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return { topicName: "Untitled topic", sourceText: "", graph: emptyGraph, suggestions: [] };
    }

    const parsed = JSON.parse(raw) as Partial<SavedState>;
    return {
      currentTopicId: parsed.currentTopicId,
      topicName: parsed.topicName ?? "Untitled topic",
      sourceText: parsed.sourceText ?? "",
      graph: parsed.graph?.nodes && parsed.graph?.edges ? parsed.graph : emptyGraph,
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : []
    };
  } catch {
    return { topicName: "Untitled topic", sourceText: "", graph: emptyGraph, suggestions: [] };
  }
}

function loadTopics(): SavedTopic[] {
  try {
    const raw = localStorage.getItem(topicsStorageKey);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as SavedTopic[];
    return Array.isArray(parsed)
      ? parsed
          .filter((topic) => topic.id && topic.topicName && topic.graph?.nodes && topic.graph?.edges)
          .sort((a, b) => b.updatedAt - a.updatedAt)
      : [];
  } catch {
    return [];
  }
}

function inferTopicName(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 48) ?? "";
}

function dedupeEdges(edges: KnowledgeEdge[]): KnowledgeEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.source}:${edge.target}:${edge.label.toLowerCase()}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
