import { describe, it, expect } from 'vitest';
import { reduce, initialState, closedPolygon } from '../tools';

describe('drawing a room corner by corner', () => {
  it('corners accumulate, a valid outline closes, cancel discards', () => {
    let s = reduce(initialState, { type: 'setTool', tool: 'room' });
    s = reduce(s, { type: 'addCorner', point: { x: 0.1, y: 0.1 } });
    s = reduce(s, { type: 'addCorner', point: { x: 0.3, y: 0.1 } });
    expect(closedPolygon(s).ok).toBe(false); // two corners is not a room
    s = reduce(s, { type: 'addCorner', point: { x: 0.3, y: 0.3 } });
    expect(closedPolygon(s)).toEqual({ ok: true, points: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.1 }, { x: 0.3, y: 0.3 }] });
    expect(reduce(s, { type: 'cancel' }).drawing).toBeNull();
    expect(reduce(s, { type: 'closePolygon' }).drawing).toBeNull();
  });

  it('a bow-tie is refused with a reason and the outline stays open for correction', () => {
    let s = reduce(initialState, { type: 'setTool', tool: 'room' });
    for (const p of [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }]) s = reduce(s, { type: 'addCorner', point: p });
    const r = closedPolygon(s);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/crosses itself/);
    expect(s.drawing).toHaveLength(4);
  });

  it('a repeated corner is ignored, not added twice; undoCorner steps back', () => {
    let s = reduce(initialState, { type: 'setTool', tool: 'room' });
    s = reduce(s, { type: 'addCorner', point: { x: 0.1, y: 0.1 } });
    s = reduce(s, { type: 'addCorner', point: { x: 0.1, y: 0.1 } });
    expect(s.drawing).toHaveLength(1);
    s = reduce(s, { type: 'addCorner', point: { x: 0.2, y: 0.1 } });
    s = reduce(s, { type: 'undoCorner' });
    expect(s.drawing).toEqual([{ x: 0.1, y: 0.1 }]);
    s = reduce(s, { type: 'undoCorner' });
    expect(s.drawing).toBeNull();
  });
});

describe('linking and selecting', () => {
  it('link: first click remembers the room, cancel forgets it, changing tool forgets it', () => {
    let s = reduce(initialState, { type: 'setTool', tool: 'link' });
    s = reduce(s, { type: 'linkFirst', roomId: 'A' });
    expect(s.linkFrom).toBe('A');
    expect(reduce(s, { type: 'cancel' }).linkFrom).toBeNull();
    expect(reduce(s, { type: 'setTool', tool: 'select' }).linkFrom).toBeNull();
  });

  it('changing tool clears the selection and any drawing', () => {
    let s = reduce(initialState, { type: 'select', selection: { kind: 'room', roomId: 'A' } });
    s = reduce(s, { type: 'addCorner', point: { x: 0.1, y: 0.1 } });
    s = reduce(s, { type: 'setTool', tool: 'room' });
    expect(s.selection).toBeNull();
    expect(s.drawing).toBeNull();
  });

  it('a flash message is cleared by the next corner', () => {
    let s = reduce(initialState, { type: 'flash', message: 'no' });
    expect(s.message).toBe('no');
    s = reduce(s, { type: 'addCorner', point: { x: 0.1, y: 0.1 } });
    expect(s.message).toBeNull();
  });
});
