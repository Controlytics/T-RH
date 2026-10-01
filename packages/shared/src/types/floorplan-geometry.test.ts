import { describe, it, expect } from 'vitest';
import {
  rectanglePoints, boundingBox, polygonArea, isSimplePolygon, validatePolygon,
  pointInPolygon, sharedEdges, mirrorOpening, largestInscribedRect, inscribedRects, doorEdge,
  centroid, unionRectilinear, isRectilinear, POLYGON_MAX_CORNERS,
} from './floorplan-geometry.js';

const square = rectanglePoints({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
/** An L: a 0.4×0.4 square with its bottom-right 0.2×0.2 quarter missing. */
const L = [
  { x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.3 },
  { x: 0.3, y: 0.3 }, { x: 0.3, y: 0.5 }, { x: 0.1, y: 0.5 },
];
const bowtie = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }];

describe('rectanglePoints / boundingBox', () => {
  it('orders the corners top-left, top-right, bottom-right, bottom-left', () => {
    expect(square).toEqual([{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.1 }, { x: 0.3, y: 0.3 }, { x: 0.1, y: 0.3 }]);
  });
  it('the bounding box of a rectangle is the rectangle', () => {
    expect(boundingBox(square)).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
  });
  it('the bounding box of an L spans its arms', () => {
    expect(boundingBox(L)).toEqual({ x: 0.1, y: 0.1, w: 0.4, h: 0.4 });
  });
});

describe('polygonArea / isSimplePolygon', () => {
  it('a square has its area, an L three quarters of its box', () => {
    expect(polygonArea(square)).toBeCloseTo(0.04, 10);
    expect(polygonArea(L)).toBeCloseTo(0.12, 10);
  });
  it('a square and an L are simple; a bow-tie is not', () => {
    expect(isSimplePolygon(square)).toBe(true);
    expect(isSimplePolygon(L)).toBe(true);
    expect(isSimplePolygon(bowtie)).toBe(false);
  });
  it('a repeated consecutive corner is not simple', () => {
    expect(isSimplePolygon([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }])).toBe(false);
  });
});

