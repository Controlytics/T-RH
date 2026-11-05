import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import {
  Background, BackgroundVariant, Controls, MarkerType, MiniMap, ReactFlow, ReactFlowProvider,
  applyEdgeChanges, applyNodeChanges, useNodesInitialized, useReactFlow,
  type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type OnConnect,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './rule-chains.css';
import type { RuleChainDocument } from '@digilog/shared';
import {
  buildFlowEdges, buildFlowNodes, removalOf, startView,
  type ChainFlowNode, type PairEdge, type PairEdgeData, type RuleNodeData,
} from './flow-mapping';
import { NODE_TYPES } from './node-card';
import { DRAG_MIME } from './palette';
import { INPUT_NODE_ID, RULE_GROUP_COLORS, RULE_UNSUPPORTED_COLOR, RULE_INPUT_COLOR } from './types';

/**
 * The rule chain canvas (rule chains, 2026-11-04; spec section 11, ruling
 * W-1: `@xyflow/react`). It DRAWS the draft and REPORTS edits; it owns none.
 *
 * React Flow's own node and edge state (selection, measured sizes, the
 * position while a drag is in flight) stays here, apart from the document: it
 * changes on every pointer move and every measurement, and only a drag's END,
 * a drop, a connection and a Delete are edits the page records (one undo step
 * each). See `flow-mapping.ts` for how the document is drawn.
 */

export interface CanvasApi {
  /** The flow position at the middle of the visible canvas — where a palette click places a node. */
  centre: () => { x: number; y: number };
}

export interface CanvasProps {
  document: RuleChainDocument;
  canEdit: boolean;
  inspectedId?: string | null;
  apiRef?: MutableRefObject<CanvasApi | null>;
  onAddNode: (type: string, pos: { x: number; y: number }) => void;
  onMoveNodes: (moves: { id: string; x: number; y: number }[]) => void;
  onRemove: (what: { nodeIds: string[]; pairs: { from: string; to: string }[]; input: boolean }) => void;
  /** A link drawn from `from` to `to` (from may be the Input). The page decides what it becomes. */
  onConnect: (from: string, to: string) => void;
  onEditEdge: (from: string, to: string) => void;
  onOpenNode: (id: string) => void;
  onSelectNode: (id: string | null) => void;
}

const FIT_OPTIONS = { padding: 0.12, maxZoom: 1 };

const DEFAULT_EDGE_OPTIONS = {
  markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: '#64748b' },
  labelBgPadding: [6, 3] as [number, number],
  labelBgBorderRadius: 4,
};

function minimapColour(n: Node): string {
  if (n.id === INPUT_NODE_ID) return RULE_INPUT_COLOR;
  const d = n.data as RuleNodeData;
  return d.supported && d.spec ? RULE_GROUP_COLORS[d.spec.group] : RULE_UNSUPPORTED_COLOR;
}

function Flow(props: CanvasProps) {
  const { document: doc, canEdit, inspectedId = null } = props;
  const rf = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<ChainFlowNode[]>(() => buildFlowNodes(doc, [], { canEdit, inspectedId }));
  const [edges, setEdges] = useState<PairEdge[]>(() => buildFlowEdges(doc, [], canEdit));

  // The document is the source of truth: redraw from it whenever it changes,
  // carrying over what React Flow measured and selected.
  useEffect(() => {
    setNodes((prev) => buildFlowNodes(doc, prev, { canEdit, inspectedId }));
    setEdges((prev) => buildFlowEdges(doc, prev, canEdit));
  }, [doc, canEdit, inspectedId]);

  useEffect(() => {
    if (!props.apiRef) return;
    props.apiRef.current = {
      centre: () => {
        const r = wrapper.current?.getBoundingClientRect();
        if (!r) return { x: 0, y: 0 };
        return rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      },
    };
    return () => { if (props.apiRef) props.apiRef.current = null; };
  }, [props.apiRef, rf]);

  // The FIRST view, once React Flow has measured the nodes (`startView`): React
  // Flow's own fitView when the chain fits at a readable zoom, else the Input
  // in view. The Controls' fit button still shows the whole chain at any zoom.
  const initialized = useNodesInitialized();
  const placed = useRef(false);
  useEffect(() => {
    if (!initialized || placed.current) return;
    placed.current = true;
    const r = wrapper.current?.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return;
    const view = startView(rf.getNodesBounds(rf.getNodes()), { width: r.width, height: r.height });
    if (view.kind === 'fit') void rf.fitView(FIT_OPTIONS);
    else void rf.setViewport(view.viewport);
  }, [initialized, rf]);

  const onNodesChange = useCallback((changes: NodeChange<ChainFlowNode>[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns));
  }, []);
  const onEdgesChange = useCallback((changes: EdgeChange<PairEdge>[]) => {
    setEdges((es) => applyEdgeChanges(changes, es));
  }, []);

  const { onConnect: reportConnect, onMoveNodes, onRemove, onAddNode, onEditEdge, onOpenNode, onSelectNode } = props;

  const onConnect: OnConnect = useCallback((c: Connection) => {
    if (c.source && c.target) reportConnect(c.source, c.target);
  }, [reportConnect]);

  const isValidConnection = useCallback((c: Connection | Edge) =>
    c.source !== c.target && c.target !== INPUT_NODE_ID, []);

  return (
    <div
      ref={wrapper}
      className="rc-canvas h-full w-full"
      onDragOver={(e) => {
        if (!canEdit) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(e) => {
        if (!canEdit) return;
        const type = e.dataTransfer.getData(DRAG_MIME);
        if (!type) return;
        e.preventDefault();
        onAddNode(type, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
      }}
      data-testid="rule-chain-canvas"
      // Enter on a FOCUSED node opens its settings — the keyboard's double-click
      // (React Flow makes each node focusable; Enter also selects it).
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || e.repeat) return; // a held Enter would reopen the dialog it just opened
        const el = e.target as HTMLElement;
        const id = el.classList?.contains('react-flow__node') ? el.getAttribute('data-id') : null;
        if (!id || id === INPUT_NODE_ID) return;
        e.preventDefault();
        onOpenNode(id);
      }}
    >
      <ReactFlow<ChainFlowNode, PairEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onNodeDragStop={(_e, _n, dragged) => {
          onMoveNodes(dragged.filter((n) => n.id !== INPUT_NODE_ID).map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })));
        }}
        onDelete={({ nodes: gone, edges: cut }) => onRemove(removalOf(gone, cut))}
        onNodeClick={(_e, n) => onSelectNode(n.id === INPUT_NODE_ID ? null : n.id)}
        onNodeDoubleClick={(_e, n) => { if (n.id !== INPUT_NODE_ID) onOpenNode(n.id); }}
        onEdgeDoubleClick={(_e, edge) => {
          const d = edge.data as PairEdgeData | undefined;
          if (d && !d.input) onEditEdge(d.from, d.to);
        }}
        onPaneClick={() => onSelectNode(null)}
        nodesDraggable={canEdit}
        nodesConnectable={canEdit}
        deleteKeyCode={canEdit ? ['Backspace', 'Delete'] : null}
        zoomOnDoubleClick={false}
        minZoom={0.2}
        maxZoom={2}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="#cbd5e1" />
        <Controls showInteractive={false} position="bottom-left" fitViewOptions={FIT_OPTIONS} />
        <MiniMap pannable zoomable nodeColor={minimapColour} nodeStrokeColor="#94a3b8" position="bottom-right" />
      </ReactFlow>
    </div>
  );
}

export function RuleChainCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  );
}
