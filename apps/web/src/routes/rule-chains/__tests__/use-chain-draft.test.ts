import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { emptyRuleChainDocument, parseRuleChainDocument, defaultRootChainDocument, type RuleChainDocument } from '@digilog/shared';
import {
  UNDO_LIMIT, addNodeTo, moveNodesIn, newNodeId, relationsBetween, removeFromDoc, setFirstNodeIn,
  setPairRelations, uniqueNodeName, updateNodeIn, useChainDraft, type ChainDraftState,
} from '../use-chain-draft';

/**
 * The editor's draft (rule chains, 2026-11-04): every change the canvas makes
 * to a chain document, undo / redo over the last 50, and `dirty`. Pure
 * reducers, so the canvas (which jsdom cannot lay out) is not needed to prove
 * what a drop, a connection or a delete does to the document the Save sends.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SWITCH = 'tb:filter:message-type-switch';
const SAVE_TS = 'tb:action:save-timeseries';

function docWith(...types: string[]): RuleChainDocument {
  return types.reduce((d, t, i) => addNodeTo(d, t, { x: 100 * i, y: 50 }), emptyRuleChainDocument());
}

describe('node ids', () => {
  it('are uuids the strict parse accepts', () => {
    expect(newNodeId()).toMatch(UUID);
    expect(newNodeId()).not.toBe(newNodeId());
  });

  it('are uuids without crypto.randomUUID too (an install served over plain http is not a secure context)', () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      const id = newNodeId();
      expect(id).toMatch(UUID);
      expect(id[14]).toBe('4');
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true });
    }
  });
});

describe('adding a node', () => {
  it('adds the type with ThingsBoard\'s default config, debug off, at the rounded drop point', () => {
    const doc = addNodeTo(emptyRuleChainDocument(), SAVE_TS, { x: 120.6, y: 80.2 });
    expect(doc.nodes).toHaveLength(1);
    const [n] = doc.nodes;
    expect(n).toMatchObject({ type: SAVE_TS, name: 'Save time series', debugMode: 'off', x: 121, y: 80 });
    expect(n.config).toEqual({ defaultTTL: 0, useServerTs: false, skipLatestPersistence: false, processingSettings: { type: 'ON_EVERY_MESSAGE' } });
    expect(n.id).toMatch(UUID);
    expect(() => parseRuleChainDocument(doc)).not.toThrow();
  });

  it('makes the FIRST node of an empty chain its first node (the Input connects to it); later ones leave it', () => {
    const one = addNodeTo(emptyRuleChainDocument(), SWITCH, { x: 0, y: 0 });
    expect(one.firstNodeId).toBe(one.nodes[0].id);
    const two = addNodeTo(one, SAVE_TS, { x: 300, y: 0 });
    expect(two.firstNodeId).toBe(one.nodes[0].id);
  });

  it('names a second node of a type apart from the first', () => {
    const doc = docWith(SAVE_TS, SAVE_TS, SAVE_TS);
    expect(doc.nodes.map((n) => n.name)).toEqual(['Save time series', 'Save time series 2', 'Save time series 3']);
    expect(uniqueNodeName(doc, 'Log')).toBe('Log');
  });

  it('copies the default config, never shares it', () => {
    const doc = docWith(SWITCH, 'tb:filter:check-fields-presence', 'tb:filter:check-fields-presence');
    (doc.nodes[1].config.messageNames as string[]).push('temp');
    expect(doc.nodes[2].config.messageNames).toEqual([]);
  });
});

describe('connections', () => {
  it('a pair takes a SET of relations — two labels are two connections', () => {
    const doc0 = docWith(SWITCH, SAVE_TS);
    const [a, b] = doc0.nodes;
    const doc = setPairRelations(doc0, a.id, b.id, ['Post telemetry', 'Post attributes']);
    expect(doc.connections).toEqual([
      { from: a.id, to: b.id, relation: 'Post telemetry' },
      { from: a.id, to: b.id, relation: 'Post attributes' },
    ]);
    expect(relationsBetween(doc, a.id, b.id)).toEqual(['Post telemetry', 'Post attributes']);
    expect(() => parseRuleChainDocument(doc)).not.toThrow();
  });

  it('replaces the pair\'s set, trims, drops blanks and repeats, and leaves other pairs alone', () => {
    const doc0 = docWith(SWITCH, SAVE_TS, 'tb:action:log');
    const [a, b, c] = doc0.nodes;
    const withBoth = setPairRelations(setPairRelations(doc0, a.id, b.id, ['Post telemetry']), a.id, c.id, ['Other']);
    const doc = setPairRelations(withBoth, a.id, b.id, [' Alarm ', '', 'Alarm', 'Post telemetry']);
    expect(relationsBetween(doc, a.id, b.id)).toEqual(['Alarm', 'Post telemetry']);
    expect(relationsBetween(doc, a.id, c.id)).toEqual(['Other']);
    expect(relationsBetween(setPairRelations(doc, a.id, b.id, []), a.id, b.id)).toEqual([]);
  });

  it('the Input connects to ONE node: connecting it elsewhere moves it', () => {
    const doc0 = docWith(SWITCH, SAVE_TS);
    const doc = setFirstNodeIn(doc0, doc0.nodes[1].id);
    expect(doc.firstNodeId).toBe(doc0.nodes[1].id);
    expect(setFirstNodeIn(doc, null).firstNodeId).toBeNull();
  });
});

describe('moving, editing and removing', () => {
  it('a move that changes nothing returns the SAME document (no undo step for a click)', () => {
    const doc = docWith(SWITCH);
    const n = doc.nodes[0];
    expect(moveNodesIn(doc, [{ id: n.id, x: n.x, y: n.y }])).toBe(doc);
    const moved = moveNodesIn(doc, [{ id: n.id, x: 400.4, y: 10 }]);
    expect(moved.nodes[0]).toMatchObject({ x: 400, y: 10 });
  });

  it('edits one node\'s name, debug mode and config', () => {
    const doc = docWith(SWITCH, SAVE_TS);
    const next = updateNodeIn(doc, doc.nodes[1].id, { name: 'Store', debugMode: 'failures', config: { useServerTs: true } });
    expect(next.nodes[1]).toMatchObject({ name: 'Store', debugMode: 'failures', config: { useServerTs: true } });
    expect(next.nodes[0]).toBe(doc.nodes[0]);
  });

  it('removing a node removes its connections and, if it was the first node, the Input\'s link', () => {
    const doc0 = docWith(SWITCH, SAVE_TS, 'tb:action:log');
    const [a, b, c] = doc0.nodes;
    const doc1 = setPairRelations(setPairRelations(doc0, a.id, b.id, ['Post telemetry']), b.id, c.id, ['Success', 'Failure']);
    const doc = removeFromDoc(doc1, { nodeIds: [a.id] });
    expect(doc.nodes.map((n) => n.id)).toEqual([b.id, c.id]);
    expect(doc.connections).toEqual([{ from: b.id, to: c.id, relation: 'Success' }, { from: b.id, to: c.id, relation: 'Failure' }]);
    expect(doc.firstNodeId).toBeNull();
  });

  it('removing an edge removes every relation of that pair; removing the Input\'s edge unsets the first node', () => {
    const doc0 = docWith(SWITCH, SAVE_TS);
    const [a, b] = doc0.nodes;
    const doc1 = setPairRelations(doc0, a.id, b.id, ['Post telemetry', 'Other']);
    const doc = removeFromDoc(doc1, { pairs: [{ from: a.id, to: b.id }], input: true });
    expect(doc.connections).toEqual([]);
    expect(doc.firstNodeId).toBeNull();
    expect(doc.nodes).toHaveLength(2);
  });
});

describe('useChainDraft', () => {
  const stored: ChainDraftState = { name: 'Root Rule Chain', reEnterOnRuleNodeWrites: false, document: defaultRootChainDocument() };

  it('starts clean, becomes dirty on a change, and undo / redo walk it back and forth', () => {
    const { result } = renderHook(() => useChainDraft(stored));
    expect(result.current.dirty).toBe(false);
    expect(result.current.canUndo).toBe(false);
    act(() => result.current.edit((d) => addNodeTo(d, 'tb:action:log', { x: 10, y: 10 })));
    expect(result.current.dirty).toBe(true);
    expect(result.current.draft.document.nodes).toHaveLength(5);
    act(() => result.current.undo());
    expect(result.current.draft.document.nodes).toHaveLength(4);
    expect(result.current.dirty).toBe(false);
    expect(result.current.canRedo).toBe(true);
    act(() => result.current.redo());
    expect(result.current.draft.document.nodes).toHaveLength(5);
  });

  it('a change that returns the same document adds no undo step', () => {
    const { result } = renderHook(() => useChainDraft(stored));
    act(() => result.current.edit((d) => d));
    expect(result.current.canUndo).toBe(false);
  });

  it('keeps the LAST 50 steps', () => {
    const { result } = renderHook(() => useChainDraft(stored));
    for (let i = 0; i < UNDO_LIMIT + 5; i++) {
      act(() => result.current.edit((d) => addNodeTo(d, 'tb:action:log', { x: i * 10, y: 0 })));
    }
    let undone = 0;
    while (result.current.canUndo) { act(() => result.current.undo()); undone++; }
    expect(UNDO_LIMIT).toBe(50);
    expect(undone).toBe(50);
    // The five oldest steps are gone: the first five added nodes stay.
    expect(result.current.draft.document.nodes).toHaveLength(4 + 5);
  });

  it('a name or re-enter change is a draft change too, and undoable', () => {
    const { result } = renderHook(() => useChainDraft(stored));
    act(() => result.current.setMeta({ name: 'Root (edited)' }));
    expect(result.current.dirty).toBe(true);
    act(() => result.current.setMeta({ reEnterOnRuleNodeWrites: true }));
    act(() => result.current.undo());
    expect(result.current.draft).toMatchObject({ name: 'Root (edited)', reEnterOnRuleNodeWrites: false });
  });

  it('reset adopts a new stored version and forgets the history', () => {
    const { result, rerender } = renderHook(({ s }) => useChainDraft(s), { initialProps: { s: stored } });
    act(() => result.current.edit((d) => addNodeTo(d, 'tb:action:log', { x: 10, y: 10 })));
    const saved = result.current.draft;
    rerender({ s: saved });
    act(() => result.current.reset(saved));
    expect(result.current.dirty).toBe(false);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.draft.document.nodes).toHaveLength(5);
  });
});
