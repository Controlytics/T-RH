import type { Edge, Node } from '@xyflow/react';
import {
  RULE_NODE_TYPE_BY_ID, RULE_RELATION_FAILURE, UNSUPPORTED_NODE_TYPE,
  type RuleChainDocument, type RuleChainNode, type RuleNodeTypeSpec,
} from '@digilog/shared';
import { INPUT_NODE_ID } from './types';

/**
 * How a chain DOCUMENT is drawn on the canvas (rule chains, 2026-11-04) —
 * pure, so it is tested without a layout engine.
 *
 * - Every document node is one `ruleNode`. The fixed Input is a canvas-only
 *   `chainInput` node: it is not in the document; its one link IS the chain's
 *   `firstNodeId`.
 * - A connection is one document entry per relation; the canvas draws ONE
 *   edge per (from, to) pair, labelled with every relation of the pair
 *   ("Post telemetry / Post attributes"), as ThingsBoard does.
 * - React Flow keeps what it measured and what is selected ON the node
 *   objects it is handed. Rebuilding a node from the document must carry those
 *   over from the previous object, or a node it measured once is unmeasured
 *   again — hidden, with no handles for edges — and nothing re-measures it.
 */

export interface RuleNodeData extends Record<string, unknown> {
  node: RuleChainNode;
  /** The catalogue entry; null for `tb:unsupported` (or a type this build does not know). */
  spec: RuleNodeTypeSpec | null;
  /** ThingsBoard's class name — shown on a node with no counterpart here. */
  tbClass: string | null;
  /** Built here (false: Unsupported, later, none — every message goes to Failure). */
  supported: boolean;
  canEdit: boolean;
  /** The node the debug panel is showing. */
  inspected: boolean;
}

export interface InputNodeData extends Record<string, unknown> {
  connected: boolean;
  canEdit: boolean;
}

export interface PairEdgeData extends Record<string, unknown> {
  from: string;
  to: string;
  relations: string[];
  /** The Input's link (to the first node). */
  input: boolean;
}

export type RuleFlowNode = Node<RuleNodeData, 'ruleNode'>;
export type InputFlowNode = Node<InputNodeData, 'chainInput'>;
export type ChainFlowNode = RuleFlowNode | InputFlowNode;
export type PairEdge = Edge<PairEdgeData>;

/** Where the Input sits: left of the first node, else left of the leftmost one. */
export function inputPosition(doc: RuleChainDocument): { x: number; y: number } {
  const first = doc.nodes.find((n) => n.id === doc.firstNodeId);
  if (first) return { x: first.x - 260, y: first.y };
  if (doc.nodes.length === 0) return { x: 40, y: 160 };
  const left = doc.nodes.reduce((a, b) => (b.x < a.x ? b : a));
  return { x: left.x - 260, y: left.y };
}

/** ThingsBoard's class for a node: its spec's, or the one an Unsupported node carries from the import. */
export function tbClassOf(node: RuleChainNode, spec: RuleNodeTypeSpec | null): string | null {
  if (spec) return spec.tbClass;
  const c = node.config as { tbClass?: unknown; type?: unknown };
  if (typeof c.tbClass === 'string') return c.tbClass;
  if (typeof c.type === 'string') return c.type;
  return node.type === UNSUPPORTED_NODE_TYPE ? null : node.type;
}

export function buildFlowNodes(
  doc: RuleChainDocument,
  prev: readonly Node[],
  opts: { canEdit: boolean; inspectedId?: string | null },
): ChainFlowNode[] {
  const before = new Map(prev.map((n) => [n.id, n]));
  const input = before.get(INPUT_NODE_ID);
  const inputNode: InputFlowNode = {
    ...(input as InputFlowNode | undefined),
    id: INPUT_NODE_ID,
    type: 'chainInput',
    position: inputPosition(doc),
    data: { connected: doc.firstNodeId !== null, canEdit: opts.canEdit },
    deletable: false,
    draggable: false,
    selectable: false,
  };
  const nodes: RuleFlowNode[] = doc.nodes.map((n) => {
    const spec = RULE_NODE_TYPE_BY_ID.get(n.type) ?? null;
    const old = before.get(n.id) as RuleFlowNode | undefined;
    return {
      ...old,
      id: n.id,
      type: 'ruleNode',
      position: { x: n.x, y: n.y },
      data: {
        node: n,
        spec,
        tbClass: tbClassOf(n, spec),
        supported: spec !== null && spec.status === 'built',
        canEdit: opts.canEdit,
        inspected: opts.inspectedId === n.id,
      },
      deletable: opts.canEdit,
      draggable: opts.canEdit,
    };
  });
  return [inputNode, ...nodes];
}

export const pairEdgeId = (from: string, to: string) => `e:${from}->${to}`;

export function buildFlowEdges(doc: RuleChainDocument, prev: readonly Edge[], canEdit: boolean): PairEdge[] {
  const selected = new Set(prev.filter((e) => e.selected).map((e) => e.id));
  const pairs = new Map<string, PairEdgeData>();
  for (const c of doc.connections) {
    const id = pairEdgeId(c.from, c.to);
    const p = pairs.get(id);
    if (p) p.relations.push(c.relation);
    else pairs.set(id, { from: c.from, to: c.to, relations: [c.relation], input: false });
  }
  const edges: PairEdge[] = [];
  if (doc.firstNodeId) {
    const id = pairEdgeId(INPUT_NODE_ID, doc.firstNodeId);
    edges.push({
      id, source: INPUT_NODE_ID, target: doc.firstNodeId, type: 'default',
      data: { from: INPUT_NODE_ID, to: doc.firstNodeId, relations: [], input: true },
      selected: selected.has(id), deletable: canEdit,
    });
  }
  for (const [id, p] of pairs) {
    const failureOnly = p.relations.every((r) => r === RULE_RELATION_FAILURE);
    edges.push({
      id, source: p.from, target: p.to, type: 'default',
      label: p.relations.join(' / '),
      data: p,
      selected: selected.has(id),
      deletable: canEdit,
      className: failureOnly ? 'rc-edge-failure' : undefined,
    });
  }
  return edges;
}

/** What a canvas Delete removes, from React Flow's deleted nodes and edges. */
export function removalOf(nodes: readonly Node[], edges: readonly Edge[]): { nodeIds: string[]; pairs: { from: string; to: string }[]; input: boolean } {
  const nodeIds = nodes.map((n) => n.id).filter((id) => id !== INPUT_NODE_ID);
  let input = false;
  const pairs: { from: string; to: string }[] = [];
  for (const e of edges) {
    if (e.source === INPUT_NODE_ID) input = true;
    else pairs.push({ from: e.source, to: e.target });
  }
  return { nodeIds, pairs, input };
}
