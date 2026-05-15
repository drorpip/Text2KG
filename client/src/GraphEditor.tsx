import { useCallback, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type OnConnect,
  type ReactFlowInstance
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Focus, Link, Plus, Trash2 } from "lucide-react";
import type { KgEdge, KgNode, KgResult, KgTriple } from "./types";

export type GraphLayout = Record<string, { x: number; y: number }>;

type SelectedGraphItem =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | null;

type GraphEditorProps = {
  kg: KgResult;
  layout: GraphLayout;
  onLayoutChange: (layout: GraphLayout | ((current: GraphLayout) => GraphLayout)) => void;
  onKgChange: (kg: KgResult | ((current: KgResult) => KgResult)) => void;
  onStatus: (message: string) => void;
};

export function GraphEditor({ kg, layout, onLayoutChange, onKgChange, onStatus }: GraphEditorProps) {
  const [selected, setSelected] = useState<SelectedGraphItem>(null);
  const flowRef = useRef<ReactFlowInstance | null>(null);

  const flowNodes = useMemo<Node[]>(() => kg.nodes.map((node, index) => kgNodeToFlowNode(node, layout, index)), [kg.nodes, layout]);
  const flowEdges = useMemo<Edge[]>(() => kg.edges.map(kgEdgeToFlowEdge), [kg.edges]);
  const selectedNode = selected?.kind === "node" ? kg.nodes.find((node) => node.id === selected.id) ?? null : null;
  const selectedEdge = selected?.kind === "edge" ? kg.edges.find((edge) => edge.id === selected.id) ?? null : null;
  const nodeById = useMemo(() => new Map(kg.nodes.map((node) => [node.id, node])), [kg.nodes]);

  const onNodeClick: NodeMouseHandler = useCallback((_event, node) => setSelected({ kind: "node", id: node.id }), []);
  const onEdgeClick = useCallback((_event: React.MouseEvent, edge: Edge) => setSelected({ kind: "edge", id: edge.id }), []);
  const onPaneClick = useCallback(() => setSelected(null), []);

  const onNodeDragStop: NodeMouseHandler = useCallback(
    (_event, node) => {
      onLayoutChange((current) => ({ ...current, [node.id]: node.position }));
    },
    [onLayoutChange]
  );

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) {
        return;
      }

      onKgChange((current) => addKgEdge(current, connection.source!, connection.target!, "related_to"));
      setSelected(null);
      onStatus("Added graph relationship.");
    },
    [onKgChange, onStatus]
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const removed = changes.filter((change) => change.type === "remove").map((change) => change.id);
      const moved = changes.filter((change) => change.type === "position" && change.position);

      if (moved.length) {
        onLayoutChange((current) => {
          const next = { ...current };
          for (const change of moved) {
            if (change.type === "position" && change.position) {
              next[change.id] = change.position;
            }
          }
          return next;
        });
      }

      if (removed.length) {
        onKgChange((current) => {
          let next = current;
          for (const nodeId of removed) {
            const node = next.nodes.find((item) => item.id === nodeId);
            if (node) {
              next = deleteKgNode(next, node);
            }
          }
          return next;
        });
        setSelected(null);
      }
    },
    [onKgChange, onLayoutChange]
  );

  function addNode() {
    const nextIndex = kg.nodes.length + 1;
    const id = uniqueNodeId(`node_new_entity_${nextIndex}`, kg.nodes);
    const viewport = flowRef.current?.getViewport();
    const position = {
      x: viewport ? -viewport.x / viewport.zoom + 80 : 80,
      y: viewport ? -viewport.y / viewport.zoom + 80 : 80
    };

    onKgChange((current) => ({
      ...current,
      nodes: [
        ...current.nodes,
        {
          id,
          name: `New Entity ${nextIndex}`,
          label: "Entity",
          properties: {},
          confidence: 0.5,
          evidence: [],
          status: "edited"
        }
      ]
    }));
    onLayoutChange((current) => ({ ...current, [id]: position }));
    setSelected({ kind: "node", id });
    onStatus("Added graph node.");
  }

  function deleteSelected() {
    if (!selected) {
      return;
    }

    if (selected.kind === "node") {
      const node = kg.nodes.find((item) => item.id === selected.id);
      if (!node) {
        return;
      }
      onKgChange((current) => deleteKgNode(current, node));
      onLayoutChange((current) => {
        const next = { ...current };
        delete next[selected.id];
        return next;
      });
      onStatus("Deleted graph node and related triples.");
    } else {
      onKgChange((current) => deleteKgEdge(current, selected.id));
      onStatus("Deleted graph relationship.");
    }

    setSelected(null);
  }

  function renameNode(nodeId: string, nextName: string) {
    onKgChange((current) => renameKgNode(current, nodeId, nextName));
  }

  function relabelEdge(edgeId: string, nextLabel: string) {
    onKgChange((current) => relabelKgEdge(current, edgeId, nextLabel));
  }

  return (
    <div className="graph-editor">
      <div className="graph-toolbar">
        <button type="button" className="secondary-button compact" onClick={addNode}>
          <Plus size={15} />
          Node
        </button>
        <button type="button" className="secondary-button compact" onClick={deleteSelected} disabled={!selected}>
          <Trash2 size={15} />
          Delete
        </button>
        <button type="button" className="secondary-button compact" onClick={() => flowRef.current?.fitView({ padding: 0.2 })}>
          <Focus size={15} />
          Fit
        </button>
      </div>

      <div className="graph-canvas">
        {kg.nodes.length ? (
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            onConnect={onConnect}
            onNodesChange={onNodesChange}
            onEdgesChange={(changes) => {
              const removed = changes.filter((change) => change.type === "remove").map((change) => change.id);
              if (removed.length) {
                onKgChange((current) => removed.reduce((next, id) => deleteKgEdge(next, id), current));
              }
            }}
            onEdgeClick={onEdgeClick}
            onNodeClick={onNodeClick}
            onNodeDragStop={onNodeDragStop}
            onPaneClick={onPaneClick}
            onInit={(instance) => {
              flowRef.current = instance;
            }}
            fitView
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable nodeStrokeWidth={3} />
          </ReactFlow>
        ) : (
          <div className="empty-state graph-empty">
            <Link size={28} />
            <h3>No graph yet</h3>
            <p>Analyze text or import a GraphML file to start editing.</p>
          </div>
        )}
      </div>

      <aside className="graph-details">
        {selectedNode ? (
          <SelectedNodeDetails node={selectedNode} onRename={(name) => renameNode(selectedNode.id, name)} />
        ) : null}
        {selectedEdge ? (
          <SelectedEdgeDetails
            edge={selectedEdge}
            sourceName={nodeById.get(selectedEdge.source)?.name ?? selectedEdge.source}
            targetName={nodeById.get(selectedEdge.target)?.name ?? selectedEdge.target}
            onRelabel={(label) => relabelEdge(selectedEdge.id, label)}
          />
        ) : null}
        {!selected ? <p className="muted">Select a node or relationship to edit its graph label.</p> : null}
      </aside>
    </div>
  );
}

