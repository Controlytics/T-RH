import { describe, it, expect } from 'vitest';
import { roomOutline, roomOpenings, planExtent, neighbourDoorOpenings, roomsToDraw, SLIVER } from '../floorplan-view';
import { polygonDoorPlacements } from '../room-geometry';
import type { FloorplanRoomShape, FloorplanLinkShape } from '../use-telemetry';

/**
 * The pure halves of the dashboard's polygon drawing (Layout Designer,
 * 2026-09-22): which outline a room draws, and which link openings land on
 * which of its edges. The SVG itself cannot be asserted in jsdom; these
 * numbers are where it breaks.
 */
const rect = (id: string, x: number, y: number, w: number, h: number): FloorplanRoomShape => ({
  id, code: id, label: null, grade: null, x, y, w, h,
  tempMin: null, tempMax: null, rhMin: null, rhMax: null, doors: null, meta: null, points: null,
});

describe('roomOutline', () => {
  it('a rectangle room outlines as its four corners scaled to the viewBox', () => {
    expect(roomOutline(rect('A', 0.1, 0.1, 0.2, 0.2), 1000, 500)).toEqual([
      { x: 100, y: 50 }, { x: 300, y: 50 }, { x: 300, y: 150 }, { x: 100, y: 150 },
    ]);
  });
  it('a stored polygon is used as drawn', () => {
    const r = { ...rect('L', 0, 0, 1, 1), points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.1, y: 0.5 }] };
    expect(roomOutline(r, 1000, 1000)).toEqual([{ x: 100, y: 100 }, { x: 500, y: 100 }, { x: 100, y: 500 }]);
  });
});

describe('roomOpenings', () => {
  it('an opening link lands on the from-room as stored and on the to-room mirrored', () => {
    const a = rect('A', 0.1, 0.1, 0.2, 0.2), b = rect('B', 0.3, 0.1, 0.2, 0.2);
    const links: FloorplanLinkShape[] = [
      { id: 'l', fromRoomId: 'A', toRoomId: 'B', kind: 'OPENING', fromEdge: 1, offset: 0.2, width: 0.3, door: null, label: null },
    ];
    const drawn = [{ room: a }, { room: b }];
    expect(roomOpenings(a, links, drawn, 1000, 1000)).toEqual([{ edge: 1, offset: 0.2, width: 0.3 }]);
    expect(roomOpenings(b, links, drawn, 1000, 1000)).toEqual([{ edge: 3, offset: 0.5, width: 0.3 }]);
  });
  it('a connector adds no opening, and a link to a room that is not drawn is ignored', () => {
    const a = rect('A', 0.1, 0.1, 0.2, 0.2), b = rect('B', 0.3, 0.1, 0.2, 0.2);
    const links: FloorplanLinkShape[] = [
      { id: 'c', fromRoomId: 'A', toRoomId: 'B', kind: 'CONNECTOR', fromEdge: null, offset: null, width: null, door: null, label: 'x' },
      { id: 'o', fromRoomId: 'B', toRoomId: 'A', kind: 'OPENING', fromEdge: 3, offset: 0.1, width: 0.2, door: null, label: null },
    ];
    expect(roomOpenings(a, links, [{ room: a }], 1000, 1000)).toEqual([]);
  });
});

describe('planExtent — the drawn floor fits its rooms (operator, 2026-09-22: no blank band below the last row)', () => {
  it('rooms in the top half give an extent that stops just under them, not the whole canvas', () => {
    const e = planExtent([rect('A', 0.05, 0.05, 0.4, 0.3), rect('B', 0.5, 0.05, 0.4, 0.5)]);
    expect(e.y + e.h).toBeLessThan(0.58);
    expect(e.y + e.h).toBeGreaterThan(0.55);
    expect(e.x).toBeLessThan(0.05);
    expect(e.x + e.w).toBeGreaterThan(0.9);
  });
  it('no rooms = the whole canvas; a polygon room counts its corners', () => {
    expect(planExtent([])).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    const e = planExtent([{ ...rect('L', 0, 0, 1, 1), points: [{ x: 0.2, y: 0.2 }, { x: 0.6, y: 0.2 }, { x: 0.2, y: 0.7 }] }]);
    expect(e.x + e.w).toBeLessThan(0.65);
    expect(e.y + e.h).toBeLessThan(0.75);
  });
  it('a sliver (QC\'s SHAFT-E: a 0.9 %-wide strip the full height) does not pin the border to the canvas edge', () => {
    expect(SLIVER).toBe(0.015);
    const e = planExtent([rect('A', 0.05, 0.05, 0.4, 0.3), rect('SHAFT-E', 0.991, 0, 0.009, 1)]);
    expect(e.y + e.h).toBeLessThan(0.4);
    // A plan of nothing but slivers keeps them, or it would draw nothing.
    expect(planExtent([rect('SHAFT-E', 0.991, 0, 0.009, 1)]).h).toBeGreaterThan(0.9);
  });
});

