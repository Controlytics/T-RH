import { describe, it, expect } from 'vitest';
import { insertCornerMap, deleteCornerMap, geometricMap, remapDoors, remapOpenings } from '../reindex';
import type { RoomDoor } from '@/routes/dashboard/room-geometry';
import type { DesignerLink } from '../types';

/**
 * Doors and openings follow their WALL when the outline changes (audit
 * 2026-10-12 finding 3). Rectangle 0.1..0.5 x 0.1..0.3: edge 0 top, 1 right,
 * 2 bottom, 3 left.
 */
const RECT = [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.3 }, { x: 0.1, y: 0.3 }];
const door = (d: Partial<RoomDoor>): RoomDoor => ({ offset: 0.1, width: 0.2, kind: 'ENTRY', ...d });
const opening = (id: string, fromEdge: number, offset = 0.3, width = 0.3): DesignerLink => ({
  id, fromRoomId: 'R', toRoomId: 'N', kind: 'OPENING', fromEdge, offset, width, door: null, label: null,
});

describe('insertCornerMap', () => {
  // A corner at the middle of the TOP edge (edge 0, t = 0.5).
  const map = insertCornerMap(RECT, 0, { x: 0.3, y: 0.1 });
  it('every edge after the split moves up one; earlier edges stay', () => {
    expect(map({ edge: 1, offset: 0.3, width: 0.3 })).toMatchObject({ edge: 2, offset: 0.3, width: 0.3 });
    expect(map({ edge: 3, offset: 0.1, width: 0.1 })).toMatchObject({ edge: 4 });
  });
  it('a door on the split edge stays on the half it lies in, its fractions rescaled', () => {
    expect(map({ edge: 0, offset: 0.1, width: 0.2 })).toMatchObject({ edge: 0, offset: 0.2, width: 0.4 });
    expect(map({ edge: 0, offset: 0.6, width: 0.2 })).toMatchObject({ edge: 1, offset: 0.2, width: 0.4 });
  });
  it('a door straddling the new corner no longer fits', () => {
    expect(map({ edge: 0, offset: 0.4, width: 0.2 })).toBeNull();
  });
});

describe('deleteCornerMap', () => {
  // A five-corner room with a corner ON the top wall (index 1); deleting it merges edges 0 and 1.
  const FIVE = [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.3 }, { x: 0.1, y: 0.3 }];
  const map = deleteCornerMap(FIVE, 1);
  it('a door on either merged edge lands on the merged edge at its true place', () => {
    expect(map({ edge: 0, offset: 0.5, width: 0.5 })).toMatchObject({ edge: 0, offset: 0.25, width: 0.25 });
    expect(map({ edge: 1, offset: 0, width: 0.5 })).toMatchObject({ edge: 0, offset: 0.5, width: 0.25 });
  });
  it('later edges move down one', () => {
    expect(map({ edge: 2, offset: 0.3, width: 0.3 })).toMatchObject({ edge: 1, offset: 0.3 });
    expect(map({ edge: 4, offset: 0.3, width: 0.3 })).toMatchObject({ edge: 3 });
  });
  it('when the deleted corner was NOT on a straight wall, a door on the merged walls no longer fits', () => {
    const L = [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.3 }, { x: 0.3, y: 0.3 }, { x: 0.3, y: 0.5 }, { x: 0.1, y: 0.5 }];
    const m = deleteCornerMap(L, 3);   // the inner corner
    expect(m({ edge: 2, offset: 0.2, width: 0.2 })).toBeNull();
    expect(m({ edge: 0, offset: 0.2, width: 0.2 })).toMatchObject({ edge: 0 });
  });
});

describe('geometricMap (a merge)', () => {
  it('finds the span again on the union outline, by its end points', () => {
    const union = [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.3 }, { x: 0.1, y: 0.3 }];
    const map = geometricMap(RECT, union);
    // RECT's top-edge door 0.1..0.3 of 0.4 long = x 0.14..0.22 → on the union's top edge (0.8 long).
    expect(map({ edge: 0, offset: 0.1, width: 0.2 })).toMatchObject({ edge: 0, offset: 0.05, width: 0.1 });
    // RECT's RIGHT wall is inside the union now.
    expect(map({ edge: 1, offset: 0.3, width: 0.3 })).toBeNull();
  });
});

describe('remapDoors / remapOpenings', () => {
  const map = insertCornerMap(RECT, 0, { x: 0.3, y: 0.1 });
  it('a legacy WALL door becomes an EDGE door on its true wall; a door that no longer fits is counted', () => {
    const r = remapDoors([door({ wall: 'right', offset: 0.3, width: 0.3 }), door({ edge: 0, offset: 0.4, width: 0.2 })], RECT, map);
    expect(r.dropped).toBe(1);
    expect(r.doors).toEqual([{ edge: 2, offset: 0.3, width: 0.3, kind: 'ENTRY' }]);
  });
  it('the room\'s own openings come back as linkEdges; others are untouched; one off its wall is reported', () => {
    const links = [opening('L1', 1), opening('L2', 0, 0.4, 0.2), { ...opening('L3', 1), fromRoomId: 'OTHER' }];
    const r = remapOpenings(links, 'R', map);
    expect(r.linkEdges).toEqual([{ id: 'L1', fromEdge: 2, offset: 0.3, width: 0.3 }]);
    expect(r.off.map((l) => l.id)).toEqual(['L2']);
  });
});