function SelectedNodeDetails({ node, onRename }: { node: KgNode; onRename: (name: string) => void }) {
  return (
    <div className="graph-detail-card">
      <h3>Selected node</h3>
      <label className="field">
        Name
        <input value={node.name} onChange={(event) => onRename(event.target.value)} />
      </label>
      <p>
        <span className="type-chip">{node.label}</span>
      </p>
    </div>
  );
}

function SelectedEdgeDetails({
  edge,
  sourceName,
  targetName,
  onRelabel
}: {
  edge: KgEdge;
  sourceName: string;
  targetName: string;
  onRelabel: (label: string) => void;
}) {
  return (
    <div className="graph-detail-card">
      <h3>Selected relationship</h3>
      <p className="muted">
        {sourceName} {"->"} {targetName}
      </p>
      <label className="field">
        Predicate
        <input value={edge.label} onChange={(event) => onRelabel(event.target.value)} />
      </label>
    </div>
  );
}

function kgNodeToFlowNode(node: KgNode, layout: GraphLayout, index: number): Node {
  return {
    id: node.id,
    position: layout[node.id] ?? defaultPosition(index),
    data: {
      label: `${node.name}\n${node.label}`
    },
    className: `kg-flow-node status-${node.status}`
  };
}

function kgEdgeToFlowEdge(edge: KgEdge): Edge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    animated: edge.status === "needs_review",
    className: `kg-flow-edge status-${edge.status}`
  };
}

function defaultPosition(index: number): { x: number; y: number } {
  const columns = 4;
  return {
    x: (index % columns) * 210,
    y: Math.floor(index / columns) * 130
  };
}

