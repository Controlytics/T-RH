import { useCallback, useState } from 'react';
import {
  RULE_NODE_NAME_MAX, RULE_NODE_TYPE_BY_ID, newRuleNodeConfig, ruleChainsEqual,
  type RuleChainConnection, type RuleChainDocument, type RuleChainNode, type RuleDebugMode,
} from '@digilog/shared';

/**
 * The rule chain editor's DRAFT (rule chains, 2026-11-04; spec section 11).
 *
 * Every change the canvas makes goes through the pure reducers below and lands
 * here; the Save sends what this holds. The draft lives in component state, not
 * in SWR, so a background revalidation cannot move a node the user is placing
 * (the dashboard builder's rule, `use-dashboard-draft.ts`).
 *
 * What the canvas reports is NOT the document: React Flow emits selection and
 * measurement changes constantly, and only a drag's END, a drop, a connection,
 * a delete and a settings Apply are edits. Each edit is one undo step; the last
 * {@link UNDO_LIMIT} are kept. An edit that returns the same document object
 * records nothing, so a click is not a step.
 */

export const UNDO_LIMIT = 50;

/** What a Save writes besides the document — both are part of the draft and undoable. */
export interface ChainDraftState {
  name: string;
  reEnterOnRuleNodeWrites: boolean;
  document: RuleChainDocument;
}

/**
 * A v4 uuid. `crypto.randomUUID` exists only in a SECURE context — an install
 * served over plain http by IP address has none — so it falls back to
 * `getRandomValues`, which every context has. The strict parse needs the
 * 8-4-4-4-12 hex shape.
 */