describe('validatePolygon', () => {
  it('accepts a square', () => {
    expect(validatePolygon(square)).toEqual({ ok: true, points: square });
  });
  it('refuses fewer than three corners, a corner outside the canvas, a bow-tie, a sliver, and too many corners', () => {
    expect(validatePolygon([{ x: 0, y: 0 }, { x: 1, y: 1 }]).ok).toBe(false);
    expect(validatePolygon([{ x: 0, y: 0 }, { x: 1.2, y: 0 }, { x: 1, y: 1 }]).ok).toBe(false);
    expect(validatePolygon(bowtie).ok).toBe(false);
    expect(validatePolygon([{ x: 0, y: 0 }, { x: 0.001, y: 0 }, { x: 0.001, y: 0.001 }]).ok).toBe(false);
    const many = Array.from({ length: POLYGON_MAX_CORNERS + 1 }, (_, i) => ({ x: 0.5 + 0.4 * Math.cos(i), y: 0.5 + 0.4 * Math.sin(i) }));
    expect(validatePolygon(many).ok).toBe(false);
  });
  it('refuses a non-array and a corner that is not numbers', () => {
    expect(validatePolygon('x').ok).toBe(false);
    expect(validatePolygon([{ x: '0', y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]).ok).toBe(false);
  });
});

describe('pointInPolygon', () => {
  it('inside the L arm is in, the missing quarter is out', () => {
    expect(pointInPolygon({ x: 0.2, y: 0.2 }, L)).toBe(true);
    expect(pointInPolygon({ x: 0.4, y: 0.4 }, L)).toBe(false);
  });
});

describe('sharedEdges', () => {
  const a = rectanglePoints({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
  it('two rooms sharing a full wall: my right edge is their left edge', () => {
    const b = rectanglePoints({ x: 0.3, y: 0.1, w: 0.2, h: 0.2 });
    expect(sharedEdges(a, b)).toEqual([{ aEdge: 1, bEdge: 3, start: 0, end: 1 }]);
  });
  it('a partial overlap reports the overlapping fraction of MY edge', () => {
    const b = rectanglePoints({ x: 0.3, y: 0.2, w: 0.2, h: 0.2 });
    const [s] = sharedEdges(a, b);
    expect(s.aEdge).toBe(1);
    expect(s.start).toBeCloseTo(0.5, 9);
    expect(s.end).toBeCloseTo(1, 9);
  });
  it('a gap wider than the tolerance is not shared; a corner touch is not shared', () => {
    expect(sharedEdges(a, rectanglePoints({ x: 0.31, y: 0.1, w: 0.2, h: 0.2 }))).toEqual([]);
    expect(sharedEdges(a, rectanglePoints({ x: 0.3, y: 0.3, w: 0.2, h: 0.2 }))).toEqual([]);
  });
  it('mirrors an opening onto the neighbour edge', () => {
    const b = rectanglePoints({ x: 0.3, y: 0.1, w: 0.2, h: 0.2 });
    // my right edge runs top→bottom; their left edge runs bottom→top, so 0.2..0.5 on mine is 0.5..0.8 on theirs
    expect(mirrorOpening(a, { edge: 1, offset: 0.2, width: 0.3 }, b)).toEqual({ edge: 3, offset: 0.5, width: 0.3 });
    expect(mirrorOpening(a, { edge: 0, offset: 0.2, width: 0.3 }, b)).toBeNull();
  });
});

describe('largestInscribedRect', () => {
  it('a rectangle is its own answer', () => {
    expect(largestInscribedRect(square)).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
  });
  it('an L gives the larger arm, never the bounding box', () => {
    const r = largestInscribedRect(L);
    expect(r.w * r.h).toBeCloseTo(0.08, 9);
    for (const c of rectanglePoints(r)) {
      expect(pointInPolygon({ x: Math.min(0.499, Math.max(0.101, c.x)), y: Math.min(0.499, Math.max(0.101, c.y)) }, L)).toBe(true);
    }
  });
});

describe('inscribedRects', () => {
  it('a rectangle has one: itself', () => {
    expect(inscribedRects(square)).toEqual([{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }]);
  });
  it('an L has two, its arms, the larger first — and the first is largestInscribedRect', () => {
    const all = inscribedRects(L);
    expect(all).toHaveLength(2);
    expect(all[0]).toEqual(largestInscribedRect(L));
    expect(all[0].w * all[0].h).toBeGreaterThanOrEqual(all[1].w * all[1].h);
    // Neither contains the other, and both are inside the L.
    const [a, b] = all;
    const contains = (o: typeof a, i: typeof a) => i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;
    expect(contains(a, b) || contains(b, a)).toBe(false);
    for (const r of all) {
      expect(pointInPolygon({ x: r.x + r.w / 2, y: r.y + r.h / 2 }, L)).toBe(true);
    }
  });
  it('the API DISPENSING room of Module-E: the tall arm is the larger, the wide arm is still offered', () => {
    // The L as drawn, in PDF points: the bay north of the room, and the room.
    const api = [{ x: 326.8, y: 253.5 }, { x: 382.6, y: 253.5 }, { x: 382.6, y: 321.2 }, { x: 435, y: 321.2 }, { x: 435, y: 389.9 }, { x: 326.8, y: 389.9 }];
    const [first, second] = inscribedRects(api);
    expect(first.h).toBeGreaterThan(first.w);        // 55.8 x 136.4
    expect(second.w).toBeGreaterThan(second.h);      // 108.2 x 68.7
    expect(second.w).toBeCloseTo(108.2, 6);
  });
});

describe('doorEdge', () => {
  it('maps the four wall names to edges 0..3 and passes an edge through', () => {
    expect(doorEdge({ wall: 'top' }, null)).toBe(0);
    expect(doorEdge({ wall: 'right' }, null)).toBe(1);
    expect(doorEdge({ wall: 'bottom' }, null)).toBe(2);
    expect(doorEdge({ wall: 'left' }, null)).toBe(3);
    expect(doorEdge({ edge: 5 }, L)).toBe(5);
    expect(doorEdge({ edge: 9 }, L)).toBe(-1);
  });
});

describe('centroid / isRectilinear / unionRectilinear', () => {
  it('the centroid of a square is its centre', () => {
    const c = centroid(square);
    expect(c.x).toBeCloseTo(0.2, 9);
    expect(c.y).toBeCloseTo(0.2, 9);
  });
  it('unions two touching rectangles into an L with six corners', () => {
    const a = rectanglePoints({ x: 0.1, y: 0.1, w: 0.4, h: 0.2 });
    const b = rectanglePoints({ x: 0.1, y: 0.3, w: 0.2, h: 0.2 });
    const u = unionRectilinear(a, b)!;
    expect(u).not.toBeNull();
    expect(u).toHaveLength(6);
    expect(polygonArea(u)).toBeCloseTo(0.12, 9);
    expect(isSimplePolygon(u)).toBe(true);
    expect(isRectilinear(u)).toBe(true);
  });
  it('refuses two rectangles that do not touch, and a non-rectilinear input', () => {
    expect(unionRectilinear(rectanglePoints({ x: 0, y: 0, w: 0.1, h: 0.1 }), rectanglePoints({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }))).toBeNull();
    expect(unionRectilinear([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }], square)).toBeNull();
  });
});