function addKgEdge(kg: KgResult, sourceId: string, targetId: string, label: string): KgResult {
  const source = kg.nodes.find((node) => node.id === sourceId);
  const target = kg.nodes.find((node) => node.id === targetId);
  if (!source || !target) {
    return kg;
  }

  const edge: KgEdge = {
    id: uniqueEdgeId(stableId(`edge-${sourceId}-${label}-${targetId}`), kg.edges),
    source: sourceId,
    target: targetId,
    label,
    properties: {},
    confidence: 0.5,
    evidence: [],
    status: "edited"
  };

  return {
    ...kg,
    edges: [...kg.edges, edge],
    triples: [...kg.triples, tripleFromEdge(edge, source, target)],
    nodes: kg.nodes
  };
}

function deleteKgNode(kg: KgResult, node: KgNode): KgResult {
  const connectedEdges = kg.edges.filter((edge) => edge.source === node.id || edge.target === node.id);
  const connectedKeys = new Set(connectedEdges.map((edge) => tripleKeyForEdge(edge, kg.nodes)));

  return {
    ...kg,
    nodes: kg.nodes.filter((item) => item.id !== node.id),
    edges: kg.edges.filter((edge) => edge.source !== node.id && edge.target !== node.id),
    triples: kg.triples.filter(
      (triple) =>
        triple.subject !== node.name &&
        triple.object !== node.name &&
        !connectedKeys.has(tripleKey(triple.subject, triple.predicate, triple.object))
    )
  };
}

function deleteKgEdge(kg: KgResult, edgeId: string): KgResult {
  const edge = kg.edges.find((item) => item.id === edgeId);
  if (!edge) {
    return kg;
  }
  const key = tripleKeyForEdge(edge, kg.nodes);
  return {
    ...kg,
    edges: kg.edges.filter((item) => item.id !== edgeId),
    triples: kg.triples.filter((triple) => tripleKey(triple.subject, triple.predicate, triple.object) !== key)
  };
}

function renameKgNode(kg: KgResult, nodeId: string, nextName: string): KgResult {
  const cleanName = nextName.trimStart();
  const node = kg.nodes.find((item) => item.id === nodeId);
  if (!node) {
    return kg;
  }

  return {
    ...kg,
    nodes: kg.nodes.map((item) => (item.id === nodeId ? { ...item, name: cleanName, status: "edited" } : item)),
    triples: kg.triples.map((triple) => ({
      ...triple,
      subject: triple.subject === node.name ? cleanName : triple.subject,
      object: triple.object === node.name ? cleanName : triple.object,
      status: triple.subject === node.name || triple.object === node.name ? "edited" : triple.status
    }))
  };
}

function relabelKgEdge(kg: KgResult, edgeId: string, nextLabel: string): KgResult {
  const cleanLabel = nextLabel.trimStart().replace(/\s+/g, " ");
  const edge = kg.edges.find((item) => item.id === edgeId);
  if (!edge) {
    return kg;
  }
  const oldKey = tripleKeyForEdge(edge, kg.nodes);
  const source = kg.nodes.find((node) => node.id === edge.source);
  const target = kg.nodes.find((node) => node.id === edge.target);

  return {
    ...kg,
    edges: kg.edges.map((item) => (item.id === edgeId ? { ...item, label: cleanLabel, status: "edited" } : item)),
    triples: kg.triples.map((triple) =>
      tripleKey(triple.subject, triple.predicate, triple.object) === oldKey
        ? {
            ...triple,
            predicate: cleanLabel,
            subject: source?.name ?? triple.subject,
            object: target?.name ?? triple.object,
            status: "edited"
          }
        : triple
    )
  };
}

function tripleFromEdge(edge: KgEdge, source: KgNode, target: KgNode): KgTriple {
  return {
    id: stableId(`triple-${source.name}-${edge.label}-${target.name}`),
    subject: source.name,
    predicate: edge.label,
    object: target.name,
    subject_type: source.label || "Entity",
    object_type: target.label || "Entity",
    confidence: edge.confidence,
    evidence: edge.evidence[0] ?? "",
    status: edge.status
  };
}

function tripleKeyForEdge(edge: KgEdge, nodes: KgNode[]): string {
  const source = nodes.find((node) => node.id === edge.source);
  const target = nodes.find((node) => node.id === edge.target);
  return tripleKey(source?.name ?? edge.source, edge.label, target?.name ?? edge.target);
}

function tripleKey(subject: string, predicate: string, object: string): string {
  return `${subject.trim().toLowerCase()}|${predicate.trim().toLowerCase()}|${object.trim().toLowerCase()}`;
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
  const used = new Set(nodes.map((node) => node.id));
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
  let candidate = baseId;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${baseId}_${index}`;
    index += 1;
  }
  return candidate;
}