describe('neighbourDoorOpenings — a door is cut out of BOTH walls (2026-10-01)', () => {
  // A door is stored on the room it opens into; the room on the other side
  // strokes its own wall, and without this drew it straight across the gap.
  it("a neighbour's door lands on this room's shared edge, mirrored", () => {
    const a = { ...rect('A', 0.1, 0.1, 0.2, 0.2), doors: [{ wall: 'right' as const, offset: 0.2, width: 0.3, kind: 'ENTRY' as const }] };
    const b = rect('B', 0.3, 0.1, 0.2, 0.2);
    const drawn = [{ room: a }, { room: b }];
    expect(neighbourDoorOpenings(b, drawn, 1000, 1000)).toEqual([{ edge: 3, offset: 0.5, width: 0.3 }]);
    // Its own doors are not repeated here — the room already cuts those.
    expect(neighbourDoorOpenings(a, drawn, 1000, 1000)).toEqual([]);
  });
  it('a door on an edge-indexed polygon reaches the neighbour too, and a room not drawn contributes nothing', () => {
    const l = { ...rect('L', 0, 0, 1, 1), points: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.1 }, { x: 0.3, y: 0.3 }, { x: 0.1, y: 0.3 }], doors: [{ edge: 1, offset: 0, width: 0.25, kind: 'ENTRY' as const }] };
    const b = rect('B', 0.3, 0.1, 0.2, 0.2);
    expect(neighbourDoorOpenings(b, [{ room: l }, { room: b }], 1000, 1000)).toEqual([{ edge: 3, offset: 0.75, width: 0.25 }]);
    expect(neighbourDoorOpenings(b, [{ room: b }], 1000, 1000)).toEqual([]);
  });
});

describe('planExtent — the building structure (columns, windows) is inside the frame (2026-10-01)', () => {
  it('a column set in the outer wall, outside every room, widens the frame to take it in', () => {
    const rooms = [rect('A', 0.1, 0.1, 0.8, 0.8)];
    const without = planExtent(rooms);
    const withCols = planExtent(rooms, 0.01, [{ x: 0.02, y: 0.85, w: 0.04, h: 0.13 }]);
    expect(without.x).toBeGreaterThan(0.05);
    expect(withCols.x).toBeLessThanOrEqual(0.02);
    expect(withCols.y + withCols.h).toBeGreaterThanOrEqual(0.98);
  });
});

describe('roomsToDraw — a selected location draws the WHOLE floor its instruments are on (2026-10-01)', () => {
  const rooms = [{ id: 'lab', rows: [1] }, { id: 'corridor', rows: [] }, { id: 'office', rows: [] }];
  it('unscoped, and scoped with any reading on the plan: every room, empty ones included', () => {
    expect(roomsToDraw(rooms, false).map((r) => r.id)).toEqual(['lab', 'corridor', 'office']);
    expect(roomsToDraw(rooms, true).map((r) => r.id)).toEqual(['lab', 'corridor', 'office']);
  });
  it('scoped with none of the location on the plan: nothing (the view says so)', () => {
    expect(roomsToDraw([{ id: 'a', rows: [] }], true)).toEqual([]);
  });
});