export function newNodeId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `base`, else `base 2`, `base 3` … — a name no node of the chain has (ThingsBoard keeps names apart too). */
export function uniqueNodeName(doc: RuleChainDocument, base: string): string {
  const taken = new Set(doc.nodes.map((n) => n.name.trim().toLowerCase()));
  const clip = (s: string) => s.slice(0, RULE_NODE_NAME_MAX);
  if (!taken.has(base.trim().toLowerCase())) return clip(base);
  for (let i = 2; ; i++) {
    const suffix = ` ${i}`;
    const name = base.slice(0, RULE_NODE_NAME_MAX - suffix.length) + suffix;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/**
 * A node of `type` at `pos`, named after the type, debug off, with ThingsBoard's
 * default configuration (a fresh copy). The first node of an EMPTY chain
 * becomes its first node, so the Input is connected to it at once.
 */
export function addNodeTo(
  doc: RuleChainDocument, type: string, pos: { x: number; y: number }, id: string = newNodeId(),
): RuleChainDocument {
  const spec = RULE_NODE_TYPE_BY_ID.get(type);
  const node: RuleChainNode = {
    id,
    type,
    name: uniqueNodeName(doc, spec?.label ?? 'Node'),
    debugMode: 'off',
    config: newRuleNodeConfig(type),
    x: Math.round(pos.x),
    y: Math.round(pos.y),
  };
  return {
    ...doc,
    nodes: [...doc.nodes, node],
    firstNodeId: doc.nodes.length === 0 && doc.firstNodeId === null ? id : doc.firstNodeId,
  };
}

/** Positions after a drag. Unchanged positions return the SAME document. */
export function moveNodesIn(doc: RuleChainDocument, moves: readonly { id: string; x: number; y: number }[]): RuleChainDocument {
  const byId = new Map(moves.map((m) => [m.id, { x: Math.round(m.x), y: Math.round(m.y) }]));
  let changed = false;
  const nodes = doc.nodes.map((n) => {
    const m = byId.get(n.id);
    if (!m || (m.x === n.x && m.y === n.y)) return n;
    changed = true;
    return { ...n, x: m.x, y: m.y };
  });
  return changed ? { ...doc, nodes } : doc;
}

export interface NodePatch {
  name?: string;
  debugMode?: RuleDebugMode;
  config?: Record<string, unknown>;
}

/** JSON with object keys sorted — equal for two values that differ only in key order. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : x));
}

/**
 * One node's settings (the dialog's Apply). Other nodes keep their object
 * identity. A patch that changes NOTHING (an Apply on an untouched dialog)
 * returns the SAME document, so it records no undo step (fix round 1).
 */
export function updateNodeIn(doc: RuleChainDocument, id: string, patch: NodePatch): RuleChainDocument {
  const node = doc.nodes.find((n) => n.id === id);
  if (!node) return doc;
  const unchanged = (patch.name === undefined || patch.name === node.name)
    && (patch.debugMode === undefined || patch.debugMode === node.debugMode)
    && (patch.config === undefined || canonical(patch.config) === canonical(node.config));
  if (unchanged) return doc;
  return { ...doc, nodes: doc.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) };
}

/**
 * What a Delete on the canvas removes: nodes (with every connection into or
 * out of them), edges (an edge is a PAIR — every relation between the two
 * nodes goes), and the Input's link (`input: true` unsets the first node).
 */
export function removeFromDoc(
  doc: RuleChainDocument,
  what: { nodeIds?: readonly string[]; pairs?: readonly { from: string; to: string }[]; input?: boolean },
): RuleChainDocument {
  const gone = new Set(what.nodeIds ?? []);
  const pairs = new Set((what.pairs ?? []).map((p) => `${p.from}\u0000${p.to}`));
  const connections = doc.connections.filter(
    (c) => !gone.has(c.from) && !gone.has(c.to) && !pairs.has(`${c.from}\u0000${c.to}`),
  );
  const firstGone = what.input === true || (doc.firstNodeId !== null && gone.has(doc.firstNodeId));
  return {
    ...doc,
    nodes: doc.nodes.filter((n) => !gone.has(n.id)),
    connections,
    firstNodeId: firstGone ? null : doc.firstNodeId,
  };
}

/** The relation labels of one (from, to) pair, in document order. */
export function relationsBetween(doc: RuleChainDocument, from: string, to: string): string[] {
  return doc.connections.filter((c) => c.from === from && c.to === to).map((c) => c.relation);
}

/**
 * The relation picker's answer: the pair (from, to) carries EXACTLY these
 * labels — trimmed, blanks and repeats dropped (a repeated `(from, to,
 * relation)` is a 400). An empty set removes the pair. Every other pair keeps
 * its connections and their order; the pair's own labels keep their place.
 */
export function setPairRelations(doc: RuleChainDocument, from: string, to: string, relations: readonly string[]): RuleChainDocument {
  const wanted: string[] = [];
  for (const r of relations) {
    const t = r.trim();
    if (t !== '' && !wanted.includes(t)) wanted.push(t);
  }
  const at = doc.connections.findIndex((c) => c.from === from && c.to === to);
  const others = doc.connections.filter((c) => !(c.from === from && c.to === to));
  const mine: RuleChainConnection[] = wanted.map((relation) => ({ from, to, relation }));
  const insertAt = at === -1 ? others.length : doc.connections.slice(0, at).filter((c) => !(c.from === from && c.to === to)).length;
  return { ...doc, connections: [...others.slice(0, insertAt), ...mine, ...others.slice(insertAt)] };
}

/** The Input's one link. */
export function setFirstNodeIn(doc: RuleChainDocument, id: string | null): RuleChainDocument {
  return doc.firstNodeId === id ? doc : { ...doc, firstNodeId: id };
}

/** Same name, same switch, same document — the server's "unchanged" save, structurally (ids compared). */
export function sameDraft(a: ChainDraftState, b: ChainDraftState): boolean {
  if (a.name !== b.name || a.reEnterOnRuleNodeWrites !== b.reEnterOnRuleNodeWrites) return false;
  if (a.document.firstNodeId !== b.document.firstNodeId) return false;
  if (a.document.nodes.length !== b.document.nodes.length) return false;
  if (a.document.nodes.some((n, i) => n.id !== b.document.nodes[i].id)) return false;
  return ruleChainsEqual(a.document, b.document);
}

interface History {
  present: ChainDraftState;
  past: ChainDraftState[];
  future: ChainDraftState[];
}

/**
 * The edit session over ONE chain. `stored` is the version the draft is based
 * on (the editor page passes the server's, and calls `reset` when it adopts a
 * newer one); `dirty` compares the draft with it.
 */
export function useChainDraft(stored: ChainDraftState) {
  const [h, setH] = useState<History>({ present: stored, past: [], future: [] });

  const push = useCallback((next: (s: ChainDraftState) => ChainDraftState) => {
    setH((cur) => {
      const n = next(cur.present);
      if (n === cur.present) return cur;
      const past = [...cur.past, cur.present];
      return { present: n, past: past.length > UNDO_LIMIT ? past.slice(past.length - UNDO_LIMIT) : past, future: [] };
    });
  }, []);

  /** One undoable change to the document. Returning the same object records nothing. */
  const edit = useCallback((change: (d: RuleChainDocument) => RuleChainDocument) => {
    push((s) => {
      const d = change(s.document);
      return d === s.document ? s : { ...s, document: d };
    });
  }, [push]);

  /** The chain's name / re-enter switch — undoable like any edit. */
  const setMeta = useCallback((meta: Partial<Pick<ChainDraftState, 'name' | 'reEnterOnRuleNodeWrites'>>) => {
    push((s) => {
      const name = meta.name ?? s.name;
      const re = meta.reEnterOnRuleNodeWrites ?? s.reEnterOnRuleNodeWrites;
      return name === s.name && re === s.reEnterOnRuleNodeWrites ? s : { ...s, name, reEnterOnRuleNodeWrites: re };
    });
  }, [push]);

  const undo = useCallback(() => setH((cur) => {
    if (cur.past.length === 0) return cur;
    const prev = cur.past[cur.past.length - 1];
    return { present: prev, past: cur.past.slice(0, -1), future: [cur.present, ...cur.future] };
  }), []);

  const redo = useCallback(() => setH((cur) => {
    if (cur.future.length === 0) return cur;
    const [next, ...rest] = cur.future;
    return { present: next, past: [...cur.past, cur.present], future: rest };
  }), []);

  /** After a save or a reload: the draft IS this version, with no history. */
  const reset = useCallback((next: ChainDraftState) => setH({ present: next, past: [], future: [] }), []);

  return {
    draft: h.present,
    dirty: !sameDraft(h.present, stored),
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
    edit, setMeta, undo, redo, reset,
  };
}