describe('door swing — a quarter circle CENTRED ON THE HINGE (2026-10-01)', () => {
  // The SVG arc flag was inverted on every plan until 2026-10-01: each swing
  // was centred on the far inner corner, bulging toward the hinge.
  const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const centreOf = (arc: string) => {
    const m = /M ([\d.-]+) ([\d.-]+) A ([\d.]+) [\d.]+ 0 0 (\d) ([\d.-]+) ([\d.-]+)/.exec(arc)!;
    const [sx, sy, r, sw, ex, ey] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number);
    const mx = (sx + ex) / 2, my = (sy + ey) / 2, dx = ex - sx, dy = ey - sy, d = Math.hypot(dx, dy);
    const k = Math.sqrt(Math.max(r * r - (d / 2) ** 2, 0));
    const c1 = { x: mx - (dy / d) * k, y: my + (dx / d) * k }, c2 = { x: mx + (dy / d) * k, y: my - (dx / d) * k };
    const cross = (c: { x: number; y: number }) => (sx - c.x) * (ey - c.y) - (sy - c.y) * (ex - c.x);
    return (cross(c1) > 0) === (sw === 1) ? c1 : c2;
  };
  for (const hinge of ['start', 'end'] as const) {
    it(`hinged at the ${hinge}: the arc's centre IS the leaf's hinge point`, () => {
      const [p] = polygonDoorPlacements(square, [{ edge: 0, offset: 0.4, width: 0.3, kind: 'ENTRY', hinge }]);
      const c = centreOf(p.arc);
      expect(c.x).toBeCloseTo(p.leaf.x1, 6);
      expect(c.y).toBeCloseTo(p.leaf.y1, 6);
      expect(p.leaf.x1).toBeCloseTo(hinge === 'start' ? 40 : 70, 6);
    });
  }
  it("hinge 'none' is an opening: no leaf, no swing", () => {
    expect(polygonDoorPlacements(square, [{ edge: 0, offset: 0.4, width: 0.3, kind: 'EXIT', hinge: 'none' }])).toEqual([]);
  });

  // An exterior door that opens OUT of the building (2026-10-01, Microbiology's
  // emergency exit: drawn swinging in, it did not match the plant's drawing).
  for (const hinge of ['start', 'end'] as const) {
    it(`swing 'out', hinged at the ${hinge}: the leaf stands OUTSIDE the room and the arc is still centred on the hinge`, () => {
      const door = { edge: 0, offset: 0.4, width: 0.3, kind: 'EXIT', hinge } as const;
      const [inn] = polygonDoorPlacements(square, [door]);
      const [out] = polygonDoorPlacements(square, [{ ...door, swing: 'out' }]);
      // Edge 0 is the top wall (y 0); the room is below it.
      expect(inn.leaf.y2).toBeCloseTo(30, 6);
      expect(out.leaf.y2).toBeCloseTo(-30, 6);
      // Same opening, same hinge — only the side changes.
      expect(out.start).toEqual(inn.start);
      expect(out.hinge).toEqual(inn.hinge);
      const c = centreOf(out.arc);
      expect(c.x).toBeCloseTo(out.leaf.x1, 6);
      expect(c.y).toBeCloseTo(out.leaf.y1, 6);
    });
  }
  it("swing 'in' is the default: a door that says nothing draws exactly as one that says 'in'", () => {
    const door = { edge: 0, offset: 0.4, width: 0.3, kind: 'ENTRY' } as const;
    expect(polygonDoorPlacements(square, [{ ...door, swing: 'in' }])).toEqual(polygonDoorPlacements(square, [door]));
  });
});

describe('planExtent — what is drawn is never clipped at the canvas edge (2026-10-01)', () => {
  // In full screen a plan is re-proportioned and an outward door's swing, which
  // keeps its size while the canvas gets shorter, can reach past the canvas.
  it('an outward swing past the bottom of the canvas is inside the frame', () => {
    const rooms = [rect('A', 0.1, 0.1, 0.8, 0.86)];
    const e = planExtent(rooms, 0.01, [{ x: 0.4, y: 0.96, w: 0.05, h: 0.07 }]);
    expect(e.y + e.h).toBeCloseTo(1.03, 9);
  });

  it('the MARGIN still stops at the canvas', () => {
    const e = planExtent([rect('A', 0.005, 0.1, 0.99, 0.5)]);
    expect(e.x).toBe(0);
    expect(e.x + e.w).toBe(1);
  });
});
