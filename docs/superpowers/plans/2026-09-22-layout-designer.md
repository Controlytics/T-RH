# Layout Designer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Configuration → Floorplans with a Layout Designer that draws polygon rooms and corridors on a blank canvas, links rooms by openings and connectors, and has the dashboard draw the result.

**Architecture:** Polygon corners are stored beside the existing box (which becomes the polygon's bounding box, server-derived), so every box reader keeps working; doors move from wall names to edge indexes through one converter; links are a new table. One shared geometry module in `@digilog/shared` serves the API's validation, the designer and the dashboard. The designer is a folder under `routes/config/layout-designer/` with a pure tool reducer, pure snapping, an SVG canvas and a properties panel; every save goes through the existing audited, re-authenticated room endpoints plus three new link endpoints.

**Tech Stack:** TypeScript, Fastify 5 + Prisma 6 + zod (API), React 19 + SWR + SVG (web), vitest (all three packages).

**Spec:** `docs/superpowers/specs/2026-09-22-layout-designer-design.md`

## Global Constraints

- Coordinates are plan units 0..1 in storage and on the wire; the dashboard and the designer render in a 1000-wide viewBox and scale.
- A polygon has 3..64 corners, every corner in 0..1, no self-intersection, area ≥ 0.000025 (`0.005 × 0.005`).
- `x y w h` are the bounding box; when `points` is saved the server derives them and ignores any box sent.
- Rectangle wall names map to edges `top=0 right=1 bottom=2 left=3`, corners ordered top-left, top-right, bottom-right, bottom-left.
- Link kind and door kind are validated strings, never Postgres enums.
- Shared-edge tolerance is 0.0005 plan units (0.5 of 1000). Snap tolerance 0.01, grid 0.02, default door width 0.12 of its edge, six doors per room.
- Every migration is hand-authored, applied to `compliance_core_db` AND `compliance_core_db_test`, the `DROP TABLE instrument_telemetry_history` stripped, drift guard PASS.
- Every response field is declared in the Fastify response schema and asserted over `app.inject`.
- Run web test files ONE AT A TIME with `--pool=forks --poolOptions.forks.singleFork=true`; gate every commit on exit codes; `npm run build -w @digilog/shared` after any shared change.
- No count is quoted without re-deriving it (`grep -cE "^model "` etc.).
- The running data sender (`send-scenario-telemetry.ts`) may be posting; do not stop it.

---

### Task 1: Shared polygon geometry

**Files:**
- Create: `packages/shared/src/types/floorplan-geometry.ts`
- Create: `packages/shared/src/types/floorplan-geometry.test.ts`
- Modify: `packages/shared/src/index.ts` (append an export block after the `alarm-limits` block)

**Interfaces:**
- Produces (all exported): `Point`, `Box`, `Segment`, `Polygon`, `EdgeOpening`, `SharedEdge`, `POLYGON_MIN_CORNERS=3`, `POLYGON_MAX_CORNERS=64`, `POLYGON_MIN_AREA=0.000025`, `SHARED_EDGE_TOL=0.0005`, `WALL_EDGE`, `rectanglePoints(box): Polygon`, `boundingBox(points): Box`, `polygonArea(points): number`, `signedArea(points): number`, `polygonEdges(points): Segment[]`, `isSimplePolygon(points): boolean`, `validatePolygon(input: unknown): {ok:true; points: Polygon} | {ok:false; error: string}`, `pointInPolygon(p, points): boolean`, `sharedEdges(a, b, tol?): SharedEdge[]`, `mirrorOpening(a, opening, b, tol?): EdgeOpening | null`, `largestInscribedRect(points): Box`, `doorEdge(door: {wall?: string; edge?: number}, points: Polygon | null): number`, `centroid(points): Point`, `unionRectilinear(a, b): Polygon | null`, `isRectilinear(points): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/src/types/floorplan-geometry.test.ts
import { describe, it, expect } from 'vitest';
import {
  rectanglePoints, boundingBox, polygonArea, isSimplePolygon, validatePolygon,
  pointInPolygon, sharedEdges, mirrorOpening, largestInscribedRect, doorEdge,
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
    for (const c of rectanglePoints(r)) expect(pointInPolygon({ x: Math.min(0.499, Math.max(0.101, c.x)), y: Math.min(0.499, Math.max(0.101, c.y)) }, L)).toBe(true);
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
    expect(c.x).toBeCloseTo(0.2, 9); expect(c.y).toBeCloseTo(0.2, 9);
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd packages/shared && npx vitest run src/types/floorplan-geometry.test.ts`
Expected: FAIL, cannot resolve `./floorplan-geometry.js`.

- [ ] **Step 3: Write the module**

```ts
// packages/shared/src/types/floorplan-geometry.ts
/**
 * Polygon geometry for floor plans — ONE definition shared by the API's
 * validation, the Layout Designer and the dashboard's drawing, so a room the
 * designer lets you draw is a room the server accepts and the floor can draw.
 *
 * Coordinates are plan units 0..1 (storage and wire). Callers that render
 * scale to their viewBox first and pass the scaled polygon back in; every
 * function here is unit-agnostic except the two tolerances, which are in plan
 * units. y grows DOWN (screen convention), which is what `signedArea > 0`
 * means for a polygon drawn clockwise on screen.
 *
 * A rectangle is the four-corner polygon `rectanglePoints(box)`, corners in
 * the FIXED order top-left, top-right, bottom-right, bottom-left, so the four
 * wall names of a rectangle room are edges 0..3 (`WALL_EDGE`). That order is
 * load-bearing: `doorEdge` and the dashboard's rectangle path rely on it.
 */
export interface Point { x: number; y: number }
export interface Box { x: number; y: number; w: number; h: number }
export interface Segment { x1: number; y1: number; x2: number; y2: number }
export type Polygon = Point[];

/** An opening on an edge: fractions of THAT edge's length, like a door. */
export interface EdgeOpening { edge: number; offset: number; width: number }
/** The stretch of a's edge that coincides with b's edge, as fractions of a's edge. */
export interface SharedEdge { aEdge: number; bEdge: number; start: number; end: number }

export const POLYGON_MIN_CORNERS = 3;
export const POLYGON_MAX_CORNERS = 64;
/** 0.005 × 0.005 of the plan: a slip while drawing, never a room. */
export const POLYGON_MIN_AREA = 0.000025;
/** 0.5 of a 1000-unit viewBox, in plan units. */
export const SHARED_EDGE_TOL = 0.0005;

export const WALL_EDGE: Record<'top' | 'right' | 'bottom' | 'left', number> = { top: 0, right: 1, bottom: 2, left: 3 };

const clean = (n: number) => Math.round(n * 1e9) / 1e9;

export function rectanglePoints(box: Box): Polygon {
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ];
}

export function boundingBox(points: Polygon): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return { x: clean(minX), y: clean(minY), w: clean(maxX - minX), h: clean(maxY - minY) };
}

export function signedArea(points: Polygon): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export function polygonArea(points: Polygon): number {
  return Math.abs(signedArea(points));
}

export function polygonEdges(points: Polygon): Segment[] {
  return points.map((a, i) => {
    const b = points[(i + 1) % points.length];
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  });
}

const EPS = 1e-12;
function cross(ax: number, ay: number, bx: number, by: number) { return ax * by - ay * bx; }

/** Proper or touching intersection of two closed segments. */
function segmentsIntersect(p: Segment, q: Segment): boolean {
  const d1 = cross(q.x2 - q.x1, q.y2 - q.y1, p.x1 - q.x1, p.y1 - q.y1);
  const d2 = cross(q.x2 - q.x1, q.y2 - q.y1, p.x2 - q.x1, p.y2 - q.y1);
  const d3 = cross(p.x2 - p.x1, p.y2 - p.y1, q.x1 - p.x1, q.y1 - p.y1);
  const d4 = cross(p.x2 - p.x1, p.y2 - p.y1, q.x2 - p.x1, q.y2 - p.y1);
  if (((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))) return true;
  const on = (s: Segment, x: number, y: number) =>
    Math.min(s.x1, s.x2) - EPS <= x && x <= Math.max(s.x1, s.x2) + EPS && Math.min(s.y1, s.y2) - EPS <= y && y <= Math.max(s.y1, s.y2) + EPS;
  if (Math.abs(d1) <= EPS && on(q, p.x1, p.y1)) return true;
  if (Math.abs(d2) <= EPS && on(q, p.x2, p.y2)) return true;
  if (Math.abs(d3) <= EPS && on(p, q.x1, q.y1)) return true;
  if (Math.abs(d4) <= EPS && on(p, q.x2, q.y2)) return true;
  return false;
}

/**
 * No two NON-ADJACENT edges intersect, and no consecutive corners repeat.
 * Adjacent edges always share a corner and are skipped, as are the first and
 * last edges (which share corner 0).
 */
export function isSimplePolygon(points: Polygon): boolean {
  const n = points.length;
  if (n < POLYGON_MIN_CORNERS) return false;
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    if (Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS) return false;
  }
  const edges = polygonEdges(points);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      if (adjacent) continue;
      if (segmentsIntersect(edges[i], edges[j])) return false;
    }
  }
  return polygonArea(points) > 0;
}

export function validatePolygon(input: unknown): { ok: true; points: Polygon } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'points must be an array of corners' };
  if (input.length < POLYGON_MIN_CORNERS) return { ok: false, error: `a room needs at least ${POLYGON_MIN_CORNERS} corners` };
  if (input.length > POLYGON_MAX_CORNERS) return { ok: false, error: `a room may have at most ${POLYGON_MAX_CORNERS} corners` };
  const points: Polygon = [];
  for (const [i, c] of input.entries()) {
    const p = c as { x?: unknown; y?: unknown } | null;
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      return { ok: false, error: `corner ${i + 1} is not a point` };
    }
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return { ok: false, error: `corner ${i + 1} is outside the plan` };
    points.push({ x: p.x, y: p.y });
  }
  if (!isSimplePolygon(points)) return { ok: false, error: 'the outline crosses itself or repeats a corner' };
  if (polygonArea(points) < POLYGON_MIN_AREA) return { ok: false, error: 'the room is too small to be a room' };
  return { ok: true, points };
}

/** Ray casting; a point ON the boundary counts as inside. */
export function pointInPolygon(p: Point, points: Polygon): boolean {
  for (const e of polygonEdges(points)) {
    const d = cross(e.x2 - e.x1, e.y2 - e.y1, p.x - e.x1, p.y - e.y1);
    if (Math.abs(d) <= 1e-9
      && p.x >= Math.min(e.x1, e.x2) - 1e-9 && p.x <= Math.max(e.x1, e.x2) + 1e-9
      && p.y >= Math.min(e.y1, e.y2) - 1e-9 && p.y <= Math.max(e.y1, e.y2) + 1e-9) return true;
  }
  let inside = false;
  const n = points.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = points[i], b = points[j];
    if ((a.y > p.y) !== (b.y > p.y)) {
      const x = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
      if (p.x < x) inside = !inside;
    }
  }
  return inside;
}

function edgeLength(e: Segment) { return Math.hypot(e.x2 - e.x1, e.y2 - e.y1); }

/** Perpendicular distance from a point to the infinite line through an edge. */
function distToLine(e: Segment, p: Point): number {
  const len = edgeLength(e);
  if (len < EPS) return Infinity;
  return Math.abs(cross(e.x2 - e.x1, e.y2 - e.y1, p.x - e.x1, p.y - e.y1)) / len;
}

/** Fraction along an edge of the projection of p. */
function paramAlong(e: Segment, p: Point): number {
  const dx = e.x2 - e.x1, dy = e.y2 - e.y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < EPS) return 0;
  return ((p.x - e.x1) * dx + (p.y - e.y1) * dy) / len2;
}

/**
 * Every stretch where an edge of `a` lies along an edge of `b` (both
 * endpoints of b's edge within `tol` of a's line, and the projections
 * overlap by more than `tol`). A corner touch is not a shared edge.
 */
export function sharedEdges(a: Polygon, b: Polygon, tol = SHARED_EDGE_TOL): SharedEdge[] {
  const out: SharedEdge[] = [];
  const ea = polygonEdges(a), eb = polygonEdges(b);
  ea.forEach((e, i) => {
    const len = edgeLength(e);
    if (len < EPS) return;
    eb.forEach((f, j) => {
      if (distToLine(e, { x: f.x1, y: f.y1 }) > tol || distToLine(e, { x: f.x2, y: f.y2 }) > tol) return;
      const t1 = paramAlong(e, { x: f.x1, y: f.y1 }), t2 = paramAlong(e, { x: f.x2, y: f.y2 });
      const start = Math.max(0, Math.min(t1, t2)), end = Math.min(1, Math.max(t1, t2));
      if ((end - start) * len > tol) out.push({ aEdge: i, bEdge: j, start: clean(start), end: clean(end) });
    });
  });
  return out;
}

/**
 * The same opening seen from the neighbour: where `opening` on a's edge lands
 * on b's coincident edge. Null when that edge is not shared. The neighbour's
 * edge usually runs the other way (a clockwise outline meets its neighbour's
 * clockwise outline head-on), which is why the fractions are re-projected
 * rather than copied.
 */
export function mirrorOpening(a: Polygon, opening: EdgeOpening, b: Polygon, tol = SHARED_EDGE_TOL): EdgeOpening | null {
  const shared = sharedEdges(a, b, tol).find((s) => s.aEdge === opening.edge);
  if (!shared) return null;
  const e = polygonEdges(a)[opening.edge], f = polygonEdges(b)[shared.bEdge];
  const p1 = { x: e.x1 + (e.x2 - e.x1) * opening.offset, y: e.y1 + (e.y2 - e.y1) * opening.offset };
  const p2 = { x: e.x1 + (e.x2 - e.x1) * (opening.offset + opening.width), y: e.y1 + (e.y2 - e.y1) * (opening.offset + opening.width) };
  const u1 = paramAlong(f, p1), u2 = paramAlong(f, p2);
  const lo = Math.max(0, Math.min(u1, u2)), hi = Math.min(1, Math.max(u1, u2));
  if (hi <= lo) return null;
  return { edge: shared.bEdge, offset: clean(lo), width: clean(hi - lo) };
}

function uniqSorted(values: number[]): number[] {
  const out = [...new Set(values.map(clean))].sort((p, q) => p - q);
  return out;
}

/**
 * The largest axis-aligned rectangle inside the polygon, by grid search over
 * the corners' x and y coordinates: every candidate cell's CENTRE is tested,
 * which is exact for a rectilinear polygon (every notch edge is on the grid)
 * and a fair approximation otherwise. The readings tiles lay out inside it,
 * so an L-shaped room never has a tile hanging outside a wall.
 */
export function largestInscribedRect(points: Polygon): Box {
  const xs = uniqSorted(points.map((p) => p.x)), ys = uniqSorted(points.map((p) => p.y));
  const nx = xs.length - 1, ny = ys.length - 1;
  if (nx < 1 || ny < 1) return boundingBox(points);
  // inside[i][j] = 1 when cell (i, j) is inside; prefix sums for O(1) rectangle sums.
  const pre: number[][] = Array.from({ length: nx + 1 }, () => new Array<number>(ny + 1).fill(0));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const c = { x: (xs[i] + xs[i + 1]) / 2, y: (ys[j] + ys[j + 1]) / 2 };
      const v = pointInPolygon(c, points) ? 1 : 0;
      pre[i + 1][j + 1] = v + pre[i][j + 1] + pre[i + 1][j] - pre[i][j];
    }
  }
  let best: Box = { x: xs[0], y: ys[0], w: 0, h: 0 }, bestArea = 0;
  for (let i0 = 0; i0 < nx; i0++) for (let i1 = i0 + 1; i1 <= nx; i1++) {
    for (let j0 = 0; j0 < ny; j0++) for (let j1 = j0 + 1; j1 <= ny; j1++) {
      const cells = (i1 - i0) * (j1 - j0);
      const sum = pre[i1][j1] - pre[i0][j1] - pre[i1][j0] + pre[i0][j0];
      if (sum !== cells) continue;
      const area = (xs[i1] - xs[i0]) * (ys[j1] - ys[j0]);
      if (area > bestArea) { bestArea = area; best = { x: xs[i0], y: ys[j0], w: clean(xs[i1] - xs[i0]), h: clean(ys[j1] - ys[j0]) }; }
    }
  }
  return bestArea > 0 ? best : boundingBox(points);
}

/**
 * Which edge a door sits on. A door stored by wall name (every door drawn
 * before 2026-09-22) maps through WALL_EDGE; a door stored by edge index is
 * checked against the polygon it names. -1 = no such edge, which the caller
 * treats as "draw nothing" rather than throwing inside a render.
 */
export function doorEdge(door: { wall?: string; edge?: number }, points: Polygon | null): number {
  const n = points ? points.length : 4;
  if (typeof door.edge === 'number' && Number.isInteger(door.edge)) return door.edge >= 0 && door.edge < n ? door.edge : -1;
  const e = door.wall ? WALL_EDGE[door.wall as keyof typeof WALL_EDGE] : undefined;
  return typeof e === 'number' && e < n ? e : -1;
}

export function centroid(points: Polygon): Point {
  const a = signedArea(points);
  if (Math.abs(a) < EPS) {
    const b = boundingBox(points);
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }
  let cx = 0, cy = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i], q = points[(i + 1) % points.length];
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f; cy += (p.y + q.y) * f;
  }
  return { x: clean(cx / (6 * a)), y: clean(cy / (6 * a)) };
}

export function isRectilinear(points: Polygon): boolean {
  return polygonEdges(points).every((e) => Math.abs(e.x1 - e.x2) < 1e-9 || Math.abs(e.y1 - e.y2) < 1e-9);
}

/**
 * The outline of two rectilinear polygons that touch or overlap, as ONE
 * polygon; null when they do not touch, when either is not rectilinear, or
 * when the union would have a hole. Grid method: mark the cells inside either,
 * keep the cell edges that are not shared by two inside cells, chain them.
 */
export function unionRectilinear(a: Polygon, b: Polygon): Polygon | null {
  if (!isRectilinear(a) || !isRectilinear(b)) return null;
  const xs = uniqSorted([...a, ...b].map((p) => p.x)), ys = uniqSorted([...a, ...b].map((p) => p.y));
  const nx = xs.length - 1, ny = ys.length - 1;
  const inside = (i: number, j: number) => {
    if (i < 0 || j < 0 || i >= nx || j >= ny) return false;
    const c = { x: (xs[i] + xs[i + 1]) / 2, y: (ys[j] + ys[j + 1]) / 2 };
    return pointInPolygon(c, a) || pointInPolygon(c, b);
  };
  // Touching means at least one inside cell of a is edge-adjacent to one of b, or they overlap.
  let touch = false;
  for (let i = 0; i < nx && !touch; i++) for (let j = 0; j < ny && !touch; j++) {
    if (!inside(i, j)) continue;
    const ca = { x: (xs[i] + xs[i + 1]) / 2, y: (ys[j] + ys[j + 1]) / 2 };
    const inA = pointInPolygon(ca, a), inB = pointInPolygon(ca, b);
    if (inA && inB) touch = true;
    const nb: [number, number][] = [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]];
    for (const [p, q] of nb) {
      if (!inside(p, q)) continue;
      const cb = { x: (xs[Math.max(0, Math.min(nx - 1, p))] + xs[Math.max(0, Math.min(nx - 1, p)) + 1]) / 2, y: (ys[Math.max(0, Math.min(ny - 1, q))] + ys[Math.max(0, Math.min(ny - 1, q)) + 1]) / 2 };
      if ((inA && pointInPolygon(cb, b) && !pointInPolygon(cb, a)) || (inB && pointInPolygon(cb, a) && !pointInPolygon(cb, b))) touch = true;
    }
  }
  if (!touch) return null;
  // Directed boundary edges, clockwise around each inside cell (y down): top L→R, right T→B, bottom R→L, left B→T.
  const key = (p: Point) => `${clean(p.x)},${clean(p.y)}`;
  const next = new Map<string, Point[]>();
  const add = (from: Point, to: Point) => { const k = key(from); next.set(k, [...(next.get(k) ?? []), to]); };
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    if (!inside(i, j)) continue;
    const tl = { x: xs[i], y: ys[j] }, tr = { x: xs[i + 1], y: ys[j] }, br = { x: xs[i + 1], y: ys[j + 1] }, bl = { x: xs[i], y: ys[j + 1] };
    if (!inside(i, j - 1)) add(tl, tr);
    if (!inside(i + 1, j)) add(tr, br);
    if (!inside(i, j + 1)) add(br, bl);
    if (!inside(i - 1, j)) add(bl, tl);
  }
  let total = 0; for (const v of next.values()) total += v.length;
  if (total === 0) return null;
  // Chain from the top-left-most start; a second loop means a hole → null.
  const startKey = [...next.keys()].sort()[0];
  const [sx, sy] = startKey.split(',').map(Number);
  const loop: Point[] = [];
  let cur = { x: sx, y: sy };
  let steps = 0;
  do {
    loop.push(cur);
    const cands = next.get(key(cur));
    if (!cands || cands.length === 0) return null;
    cur = cands.shift()!;
    if (++steps > total) return null;
  } while (key(cur) !== startKey);
  let remaining = 0; for (const v of next.values()) remaining += v.length;
  if (remaining !== 0) return null;
  // Drop collinear intermediate corners.
  const out: Polygon = [];
  for (let i = 0; i < loop.length; i++) {
    const p = loop[(i - 1 + loop.length) % loop.length], c = loop[i], n = loop[(i + 1) % loop.length];
    const collinear = (Math.abs(p.x - c.x) < 1e-9 && Math.abs(c.x - n.x) < 1e-9) || (Math.abs(p.y - c.y) < 1e-9 && Math.abs(c.y - n.y) < 1e-9);
    if (!collinear) out.push({ x: clean(c.x), y: clean(c.y) });
  }
  return out.length >= 3 ? out : null;
}
```

- [ ] **Step 4: Export it and run the tests**

Append to `packages/shared/src/index.ts` after the `alarm-limits` export block:

```ts
export {
  POLYGON_MIN_CORNERS, POLYGON_MAX_CORNERS, POLYGON_MIN_AREA, SHARED_EDGE_TOL, WALL_EDGE,
  rectanglePoints, boundingBox, polygonArea, signedArea, polygonEdges, isSimplePolygon,
  validatePolygon, pointInPolygon, sharedEdges, mirrorOpening, largestInscribedRect,
  doorEdge, centroid, isRectilinear, unionRectilinear,
} from './types/floorplan-geometry.js';
export type { Point, Box, Segment, Polygon, EdgeOpening, SharedEdge } from './types/floorplan-geometry.js';
```

Run: `cd packages/shared && npx vitest run src/types/floorplan-geometry.test.ts` → all pass. Then `npm run build -w @digilog/shared` from the repo root.

- [ ] **Step 5: Mutation-check** — in `isSimplePolygon` change `if (adjacent) continue;` to `if (!adjacent) continue;` → the bow-tie case fails; restore. In `largestInscribedRect` return `boundingBox(points)` unconditionally → the L case fails; restore. Confirm with `git diff --stat` that only the intended files changed.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types/floorplan-geometry.ts packages/shared/src/types/floorplan-geometry.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): floorplan polygon geometry — one definition for the API, the designer and the dashboard"
```

---

### Task 2: Schema and migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (models `Floorplan`, `FloorplanRoom`; new `FloorplanRoomLink`)
- Create: `apps/api/prisma/migrations/20260922120000_floorplan_polygons_links/migration.sql`

**Interfaces:**
- Produces: Prisma client with `floorplan.imagePath: string | null`, `floorplanRoom.points: Prisma.JsonValue | null`, `floorplanRoom.linksFrom/linksTo`, `floorplan.links`, model `FloorplanRoomLink { id, floorplanId, fromRoomId, toRoomId, kind, fromEdge, offset, width, door, label, createdAt, updatedAt, createdBy, updatedBy }`.

- [ ] **Step 1: Edit the schema**

In `model Floorplan`: change `imagePath   String   @map("image_path")` to `imagePath   String?  @map("image_path")` with the doc comment `/// NULL for a plan drawn from a blank canvas in the Layout Designer (2026-09-22); the width/height then hold the chosen canvas size, not an image's pixels.` Add `links FloorplanRoomLink[]` beside `rooms FloorplanRoom[]`.

In `model FloorplanRoom`, after `meta Json?`:

```prisma
  /// The room's outline as corners `[{x, y}, …]` in plan units 0..1, drawn
  /// order, closing edge implied (Layout Designer, 2026-09-22). NULL = a
  /// rectangle, whose outline IS `x/y/w/h` — every room drawn before this
  /// column and every room the trace scripts write. When present, `x/y/w/h`
  /// are the polygon's BOUNDING BOX, derived by the server on every write, so
  /// every reader that needs only a box is untouched. Validated in
  /// floorplans/validation.ts through @digilog/shared's `validatePolygon`.
  points Json?

  linksFrom FloorplanRoomLink[] @relation("linkFrom")
  linksTo   FloorplanRoomLink[] @relation("linkTo")
```

After `model FloorplanRoom`'s closing brace add:

```prisma
/// A relation the drawing states between two rooms of one plan (Layout
/// Designer, 2026-09-22). `kind` is a validated string, not a Postgres enum
/// (the `grade` precedent): OPENING = a gap in the wall the two rooms share,
/// on `fromRoom`'s edge `fromEdge` at `offset`/`width` (fractions of that edge)
/// with an optional door leaf `door` (ENTRY | EXIT | PASSAGE); CONNECTOR = a
/// drawn line between two rooms that do not touch, optionally labelled. The
/// dashboard mirrors an OPENING onto the neighbour's edge at render time
/// (`mirrorOpening`), so only one side is stored. Cascades with either room.
model FloorplanRoomLink {
  id          String   @id @default(uuid())
  floorplanId String   @map("floorplan_id")
  fromRoomId  String   @map("from_room_id")
  toRoomId    String   @map("to_room_id")
  kind        String
  fromEdge    Int?     @map("from_edge")
  offset      Float?
  width       Float?
  door        String?
  label       String?
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)
  createdBy   String?  @map("created_by")
  updatedBy   String?  @map("updated_by")

  floorplan Floorplan     @relation(fields: [floorplanId], references: [id], onDelete: Cascade)
  fromRoom  FloorplanRoom @relation("linkFrom", fields: [fromRoomId], references: [id], onDelete: Cascade)
  toRoom    FloorplanRoom @relation("linkTo", fields: [toRoomId], references: [id], onDelete: Cascade)

  @@index([floorplanId])
  @@map("floorplan_room_links")
}
```

- [ ] **Step 2: Write the migration**

```sql
-- Layout Designer (2026-09-22): polygon rooms, room links, blank plans.
--
--   floorplan_rooms.points        the outline as corners, NULL = a rectangle
--                                 (x/y/w/h stay and become the bounding box)
--   floorplans.image_path         nullable — a plan may start from a blank canvas
--   floorplan_room_links          OPENING (a gap in a shared wall) or CONNECTOR
--                                 (a drawn line) between two rooms of one plan;
--                                 `kind` is a validated string, not an enum
--
-- No backfill: NULL points render exactly as the rectangle rendered before.
--
-- HAND-AUTHORED. `prisma migrate diff` also emits
--   DROP TABLE "instrument_telemetry_history";
-- which is STRIPPED here as in every migration since 2026-08-08: that table is
-- partitioned, invisible to the datamodel, and holds live telemetry. See
-- apps/api/src/lib/migration-guard.ts.

ALTER TABLE "floorplan_rooms" ADD COLUMN "points" JSONB;
ALTER TABLE "floorplans" ALTER COLUMN "image_path" DROP NOT NULL;

CREATE TABLE "floorplan_room_links" (
    "id" TEXT NOT NULL,
    "floorplan_id" TEXT NOT NULL,
    "from_room_id" TEXT NOT NULL,
    "to_room_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "from_edge" INTEGER,
    "offset" DOUBLE PRECISION,
    "width" DOUBLE PRECISION,
    "door" TEXT,
    "label" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,
    CONSTRAINT "floorplan_room_links_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "floorplan_room_links_floorplan_id_idx" ON "floorplan_room_links"("floorplan_id");
ALTER TABLE "floorplan_room_links" ADD CONSTRAINT "floorplan_room_links_floorplan_id_fkey"
  FOREIGN KEY ("floorplan_id") REFERENCES "floorplans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "floorplan_room_links" ADD CONSTRAINT "floorplan_room_links_from_room_id_fkey"
  FOREIGN KEY ("from_room_id") REFERENCES "floorplan_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "floorplan_room_links" ADD CONSTRAINT "floorplan_room_links_to_room_id_fkey"
  FOREIGN KEY ("to_room_id") REFERENCES "floorplan_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Apply to both databases and regenerate the client**

The API dev server holds the Prisma engine DLL: stop its three node processes (see memory: `Get-CimInstance Win32_Process -Filter "Name='node.exe'"`, the `tsx watch src/app.ts` tree), then from `apps/api`:

```bash
npx prisma migrate deploy                                   # DATABASE_URL from apps/api/.env
DATABASE_URL="<same url with /compliance_core_db_test>" npx prisma migrate deploy
npx prisma generate
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-migrations.ps1   # drift guard: PASS
npm run check:migrations                                    # migration guard: PASS
```

Restart the API detached: `Start-Process -FilePath "npx.cmd" -ArgumentList "tsx","watch","src/app.ts" -WorkingDirectory "C:\Users\hello\compliance-core\apps\api" -WindowStyle Hidden`, then `curl -sk --ssl-revoke-best-effort -o /dev/null -w "%{http_code}" https://localhost:3001/api/health` → 200.

- [ ] **Step 4: Verify and commit**

`grep -cE "^model " apps/api/prisma/schema.prisma` → 37. `npx tsc --noEmit -p apps/api/tsconfig.json` → clean (nothing reads the new fields yet).

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260922120000_floorplan_polygons_links/migration.sql
git commit -m "feat(db): floorplan polygon points, room links table, nullable plan image"
```

---

### Task 3: API — polygon rooms

**Files:**
- Modify: `apps/api/src/modules/floorplans/validation.ts`
- Modify: `apps/api/src/modules/floorplans/routes.ts` (roomSelect, roomProps, planProps, room POST/PUT, plan POST schema use)
- Modify: `apps/api/src/modules/floorplans/__tests__/validation.test.ts` (add cases)
- Create: `apps/api/src/e2e/floorplan-polygons.e2e.test.ts`

**Interfaces:**
- Consumes: `validatePolygon`, `boundingBox`, `doorEdge` from `@digilog/shared`.
- Produces: `roomSchema` accepting `points` and door `edge`; `RoomInput.points?: Point[] | null`; response `points` and door `edge` on every room; `floorplanSchema.imagePath` nullable/optional.

- [ ] **Step 1: Validation**

In `validation.ts`, import `{ validatePolygon, doorEdge, WALL_EDGE, type Polygon } from '@digilog/shared'`. Change `doorSchema` so `wall` is optional and add `edge`:

```ts
const doorSchema = z.object({
  wall: z.enum(DOOR_WALLS).optional(),
  edge: z.number().int().min(0).max(63).optional(),
  offset: normalized,
  width: normalized.refine((v) => v > 0, { message: 'must be greater than 0' }),
  kind: z.enum(DOOR_KINDS),
}).refine((d) => d.wall !== undefined || d.edge !== undefined, { message: 'a door names its wall or its edge' })
  .refine((d) => d.offset + d.width <= 1 + 1e-9, { message: 'a door must finish on its wall' });
```

(Keep whatever overlap refinement the file already applies to the array; read the existing `doorSchema`/array refinements first and preserve them, only widening the object.)

Add to `roomSchema`:

```ts
  points: z.array(z.object({ x: z.number(), y: z.number() })).nullable().optional(),
```

and a `superRefine` on the whole schema:

```ts
.superRefine((room, ctx) => {
  if (room.points) {
    const v = validatePolygon(room.points);
    if (!v.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['points'], message: v.error });
  }
  const poly: Polygon | null = room.points ?? null;
  (room.doors ?? []).forEach((d, i) => {
    if (doorEdge(d, poly) < 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['doors', i], message: 'names an edge the room does not have' });
  });
})
```

Export `export function roomGeometry(room: RoomInput): { x: number; y: number; w: number; h: number }` returning `boundingBox(room.points)` when points are present, else the sent box.

Change `floorplanSchema.imagePath` to `z.string().trim().min(1).max(500).nullable().optional()`.

Add to `validation.test.ts`:

```ts
describe('polygon rooms', () => {
  const base = { code: 'R1', x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
  it('accepts a simple polygon and derives its box', () => {
    const r = validateRoomPayload({ ...base, points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.3 }, { x: 0.3, y: 0.3 }, { x: 0.3, y: 0.5 }, { x: 0.1, y: 0.5 }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(roomGeometry(r.data)).toEqual({ x: 0.1, y: 0.1, w: 0.4, h: 0.4 });
  });
  it('refuses a bow-tie, naming points', () => {
    const r = validateRoomPayload({ ...base, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/points/);
  });
  it('accepts a door by edge on a polygon and refuses one past its last edge', () => {
    const tri = [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.1, y: 0.5 }];
    expect(validateRoomPayload({ ...base, points: tri, doors: [{ edge: 2, offset: 0.2, width: 0.2, kind: 'ENTRY' }] }).ok).toBe(true);
    expect(validateRoomPayload({ ...base, points: tri, doors: [{ edge: 3, offset: 0.2, width: 0.2, kind: 'ENTRY' }] }).ok).toBe(false);
  });
  it('a rectangle door still names a wall', () => {
    expect(validateRoomPayload({ ...base, doors: [{ wall: 'top', offset: 0.2, width: 0.2, kind: 'ENTRY' }] }).ok).toBe(true);
    expect(validateRoomPayload({ ...base, doors: [{ offset: 0.2, width: 0.2, kind: 'ENTRY' }] }).ok).toBe(false);
  });
});
```

Run `cd apps/api && npx vitest run src/modules/floorplans/__tests__/validation.test.ts` → the new cases fail before the edit, pass after.

- [ ] **Step 2: Routes**

In `routes.ts`:
- `roomSelect` gains `points: true`.
- `roomProps` gains `points: { type: 'array', nullable: true, items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } } }` and the door item gains `edge: { type: 'integer', nullable: true }`, `wall: { type: 'string', nullable: true }`.
- `planProps.imagePath` becomes `{ type: 'string', nullable: true }`.
- `doorSummary` prints `${door.kind} on ${door.wall ?? `edge ${door.edge}`} @ ${door.offset}`.
- Room POST: `const { doors, points, ...roomData } = result.data;` then `data: { ...roomData, ...roomGeometry(result.data), points: points ?? Prisma.DbNull, doors: doorsForWrite(doors), … }`; the audit `afterValue.geometry` gains `corners: points?.length ?? 4`.
- Room PUT: same derivation; `points` OMITTED leaves the column unchanged (spread `...(points !== undefined ? { points: points ?? Prisma.DbNull } : {})`) and the box is derived only when points were sent — when `points` is omitted AND the stored row has points, the sent box must not overwrite the derived one: read `before.points`; if `points === undefined && before.points` then `roomGeometry({ ...result.data, points: before.points as Point[] })`. Add a comment: "a client that predates polygons must not flatten a polygon room's box".
- Plan POST/PUT: `imagePath: body.imagePath ?? null` passes through the schema change; nothing else.

Run `npx tsc --noEmit -p apps/api/tsconfig.json` → clean.

- [ ] **Step 3: e2e**

```ts
// apps/api/src/e2e/floorplan-polygons.e2e.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';

let app: FastifyInstance;
let auth: Record<string, string>;
const s = Date.now();
const plans: string[] = [];
const L = [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.3 }, { x: 0.3, y: 0.3 }, { x: 0.3, y: 0.5 }, { x: 0.1, y: 0.5 }];

beforeAll(async () => { app = await buildApp(); auth = { authorization: `Bearer ${await loginAs(app)}` }; });
afterAll(async () => { for (const id of plans) await prisma.floorplan.deleteMany({ where: { id } }); await app.close(); });

async function blankPlan(name: string) {
  const res = await app.inject({ method: 'POST', url: '/api/floorplans', headers: auth, payload: { name, imagePath: null, imageWidth: 1600, imageHeight: 1200 } });
  expect(res.statusCode).toBe(201);
  plans.push(res.json().id);
  return res.json() as { id: string };
}
const room = (planId: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/floorplans/${planId}/rooms`, headers: auth, payload: { code: `R${Math.random()}`, x: 0.1, y: 0.1, w: 0.2, h: 0.2, ...payload } });

describe('polygon rooms', () => {
  it('a plan can start blank, with no image', async () => {
    const p = await blankPlan(`Blank ${s}`);
    const got = await app.inject({ method: 'GET', url: `/api/floorplans/${p.id}`, headers: auth });
    expect(got.json().imagePath).toBeNull();
    expect(got.json().imageWidth).toBe(1600);
  });
  it('saves points and derives the box, and returns points over the wire', async () => {
    const p = await blankPlan(`Poly ${s}`);
    const res = await room(p.id, { code: 'L', points: L, x: 0, y: 0, w: 0.01, h: 0.01 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ x: 0.1, y: 0.1, w: 0.4, h: 0.4 });
    expect(res.json().points).toEqual(L);
    const list = await app.inject({ method: 'GET', url: '/api/floorplans', headers: auth });
    const mine = (list.json().data as { id: string; rooms: { code: string; points: unknown }[] }[]).find((x) => x.id === p.id)!;
    expect(mine.rooms[0].points).toEqual(L);
  });
  it('refuses a bow-tie and a corner outside the plan by field', async () => {
    const p = await blankPlan(`Bad ${s}`);
    const bow = await room(p.id, { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }] });
    expect(bow.statusCode).toBe(400); expect(bow.json().message).toMatch(/points/);
    const out = await room(p.id, { points: [{ x: 0, y: 0 }, { x: 1.5, y: 0 }, { x: 1, y: 1 }] });
    expect(out.statusCode).toBe(400);
  });
  it('an omitted points key keeps the polygon (and its derived box); an explicit null clears it', async () => {
    const p = await blankPlan(`Keep ${s}`);
    const id = (await room(p.id, { code: 'K', points: L })).json().id as string;
    const kept = await app.inject({ method: 'PUT', url: `/api/floorplans/${p.id}/rooms/${id}`, headers: auth, payload: { code: 'K2', x: 0, y: 0, w: 0.05, h: 0.05 } });
    expect(kept.json().points).toEqual(L);
    expect(kept.json()).toMatchObject({ x: 0.1, w: 0.4 });
    const cleared = await app.inject({ method: 'PUT', url: `/api/floorplans/${p.id}/rooms/${id}`, headers: auth, payload: { code: 'K2', x: 0, y: 0, w: 0.05, h: 0.05, points: null } });
    expect(cleared.json().points).toBeNull();
    expect(cleared.json()).toMatchObject({ x: 0, w: 0.05 });
  });
  it('a door by edge is stored and returned; a door on a missing edge is refused', async () => {
    const p = await blankPlan(`Door ${s}`);
    const ok = await room(p.id, { points: L, doors: [{ edge: 4, offset: 0.2, width: 0.2, kind: 'ENTRY' }] });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().doors[0].edge).toBe(4);
    const bad = await room(p.id, { points: L, doors: [{ edge: 6, offset: 0.2, width: 0.2, kind: 'ENTRY' }] });
    expect(bad.statusCode).toBe(400);
  });
});
```

Run: `cd apps/api && npx vitest run src/e2e/floorplan-polygons.e2e.test.ts --pool=forks --poolOptions.forks.singleFork=true` → pass. Mutation-check: delete the `points` line from `roomProps` → the two "returns points" assertions fail; restore. Also run `src/e2e/floorplans.e2e.test.ts` and `src/e2e/floorplan-annotations.e2e.test.ts` → unchanged green.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/floorplans/validation.ts apps/api/src/modules/floorplans/routes.ts apps/api/src/modules/floorplans/__tests__/validation.test.ts apps/api/src/e2e/floorplan-polygons.e2e.test.ts
git commit -m "feat(api): polygon rooms — points beside the box, doors by edge, blank plans"
```

---

### Task 4: API — room links

**Files:**
- Modify: `apps/api/src/modules/floorplans/validation.ts` (add `linkSchema`, `validateLinkPayload`)
- Modify: `apps/api/src/modules/floorplans/routes.ts` (linkSelect/linkProps, plan GET include, three routes)
- Modify: `packages/shared/src/types/audit-actions.ts`, `packages/shared/src/types/audit-templates.ts`
- Modify: `apps/web/src/routes/audit/audit-helpers.ts` (no new placeholder: the sentence uses `{room}`; confirm `template-placeholders.test.ts` stays green)
- Create: `apps/api/src/e2e/floorplan-links.e2e.test.ts`

**Interfaces:**
- Produces: `POST /api/floorplans/:id/links`, `PUT /api/floorplans/:id/links/:linkId`, `DELETE …/links/:linkId`; link shape on the wire `{ id, fromRoomId, toRoomId, kind, fromEdge, offset, width, door, label }`; plans in `GET /api/floorplans` and `GET /:id` carry `links: Link[]`.

- [ ] **Step 1: Audit registry**

In `audit-actions.ts` after `FLOORPLAN_ROOM_DELETED` add `FLOORPLAN_LINK_CREATED`, `FLOORPLAN_LINK_UPDATED`, `FLOORPLAN_LINK_DELETED`. In `audit-templates.ts` after `FLOORPLAN_ROOM_DELETED`:

```ts
  // A link between two rooms: an opening in their shared wall or a drawn
  // connector (Layout Designer, 2026-09-22). `{room}` carries "A ↔ B" — the
  // route writes it as `code` so the existing substitution prints it.
  FLOORPLAN_LINK_CREATED: { label: 'Room Link Created', category: 'Instruments', template: 'Room link {room} created by {actor}', placeholders: ['actor', 'room'] },
  FLOORPLAN_LINK_UPDATED: { label: 'Room Link Updated', category: 'Instruments', template: 'Room link {room} updated by {actor}', placeholders: ['actor', 'room'] },
  FLOORPLAN_LINK_DELETED: { label: 'Room Link Deleted', category: 'Instruments', template: 'Room link {room} deleted by {actor}', placeholders: ['actor', 'room'] },
```

`npm run build -w @digilog/shared`; run `packages/shared` tests and `apps/web/src/routes/audit/__tests__/template-placeholders.test.ts` individually → green. `grep -cE "^\s+[A-Z_]+: '[A-Z_]+'" packages/shared/src/types/audit-actions.ts` → 106.

- [ ] **Step 2: Validation**

```ts
export const LINK_KINDS = ['OPENING', 'CONNECTOR'] as const;
export const linkSchema = z.object({
  fromRoomId: z.string().uuid(),
  toRoomId: z.string().uuid(),
  kind: z.enum(LINK_KINDS),
  fromEdge: z.number().int().min(0).max(63).nullable().optional(),
  offset: normalized.nullable().optional(),
  width: normalized.nullable().optional(),
  door: z.enum(DOOR_KINDS).nullable().optional(),
  label: z.string().trim().max(60).nullable().optional(),
}).superRefine((l, ctx) => {
  if (l.fromRoomId === l.toRoomId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['toRoomId'], message: 'a room cannot link to itself' });
  if (l.kind === 'OPENING') {
    if (l.fromEdge == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fromEdge'], message: 'an opening names the edge it sits on' });
    if (l.offset == null || l.width == null || l.width <= 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['width'], message: 'an opening has a position and a width' });
    else if (l.offset + l.width > 1 + 1e-9) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['width'], message: 'an opening must finish on its edge' });
  }
});
export type LinkInput = z.infer<typeof linkSchema>;
export function validateLinkPayload(input: unknown): { ok: true; data: LinkInput } | { ok: false; error: string } { /* same shape as validateRoomPayload */ }
```

- [ ] **Step 3: Routes**

```ts
const linkSelect = { id: true, fromRoomId: true, toRoomId: true, kind: true, fromEdge: true, offset: true, width: true, door: true, label: true } as const;
const linkProps = {
  id: { type: 'string' }, fromRoomId: { type: 'string' }, toRoomId: { type: 'string' }, kind: { type: 'string' },
  fromEdge: { type: 'integer', nullable: true }, offset: { type: 'number', nullable: true }, width: { type: 'number', nullable: true },
  door: { type: 'string', nullable: true }, label: { type: 'string', nullable: true },
} as const;
```

`GET /`: add `links: { select: linkSelect }` to the include and `links: { type: 'array', items: { type: 'object', properties: linkProps } }` beside `rooms` in the response schema. `GET /:id`: add `links: { select: linkSelect }` to the include (schema is `additionalProperties: true`).

Helper inside the plugin:

```ts
/** Both rooms on this plan, and for an OPENING the named edge really shared, or a 400/404 the client can act on. */
async function checkLink(planId: string, l: LinkInput, reply: FastifyReply): Promise<{ from: RoomRow; to: RoomRow } | null> {
  const rooms = await prisma.floorplanRoom.findMany({ where: { floorplanId: planId, id: { in: [l.fromRoomId, l.toRoomId] } }, select: { id: true, code: true, x: true, y: true, w: true, h: true, points: true } });
  const from = rooms.find((r) => r.id === l.fromRoomId), to = rooms.find((r) => r.id === l.toRoomId);
  if (!from || !to) { reply.code(404).send({ error: 'NOT_FOUND', message: 'Both rooms must be on this floorplan.' }); return null; }
  if (l.kind === 'OPENING') {
    const pa = polygonOf(from), pb = polygonOf(to);
    const shared = sharedEdges(pa, pb).find((s) => s.aEdge === l.fromEdge && s.start - 1e-9 <= l.offset! && l.offset! + l.width! <= s.end + 1e-9);
    if (!shared) { reply.code(400).send({ error: 'NOT_ADJACENT', message: `"${from.code}" and "${to.code}" do not share that stretch of wall.` }); return null; }
  }
  if (l.kind === 'CONNECTOR') {
    const dup = await prisma.floorplanRoomLink.findFirst({ where: { floorplanId: planId, kind: 'CONNECTOR', OR: [{ fromRoomId: l.fromRoomId, toRoomId: l.toRoomId }, { fromRoomId: l.toRoomId, toRoomId: l.fromRoomId }] } });
    if (dup && dup.id !== currentLinkId) { reply.code(409).send({ error: 'DUPLICATE_LINK', message: 'These two rooms are already connected.' }); return null; }
  }
  return { from, to };
}
const polygonOf = (r: { x: number; y: number; w: number; h: number; points: unknown }) =>
  Array.isArray(r.points) ? (r.points as Point[]) : rectanglePoints(r);
```

(`currentLinkId` is a parameter: `null` on POST, the link's id on PUT.)

Routes, each `CONFIG_UPDATE` + `enforceReauth('UPDATE_FLOORPLAN_ROOM')`, sanitised with `sanitizeStrings(body, ['label'])`, audited with `targetType: 'floorplan_room_link'` and `code: \`${from.code} ↔ ${to.code}\`` in the after/before value, `signatureMeaning` `Room link "A ↔ B" created on floorplan "<name>"`:
- `POST /:id/links` → 201 with `linkProps`.
- `PUT /:id/links/:linkId` → 200; 404 when the link is not on this plan; before/after audited.
- `DELETE /:id/links/:linkId` → 204; beforeValue audited.

- [ ] **Step 4: e2e**

```ts
// apps/api/src/e2e/floorplan-links.e2e.test.ts  (same helpers as floorplan-polygons.e2e.test.ts)
describe('room links', () => {
  it('creates an opening on a shared wall, returns it on the plan, audits it, and cascades with the room', async () => {
    const p = await blankPlan(`Links ${s}`);
    const a = (await room(p.id, { code: 'A', x: 0.1, y: 0.1, w: 0.2, h: 0.2 })).json();
    const b = (await room(p.id, { code: 'B', x: 0.3, y: 0.1, w: 0.2, h: 0.2 })).json();
    const res = await app.inject({ method: 'POST', url: `/api/floorplans/${p.id}/links`, headers: auth, payload: { fromRoomId: a.id, toRoomId: b.id, kind: 'OPENING', fromEdge: 1, offset: 0.3, width: 0.3, door: 'ENTRY' } });
    expect(res.statusCode).toBe(201);
    const link = res.json();
    expect(link).toMatchObject({ kind: 'OPENING', fromEdge: 1, offset: 0.3, width: 0.3, door: 'ENTRY' });
    const list = await app.inject({ method: 'GET', url: '/api/floorplans', headers: auth });
    const mine = (list.json().data as { id: string; links: { id: string; fromEdge: number; door: string }[] }[]).find((x) => x.id === p.id)!;
    expect(mine.links[0]).toMatchObject({ id: link.id, fromEdge: 1, door: 'ENTRY' });
    const row = await prisma.auditTrail.findFirst({ where: { action: 'FLOORPLAN_LINK_CREATED', targetId: link.id } });
    expect((row!.afterValue as { code: string }).code).toBe('A ↔ B');
    await app.inject({ method: 'DELETE', url: `/api/floorplans/${p.id}/rooms/${b.id}`, headers: auth });
    expect(await prisma.floorplanRoomLink.count({ where: { id: link.id } })).toBe(0);
  });
  it('refuses an opening between rooms that do not share that wall, and a self-link', async () => {
    const p = await blankPlan(`Apart ${s}`);
    const a = (await room(p.id, { code: 'A', x: 0.1, y: 0.1, w: 0.2, h: 0.2 })).json();
    const b = (await room(p.id, { code: 'B', x: 0.6, y: 0.6, w: 0.2, h: 0.2 })).json();
    const res = await app.inject({ method: 'POST', url: `/api/floorplans/${p.id}/links`, headers: auth, payload: { fromRoomId: a.id, toRoomId: b.id, kind: 'OPENING', fromEdge: 1, offset: 0.3, width: 0.3 } });
    expect(res.statusCode).toBe(400); expect(res.json().error).toBe('NOT_ADJACENT');
    const self = await app.inject({ method: 'POST', url: `/api/floorplans/${p.id}/links`, headers: auth, payload: { fromRoomId: a.id, toRoomId: a.id, kind: 'CONNECTOR' } });
    expect(self.statusCode).toBe(400);
  });
  it('a connector needs no adjacency, may be labelled, updates, refuses a duplicate either way round, and deletes', async () => {
    const p = await blankPlan(`Conn ${s}`);
    const a = (await room(p.id, { code: 'A', x: 0.1, y: 0.1, w: 0.2, h: 0.2 })).json();
    const b = (await room(p.id, { code: 'B', x: 0.6, y: 0.6, w: 0.2, h: 0.2 })).json();
    const made = await app.inject({ method: 'POST', url: `/api/floorplans/${p.id}/links`, headers: auth, payload: { fromRoomId: a.id, toRoomId: b.id, kind: 'CONNECTOR', label: 'pass-through' } });
    expect(made.statusCode).toBe(201);
    const dup = await app.inject({ method: 'POST', url: `/api/floorplans/${p.id}/links`, headers: auth, payload: { fromRoomId: b.id, toRoomId: a.id, kind: 'CONNECTOR' } });
    expect(dup.statusCode).toBe(409);
    const upd = await app.inject({ method: 'PUT', url: `/api/floorplans/${p.id}/links/${made.json().id}`, headers: auth, payload: { fromRoomId: a.id, toRoomId: b.id, kind: 'CONNECTOR', label: 'hatch' } });
    expect(upd.json().label).toBe('hatch');
    const del = await app.inject({ method: 'DELETE', url: `/api/floorplans/${p.id}/links/${made.json().id}`, headers: auth });
    expect(del.statusCode).toBe(204);
    expect(await prisma.auditTrail.count({ where: { action: 'FLOORPLAN_LINK_DELETED', targetId: made.json().id } })).toBe(1);
  });
});
```

Run single-forked → green. Mutation-check: delete `links` from the `GET /` response schema → the "returns it on the plan" assertion fails; restore.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/audit-actions.ts packages/shared/src/types/audit-templates.ts apps/api/src/modules/floorplans/validation.ts apps/api/src/modules/floorplans/routes.ts apps/api/src/e2e/floorplan-links.e2e.test.ts
git commit -m "feat(api): room links — openings on a shared wall and connectors, audited"
```

---

### Task 5: Web geometry for polygons

**Files:**
- Modify: `apps/web/src/routes/dashboard/room-geometry.ts`
- Modify: `apps/web/src/routes/dashboard/__tests__/room-geometry.test.ts` (add cases; existing cases unchanged)

**Interfaces:**
- Consumes: `Polygon`, `EdgeOpening`, `polygonEdges`, `signedArea`, `rectanglePoints`, `doorEdge`, `sharedEdges` from `@digilog/shared`.
- Produces: `polygonWalls(points: Polygon, openings: EdgeOpening[]): Segment[]`; `polygonDoorPlacements(points: Polygon, doors: RoomDoor[] | null): DoorPlacement[]` (`DoorPlacement.wall` becomes `edge: number`; keep `wall?: DoorWall` for rectangle callers); `polygonSharedOpenings(points, neighbours: Polygon[]): EdgeOpening[]`; `wallSegments`, `doorPlacements`, `sharedOpenings` keep their signatures and become wrappers (`rectanglePoints` + `WALL_EDGE`). `RoomDoor.wall` becomes optional and `edge?: number` is added.

- [ ] **Step 1: Failing tests**

```ts
describe('polygonWalls / polygonDoorPlacements (2026-09-22)', () => {
  const L = [{ x: 100, y: 100 }, { x: 500, y: 100 }, { x: 500, y: 300 }, { x: 300, y: 300 }, { x: 300, y: 500 }, { x: 100, y: 500 }];
  it('an L with no openings has six wall segments, one per edge', () => {
    expect(polygonWalls(L, [])).toHaveLength(6);
  });
  it('an opening on edge 4 (the bottom of the lower arm) splits it in two', () => {
    const walls = polygonWalls(L, [{ edge: 4, offset: 0.25, width: 0.5 }]);
    expect(walls).toHaveLength(7);
    const bottom = walls.filter((w) => w.y1 === 500 && w.y2 === 500);
    expect(bottom).toHaveLength(2);
  });
  it('a door leaf on a polygon edge swings INTO the room', () => {
    const [d] = polygonDoorPlacements(L, [{ edge: 0, offset: 0.1, width: 0.1, kind: 'ENTRY' }]);
    expect(d.edge).toBe(0);
    expect(d.leaf.y2).toBeGreaterThan(d.leaf.y1); // edge 0 runs along the top; inside is below (y down)
  });
  it('the rectangle wrappers still give the old answers', () => {
    const box = { x: 100, y: 100, w: 200, h: 100 };
    expect(wallSegments(box, null)).toHaveLength(4);
    expect(doorPlacements(box, [{ wall: 'left', offset: 0.2, width: 0.3, kind: 'EXIT' }])[0].wall).toBe('left');
  });
  it('two touching polygons share an opening on the seam', () => {
    const a = rectanglePoints({ x: 100, y: 100, w: 200, h: 200 }), b = rectanglePoints({ x: 300, y: 100, w: 200, h: 200 });
    expect(polygonSharedOpenings(a, [b])).toEqual([{ edge: 1, offset: 0, width: 1 }]);
  });
});
```

- [ ] **Step 2: Implement**

Replace the box-only internals with polygon ones (keep every export the tests and the view import today):

```ts
import { rectanglePoints, polygonEdges, signedArea, doorEdge, sharedEdges, type Polygon, type EdgeOpening } from '@digilog/shared';

export interface RoomDoor { wall?: DoorWall; edge?: number; offset: number; width: number; kind: DoorKind }
export interface DoorPlacement { edge: number; wall?: DoorWall; kind: DoorKind; start: Segment; hinge: Point; leaf: Segment; arc: string }

function edgeInward(points: Polygon, i: number) {
  const e = polygonEdges(points)[i];
  const len = Math.hypot(e.x2 - e.x1, e.y2 - e.y1) || 1;
  const dx = (e.x2 - e.x1) / len, dy = (e.y2 - e.y1) / len;
  // Clockwise on screen (signed area > 0 with y down) → inside is to the right of the edge direction.
  return signedArea(points) > 0 ? { x: -dy, y: dx, length: len } : { x: dy, y: -dx, length: len };
}
const pointOn = (points: Polygon, i: number, t: number) => {
  const e = polygonEdges(points)[i];
  return { x: clean(e.x1 + (e.x2 - e.x1) * t), y: clean(e.y1 + (e.y2 - e.y1) * t) };
};

export function polygonWalls(points: Polygon, openings: EdgeOpening[]): Segment[] {
  const out: Segment[] = [];
  points.forEach((_, i) => {
    const onEdge = openings.filter((o) => o.edge === i).map((o) => ({ start: o.offset, end: o.offset + o.width })).sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const o of onEdge) {
      if (o.start > cursor) { const a = pointOn(points, i, cursor), b = pointOn(points, i, o.start); out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y }); }
      cursor = Math.max(cursor, o.end);
    }
    if (cursor < 1) { const a = pointOn(points, i, cursor), b = pointOn(points, i, 1); out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y }); }
  });
  return out;
}

export function polygonDoorPlacements(points: Polygon, doors: RoomDoor[] | null | undefined): DoorPlacement[] {
  return (doors ?? []).flatMap((door) => {
    const edge = doorEdge(door, points);
    if (edge < 0) return [];
    const inward = edgeInward(points, edge);
    const hinge = pointOn(points, edge, door.offset), far = pointOn(points, edge, door.offset + door.width);
    const span = door.width * inward.length;
    const leafEnd = { x: hinge.x + inward.x * span, y: hinge.y + inward.y * span };
    return [{ edge, wall: door.wall, kind: door.kind, start: { x1: hinge.x, y1: hinge.y, x2: far.x, y2: far.y }, hinge, leaf: { x1: hinge.x, y1: hinge.y, x2: leafEnd.x, y2: leafEnd.y }, arc: `M ${leafEnd.x} ${leafEnd.y} A ${span} ${span} 0 0 1 ${far.x} ${far.y}` }];
  });
}

export function polygonSharedOpenings(points: Polygon, neighbours: Polygon[], tol = 0.5): EdgeOpening[] {
  return neighbours.flatMap((n) => sharedEdges(points, n, tol).map((s) => ({ edge: s.aEdge, offset: s.start, width: clean(s.end - s.start) })));
}

// Rectangle wrappers — the old signatures, over the polygon path.
export function wallSegments(box: PixelBox, doors: WallOpening[] | null | undefined): Segment[] {
  return polygonWalls(rectanglePoints(box), (doors ?? []).map((d) => ({ edge: doorEdge(d, null), offset: d.offset, width: d.width })).filter((o) => o.edge >= 0));
}
export function doorPlacements(box: PixelBox, doors: RoomDoor[] | null | undefined): DoorPlacement[] { return polygonDoorPlacements(rectanglePoints(box), doors); }
export function sharedOpenings(box: PixelBox, neighbours: PixelBox[], tol = 0.5): WallOpening[] {
  const names: DoorWall[] = ['top', 'right', 'bottom', 'left'];
  return polygonSharedOpenings(rectanglePoints(box), neighbours.map(rectanglePoints), tol).map((o) => ({ wall: names[o.edge], offset: o.offset, width: o.width }));
}
```

`WallOpening` becomes `{ wall: DoorWall; offset: number; width: number }` still (rectangle callers). The `tol` for pixel polygons is 0.5 viewBox units, passed explicitly (the shared default is plan units).

Run `room-geometry.test.ts` alone → all old and new cases pass. Note: the arc's sweep flag (`0 0 1`) assumes clockwise edge order; a counter-clockwise polygon flips the sweep: use `signedArea(points) > 0 ? 1 : 0` as the sweep flag.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/dashboard/room-geometry.ts apps/web/src/routes/dashboard/__tests__/room-geometry.test.ts
git commit -m "feat(web): polygon walls, doors by edge and shared openings; rectangles as the four-corner case"
```

---

### Task 6: Dashboard draws polygons, openings and connectors

**Files:**
- Modify: `apps/web/src/routes/dashboard/use-telemetry.ts` (`FloorplanRoomShape.points`, `FloorplanShape.links`, `FloorplanLinkShape`)
- Modify: `apps/web/src/routes/dashboard/floorplan-view.tsx`
- Modify: `apps/web/src/routes/dashboard/__tests__/floorplan-continuation.test.ts` (unchanged) — add `apps/web/src/routes/dashboard/__tests__/floorplan-polygon-render.test.ts`

**Interfaces:**
- Consumes: Task 5's functions; `largestInscribedRect`, `mirrorOpening`, `centroid`, `rectanglePoints` from `@digilog/shared`.
- Produces: exported pure `roomOutline(room, VB_W, vbH): Polygon` and `roomOpenings(room, plan, roomViews, VB_W, vbH): EdgeOpening[]` from `floorplan-view.tsx` for the test.

- [ ] **Step 1: Types**

```ts
export interface FloorplanLinkShape { id: string; fromRoomId: string; toRoomId: string; kind: 'OPENING' | 'CONNECTOR'; fromEdge: number | null; offset: number | null; width: number | null; door: DoorKind | null; label: string | null }
// FloorplanRoomShape gains:  points: { x: number; y: number }[] | null;
// FloorplanShape gains:      imagePath: string | null;  links: FloorplanLinkShape[];
```

- [ ] **Step 2: The view**

In the room `map`: replace the box-based pieces.

```ts
const outline = roomOutline(room, VB_W, vbH);            // px polygon
const doorOpenings = (room.doors ?? []).map((d) => ({ edge: doorEdge(d, room.points ?? null), offset: d.offset, width: d.width })).filter((o) => o.edge >= 0);
const seamOpenings = polygonSharedOpenings(outline, roomViews.filter((o) => o.room.id !== room.id && sameSpace(room, o.room)).map((o) => roomOutline(o.room, VB_W, vbH)));
const linkOpenings = roomOpenings(room, plan, roomViews, VB_W, vbH);
const walls = polygonWalls(outline, [...doorOpenings, ...seamOpenings, ...linkOpenings]);
const tileBox = largestInscribedRect(outline);          // replaces { x, y, w, h } for tileLayout
```

with, exported at module level:

```ts
export function roomOutline(room: Pick<FloorplanRoomShape, 'x' | 'y' | 'w' | 'h' | 'points'>, vbW: number, vbH: number): Polygon {
  const pts = room.points ?? rectanglePoints({ x: room.x, y: room.y, w: room.w, h: room.h });
  return pts.map((p) => ({ x: p.x * vbW, y: p.y * vbH }));
}
/** The link openings that land on THIS room's edges: its own as stored, the neighbour's mirrored. */
export function roomOpenings(room: FloorplanRoomShape, plan: { links: FloorplanLinkShape[]; rooms: FloorplanRoomShape[] }, drawn: { room: FloorplanRoomShape }[], vbW: number, vbH: number): EdgeOpening[] {
  const out: EdgeOpening[] = [];
  for (const l of plan.links) {
    if (l.kind !== 'OPENING' || l.fromEdge == null || l.offset == null || l.width == null) continue;
    if (l.fromRoomId === room.id) out.push({ edge: l.fromEdge, offset: l.offset, width: l.width });
    else if (l.toRoomId === room.id) {
      const from = drawn.find((d) => d.room.id === l.fromRoomId)?.room;
      if (!from) continue;
      const m = mirrorOpening(roomOutline(from, vbW, vbH), { edge: l.fromEdge, offset: l.offset, width: l.width }, roomOutline(room, vbW, vbH), 0.5);
      if (m) out.push(m);
    }
  }
  return out;
}
```

Render: `<polygon points={outline.map(p => `${p.x},${p.y}`).join(' ')} fill=… className="fp-room-fill" />` replaces the fill `<rect>`; the halo becomes `<polygon … fill="none" stroke={PALETTE.alarm} strokeWidth={8} clipPath={`url(#clip-${room.id})`} />` with a `<clipPath id={`clip-${room.id}`}><polygon points=…/></clipPath>` so only the inner half of the stroke shows; door leaves from `polygonDoorPlacements(outline, room.doors)` and, for an OPENING link with `door`, a leaf on the from-room's edge (build a `RoomDoor` from the link and pass it in the same call). The corridor centre-line uses the inscribed rect's long axis. Tiles: `tileLayout(tileBox, roomRows.length, headerH)` everywhere the view called `tileLayout({ x, y, w, h }, …)`; the empty-room label centres on `centroid(outline)`.

After the room map, draw connectors once:

```tsx
{plan.links.filter((l) => l.kind === 'CONNECTOR').map((l) => {
  const a = roomViews.find((v) => v.room.id === l.fromRoomId)?.room, b = roomViews.find((v) => v.room.id === l.toRoomId)?.room;
  if (!a || !b) return null;
  const ca = centroid(roomOutline(a, VB_W, vbH)), cb = centroid(roomOutline(b, VB_W, vbH));
  return (
    <g key={l.id} pointerEvents="none">
      <line x1={ca.x} y1={ca.y} x2={cb.x} y2={cb.y} stroke={PALETTE.door} strokeWidth={1.4} strokeDasharray="6 4" />
      {l.label && <text x={(ca.x + cb.x) / 2} y={(ca.y + cb.y) / 2 - 3} textAnchor="middle" fontSize={8} fill={PALETTE.door}>{l.label}</text>}
    </g>
  );
})}
```

The aria-label gains `, ${plan.links.filter(l => l.fromRoomId === room.id || l.toRoomId === room.id).length} link(s)` when non-zero.

- [ ] **Step 3: Test the pure exports**

```ts
// floorplan-polygon-render.test.ts
import { roomOutline, roomOpenings } from '../floorplan-view';
const rect = (id: string, x: number, y: number, w: number, h: number) => ({ id, code: id, label: null, grade: null, x, y, w, h, tempMin: null, tempMax: null, rhMin: null, rhMax: null, doors: null, meta: null, points: null });
it('a rectangle room outlines as its four corners scaled to the viewBox', () => {
  expect(roomOutline(rect('A', 0.1, 0.1, 0.2, 0.2), 1000, 500)).toEqual([{ x: 100, y: 50 }, { x: 300, y: 50 }, { x: 300, y: 150 }, { x: 100, y: 150 }]);
});
it('a stored polygon is used as drawn', () => {
  const r = { ...rect('L', 0, 0, 1, 1), points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.1, y: 0.5 }] };
  expect(roomOutline(r, 1000, 1000)).toHaveLength(3);
});
it('an opening link lands on the from-room as stored and on the to-room mirrored', () => {
  const a = rect('A', 0.1, 0.1, 0.2, 0.2), b = rect('B', 0.3, 0.1, 0.2, 0.2);
  const plan = { rooms: [a, b], links: [{ id: 'l', fromRoomId: 'A', toRoomId: 'B', kind: 'OPENING' as const, fromEdge: 1, offset: 0.2, width: 0.3, door: null, label: null }] };
  const drawn = [{ room: a }, { room: b }];
  expect(roomOpenings(a, plan, drawn, 1000, 1000)).toEqual([{ edge: 1, offset: 0.2, width: 0.3 }]);
  expect(roomOpenings(b, plan, drawn, 1000, 1000)).toEqual([{ edge: 3, offset: 0.5, width: 0.3 }]);
});
```

Run it, `floorplan-continuation.test.ts`, `floorplan-values.test.ts`, `tile-font.test.ts`, `room-geometry.test.ts` individually → green. `npx tsc --noEmit -p apps/web/tsconfig.json` clean, `vite build` clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/dashboard/use-telemetry.ts apps/web/src/routes/dashboard/floorplan-view.tsx apps/web/src/routes/dashboard/__tests__/floorplan-polygon-render.test.ts
git commit -m "feat(dashboard): draw polygon rooms, link openings and connectors; tiles in the inscribed rectangle"
```

---

### Task 7: Designer — pure tools and snapping

**Files:**
- Create: `apps/web/src/routes/config/layout-designer/snapping.ts`
- Create: `apps/web/src/routes/config/layout-designer/tools.ts`
- Create: `apps/web/src/routes/config/layout-designer/__tests__/snapping.test.ts`
- Create: `apps/web/src/routes/config/layout-designer/__tests__/tools.test.ts`

**Interfaces:**
- Produces:
  - `snapping.ts`: `GRID = 0.02`, `SNAP_TOL = 0.01`, `snapPoint(p: Point, others: Polygon[], opts?: { grid?: boolean; shiftFrom?: Point | null }): Point`, `rightAngle(from: Point, p: Point): Point`, `nearestEdgePoint(p, poly): { edge: number; t: number; point: Point; dist: number }`.
  - `tools.ts`: `type Tool = 'select' | 'room' | 'corridor' | 'door' | 'link'`; `type Selection = { kind: 'room'; roomId: string } | { kind: 'corner'; roomId: string; index: number } | { kind: 'door'; roomId: string; index: number } | { kind: 'link'; linkId: string } | null`; `interface DesignerState { tool: Tool; drawing: Point[] | null; selection: Selection; linkFrom: string | null; message: string | null }`; `initialState`; `type DesignerAction = { type: 'setTool'; tool: Tool } | { type: 'addCorner'; point: Point } | { type: 'closePolygon' } | { type: 'cancel' } | { type: 'select'; selection: Selection } | { type: 'linkFirst'; roomId: string } | { type: 'flash'; message: string | null }`; `reduce(state, action): DesignerState`; `closedPolygon(state): { ok: true; points: Polygon } | { ok: false; error: string }` (uses `validatePolygon`).

- [ ] **Step 1: Tests**

```ts
// snapping.test.ts
import { snapPoint, rightAngle, nearestEdgePoint, GRID } from '../snapping';
import { rectanglePoints } from '@digilog/shared';
const other = rectanglePoints({ x: 0.3, y: 0.3, w: 0.2, h: 0.2 });
it('snaps to a neighbouring corner within tolerance, before the grid', () => {
  expect(snapPoint({ x: 0.305, y: 0.296 }, [other])).toEqual({ x: 0.3, y: 0.3 });
});
it('snaps onto a neighbouring edge when no corner is near', () => {
  expect(snapPoint({ x: 0.405, y: 0.296 }, [other])).toEqual({ x: 0.4, y: 0.3 });
});
it('otherwise snaps to the grid', () => {
  expect(snapPoint({ x: 0.111, y: 0.129 }, [])).toEqual({ x: 0.12, y: 0.12 });
  expect(GRID).toBe(0.02);
});
it('right-angle constraint keeps the longer axis', () => {
  expect(rightAngle({ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.15 })).toEqual({ x: 0.4, y: 0.1 });
  expect(rightAngle({ x: 0.1, y: 0.1 }, { x: 0.15, y: 0.4 })).toEqual({ x: 0.1, y: 0.4 });
});
it('nearestEdgePoint reports the edge and the fraction along it', () => {
  const n = nearestEdgePoint({ x: 0.4, y: 0.29 }, other);
  expect(n.edge).toBe(0); expect(n.t).toBeCloseTo(0.5, 6);
});
```

```ts
// tools.test.ts
import { reduce, initialState, closedPolygon } from '../tools';
it('draw: corners accumulate, Enter closes a valid outline, Escape discards', () => {
  let s = reduce(initialState, { type: 'setTool', tool: 'room' });
  s = reduce(s, { type: 'addCorner', point: { x: 0.1, y: 0.1 } });
  s = reduce(s, { type: 'addCorner', point: { x: 0.3, y: 0.1 } });
  expect(closedPolygon(s).ok).toBe(false);          // two corners is not a room
  s = reduce(s, { type: 'addCorner', point: { x: 0.3, y: 0.3 } });
  expect(closedPolygon(s)).toEqual({ ok: true, points: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.1 }, { x: 0.3, y: 0.3 }] });
  expect(reduce(s, { type: 'cancel' }).drawing).toBeNull();
});
it('draw: a click on the first corner closes; a bow-tie is refused with a reason and stays open', () => {
  let s = reduce(initialState, { type: 'setTool', tool: 'room' });
  for (const p of [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }]) s = reduce(s, { type: 'addCorner', point: p });
  const r = closedPolygon(s);
  expect(r.ok).toBe(false);
  expect(s.drawing).toHaveLength(4);
});
it('a repeated corner is ignored, not added twice', () => {
  let s = reduce(initialState, { type: 'setTool', tool: 'room' });
  s = reduce(s, { type: 'addCorner', point: { x: 0.1, y: 0.1 } });
  s = reduce(s, { type: 'addCorner', point: { x: 0.1, y: 0.1 } });
  expect(s.drawing).toHaveLength(1);
});
it('link: first click remembers the room, cancel forgets it, changing tool forgets it', () => {
  let s = reduce(initialState, { type: 'setTool', tool: 'link' });
  s = reduce(s, { type: 'linkFirst', roomId: 'A' });
  expect(s.linkFrom).toBe('A');
  expect(reduce(s, { type: 'cancel' }).linkFrom).toBeNull();
  expect(reduce(s, { type: 'setTool', tool: 'select' }).linkFrom).toBeNull();
});
it('changing tool clears the selection and any drawing', () => {
  let s = reduce(initialState, { type: 'select', selection: { kind: 'room', roomId: 'A' } });
  s = reduce(s, { type: 'setTool', tool: 'room' });
  expect(s.selection).toBeNull();
});
```

- [ ] **Step 2: Implement**

```ts
// snapping.ts
import { polygonEdges, type Point, type Polygon } from '@digilog/shared';
export const GRID = 0.02;
export const SNAP_TOL = 0.01;
const r = (n: number) => Math.round(n * 1e6) / 1e6;
export function nearestEdgePoint(p: Point, poly: Polygon) {
  let best = { edge: -1, t: 0, point: p, dist: Infinity };
  polygonEdges(poly).forEach((e, i) => {
    const dx = e.x2 - e.x1, dy = e.y2 - e.y1, len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - e.x1) * dx + (p.y - e.y1) * dy) / len2));
    const q = { x: r(e.x1 + dx * t), y: r(e.y1 + dy * t) };
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < best.dist) best = { edge: i, t, point: q, dist: d };
  });
  return best;
}
export function rightAngle(from: Point, p: Point): Point {
  return Math.abs(p.x - from.x) >= Math.abs(p.y - from.y) ? { x: p.x, y: from.y } : { x: from.x, y: p.y };
}
/** Corner of another room first, then a point on another room's edge, then the grid. */
export function snapPoint(p: Point, others: Polygon[], opts: { grid?: boolean; shiftFrom?: Point | null } = {}): Point {
  let q = opts.shiftFrom ? rightAngle(opts.shiftFrom, p) : p;
  let best: { point: Point; dist: number } | null = null;
  for (const poly of others) for (const c of poly) {
    const d = Math.hypot(c.x - q.x, c.y - q.y);
    if (d <= SNAP_TOL && (!best || d < best.dist)) best = { point: c, dist: d };
  }
  if (best) return best.point;
  for (const poly of others) {
    const n = nearestEdgePoint(q, poly);
    if (n.dist <= SNAP_TOL && (!best || n.dist < best.dist)) best = { point: n.point, dist: n.dist };
  }
  if (best) return best.point;
  if (opts.grid === false) return q;
  q = { x: r(Math.round(q.x / GRID) * GRID), y: r(Math.round(q.y / GRID) * GRID) };
  return { x: Math.min(1, Math.max(0, q.x)), y: Math.min(1, Math.max(0, q.y)) };
}
```

```ts
// tools.ts
import { validatePolygon, type Point, type Polygon } from '@digilog/shared';
export type Tool = 'select' | 'room' | 'corridor' | 'door' | 'link';
export type Selection = { kind: 'room'; roomId: string } | { kind: 'corner'; roomId: string; index: number } | { kind: 'door'; roomId: string; index: number } | { kind: 'link'; linkId: string } | null;
export interface DesignerState { tool: Tool; drawing: Point[] | null; selection: Selection; linkFrom: string | null; message: string | null }
export const initialState: DesignerState = { tool: 'select', drawing: null, selection: null, linkFrom: null, message: null };
export type DesignerAction =
  | { type: 'setTool'; tool: Tool } | { type: 'addCorner'; point: Point } | { type: 'closePolygon' } | { type: 'cancel' }
  | { type: 'select'; selection: Selection } | { type: 'linkFirst'; roomId: string } | { type: 'flash'; message: string | null };
const same = (a: Point, b: Point) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
export function reduce(s: DesignerState, a: DesignerAction): DesignerState {
  switch (a.type) {
    case 'setTool': return { ...initialState, tool: a.tool };
    case 'addCorner': {
      const d = s.drawing ?? [];
      if (d.length && same(d[d.length - 1], a.point)) return s;
      return { ...s, drawing: [...d, a.point], message: null };
    }
    case 'closePolygon': return { ...s, drawing: null };
    case 'cancel': return { ...s, drawing: null, linkFrom: null, message: null };
    case 'select': return { ...s, selection: a.selection };
    case 'linkFirst': return { ...s, linkFrom: a.roomId };
    case 'flash': return { ...s, message: a.message };
  }
}
export function closedPolygon(s: DesignerState): { ok: true; points: Polygon } | { ok: false; error: string } {
  if (!s.drawing) return { ok: false, error: 'nothing drawn' };
  return validatePolygon(s.drawing);
}
```

Run both test files individually → green. Mutation-check: in `snapPoint` swap the corner and edge passes → the corner test fails; restore.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/config/layout-designer/
git commit -m "feat(designer): pure tool reducer and snapping"
```

---

### Task 8: Designer page

**Files:**
- Create: `apps/web/src/routes/config/layout-designer/index.tsx` (page: data, save, panels)
- Create: `apps/web/src/routes/config/layout-designer/canvas.tsx` (SVG surface)
- Create: `apps/web/src/routes/config/layout-designer/properties-panel.tsx`
- Create: `apps/web/src/routes/config/layout-designer/__tests__/designer-page.test.tsx`
- Delete: `apps/web/src/routes/config/floorplans.tsx`
- Modify: `apps/web/src/main.tsx:26,124` (import + route element; path stays `/config/floorplans`)
- Modify: `apps/web/src/routes/config/index.tsx` (add a `superAdminCards` entry: title `Layout Designer`, description `Draw rooms and corridors on a blank canvas, link them, place instruments`, href `/config/floorplans`, gradient `from-indigo-500 to-blue-600`, a map icon)
- Modify: `apps/web/src/routes/dashboard/floorplan-view.tsx` and `room-detail.tsx` link TEXT `Configuration → Floorplans` → `Configuration → Layout Designer` (three places + one)

**Interfaces:**
- Consumes: Task 7's `reduce`/`snapPoint`; Task 5's `polygonWalls`/`polygonDoorPlacements`; shared `rectanglePoints`, `boundingBox`, `sharedEdges`, `unionRectilinear`, `centroid`, `nearestEdgePoint`.
- Produces: `export function LayoutDesignerPage()`; `canvas.tsx` exports `DesignerCanvas` with props `{ plan, rooms, links, state, dispatch, onCommitPolygon(points), onMoveRoom(roomId, points), onCornerChange(roomId, points), onPlaceDoor(roomId, door), onLink(fromId, toId, shared?: SharedEdge), tracingSrc, guideOpacity }`; `properties-panel.tsx` exports `PropertiesPanel`.

- [ ] **Step 1: The canvas**

Key behaviours, each a few lines in `canvas.tsx` (SVG `viewBox="0 0 1000 H"`, `H = 1000 * plan.imageHeight / plan.imageWidth`, pointer → plan units via `getBoundingClientRect` like the old `toNormalized`):

- Dotted grid: `<pattern id="grid" width={20} height={20 * H / 1000 * (1000 / H)} …>` — simpler: draw circles at every `GRID` step with `patternUnits="userSpaceOnUse"` width/height `GRID * 1000`.
- Tracing image: `<image href={tracingSrc} width={1000} height={H} opacity={guideOpacity} preserveAspectRatio="xMidYMid meet" pointerEvents="none" />` when `tracingSrc`.
- Rooms: `<polygon points>` fill by grade (reuse `ROOM_GRADE_META` colours), walls `polygonWalls(outline, doorOpenings)` as `<line>`s, doors from `polygonDoorPlacements`; selected room shows corner handles `<circle r={5}>` (drag → `onCornerChange` with snapping; Delete key → remove corner if > 3) and edge midpoints `<circle r={3.5} opacity=.5>` (double-click → insert corner).
- Tool `room`/`corridor`: click → `dispatch({ type: 'addCorner', point: snapPoint(p, otherOutlines, { shiftFrom: e.shiftKey ? last : null }) })`; a click within `SNAP_TOL` of the first corner, or Enter, → `closedPolygon(state)`; ok → `onCommitPolygon(points, tool === 'corridor')`; not ok → `dispatch({ type: 'flash', message: error })`. Escape → cancel. The open outline draws as a dashed polyline plus a rubber-band segment to the pointer.
- Tool `select`: pointer-down on a room selects and starts a move (translate all corners, refused when any corner would leave 0..1); release → `onMoveRoom(roomId, points)` if moved by more than `1e-6`.
- Tool `door`: click on a selected room's edge → `nearestEdgePoint` → `onPlaceDoor(roomId, { edge, offset: clamp(t − 0.06, 0, 1 − 0.12), width: 0.12, kind: 'ENTRY' })` (six max, no overlap on that edge — refuse with a flash).
- Tool `link`: first click `linkFirst`; second click on another room → `sharedEdges(a, b)` → `onLink(a, b, shared[0])` or `onLink(a, b)` for a connector; same room → flash.
- Links drawn as in the dashboard (gaps for openings, dashed lines for connectors), the selected one highlighted.

- [ ] **Step 2: The page**

`index.tsx` keeps the old page's data plumbing (SWR `/api/floorplans`, `/api/floorplans/:id`, instruments list, `roomOfInstrument`, `useReauth` + `ReauthDialog`, toasts) and adds:

- **New plan** dialog: name + size preset (`landscape 1600×1200`, `portrait 1200×1600`, `square 1200×1200`) → `POST /api/floorplans { name, imagePath: null, imageWidth, imageHeight }` (re-auth `UPDATE_FLOORPLAN`). **Upload tracing image** → existing `/api/uploads/floorplan` then `PUT /api/floorplans/:id { imagePath, imageWidth, imageHeight }`.
- `onCommitPolygon(points, corridor)`: open the properties panel in NEW mode with `points`, grade preset `CIRCULATION` and code `CORRIDOR-<n>` when corridor; Create → `POST /:id/rooms { code, label, grade, limits, points, ...boundingBox(points) }` then membership PUT, exactly the old `saveRoom` flow.
- `onMoveRoom` / `onCornerChange` → `PUT /:id/rooms/:roomId { ...roomFields, points, ...boundingBox(points) }` under `reauth.execute('UPDATE_FLOORPLAN_ROOM', …)`; on error, revalidate so the room springs back.
- `onPlaceDoor` → PUT the room with `doors: [...doors, door]`.
- `onLink(a, b, shared)` → `POST /:id/links` with `{ fromRoomId: a, toRoomId: b, kind: shared ? 'OPENING' : 'CONNECTOR', fromEdge: shared?.aEdge, offset: shared ? shared.start + (shared.end − shared.start − w) / 2 : undefined, width: shared ? w : undefined }` where `w = min(0.3, shared.end − shared.start)`; then the panel edits `door`/`label` via PUT; Delete → DELETE.
- **Merge pieces**: enabled when the selection is a room and exactly one other room is adjoining and `sameSpace`-eligible (both CIRCULATION or `continuationBase` match); `unionRectilinear(a, b)` non-null → confirm → PUT room A with the union `points`, PUT membership of B's instruments onto A, DELETE B.
- Delete (button or key): room → confirm when it holds instruments or links → DELETE; door → PUT without it; link → DELETE.
- Undo/redo: a small stack over `state.drawing` snapshots only (buttons dispatch `flash`/`addCorner` replays); saved changes are not undone, said in the toolbar's title.

The properties panel is the old form (code, label, grade, limits, instruments) plus a Door section (kind per door, remove) and a Link section (door kind or label, delete), each saving through the same `reauth.execute` pattern.

- [ ] **Step 3: Wiring**

`main.tsx`: `const LayoutDesignerPage = lazy(() => import('./routes/config/layout-designer').then(m => ({ default: m.LayoutDesignerPage })));` and `<Route path="/config/floorplans" element={<RequireRole roles={['SUPER_ADMIN']}><LayoutDesignerPage /></RequireRole>} />`. Delete `routes/config/floorplans.tsx`. Add the card. Update the four link texts.

- [ ] **Step 4: Render test**

```tsx
// designer-page.test.tsx — mocks as instrument-attributes.test.tsx: swr (plans list with one blank plan and no rooms; detail), api-client (post/put/delete spies), use-toast, use-reauth (execute runs the callback immediately with no password and calls onSuccess)
it('draws a triangle corner by corner, names it, and posts points with the derived box', async () => {
  render(<MemoryRouter><LayoutDesignerPage /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: /draw room/i }));
  const svg = screen.getByTestId('designer-canvas');
  // 1000x750 viewBox rendered at a stubbed 1000x750 box
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1000, height: 750, right: 1000, bottom: 750, x: 0, y: 0, toJSON: () => ({}) });
  for (const [x, y] of [[100, 75], [500, 75], [100, 375]]) fireEvent.pointerDown(svg, { clientX: x, clientY: y, button: 0, shiftKey: false });
  fireEvent.keyDown(window, { key: 'Enter' });
  fireEvent.change(screen.getByLabelText(/room code/i), { target: { value: 'TRI' } });
  fireEvent.click(screen.getByRole('button', { name: /create room/i }));
  await waitFor(() => expect(post).toHaveBeenCalled());
  const [url, body] = post.mock.calls.find((c) => String(c[0]).endsWith('/rooms'))!;
  expect(url).toBe('/api/floorplans/p1/rooms');
  expect(body).toMatchObject({ code: 'TRI', points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.1, y: 0.5 }], x: 0.1, y: 0.1, w: 0.4, h: 0.4 });
});
it('a bow-tie is refused in place with the reason and nothing is posted', async () => { /* four crossing corners, Enter, expect screen.getByText(/crosses itself/) and post not called */ });
it('linking two touching rooms posts an OPENING on the shared edge; two apart rooms a CONNECTOR', async () => { /* plan with rooms A (0.1,0.1,0.2,0.2) and B (0.3,0.1,0.2,0.2) and C (0.7,0.7,0.1,0.1); link tool; click A then B → post kind OPENING fromEdge 1; click A then C → CONNECTOR */ });
```

Run the file alone → green; then `tsc --noEmit`, `vite build`, and every other config page test that mentions floorplans (grep first) individually.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/src/routes/config/layout-designer apps/web/src/main.tsx apps/web/src/routes/config/index.tsx apps/web/src/routes/dashboard/floorplan-view.tsx apps/web/src/routes/dashboard/room-detail.tsx
git rm apps/web/src/routes/config/floorplans.tsx
git commit -m "feat(web): Layout Designer replaces the Floorplans editor — polygon rooms, corridors, doors, links, blank plans"
```

---

### Task 9: Docs, counts, memory

**Files:**
- Modify: `CHANGELOG.md` (top entry), root `CLAUDE.md` (System Stats: models 37, audit 106/100, config pages 22; the floorplan bullets; the "Key API Endpoints" block gains the three link routes), `apps/api/CLAUDE.md` (Key Paths: models, the migration; a floorplans bullet), `apps/web/CLAUDE.md` (config page count 23 → 22; the "Instrument dashboard" section: `layout-designer/` replaces `floorplans.tsx`), `packages/shared/CLAUDE.md` (the geometry module), `docs/recreation/06-api/endpoints.md` (three link routes under floorplans), memory `instrument-dashboard-floorplans.md` + `MEMORY.md` line.

- [ ] **Step 1: Re-derive every number** with the verification block in root `CLAUDE.md` and write them; `grep -rn "Configuration → Floorplans\|Config → Floorplans\|floorplans.tsx" CLAUDE.md apps/*/CLAUDE.md README.md AGENTS.md docs/recreation` and fix each hit that describes the present.
- [ ] **Step 2: Changelog entry** naming the operator's request, the five decisions, what moved (models 36 → 37, audit 103 → 106 / 97 → 100, config pages 23 → 22, migration name), what stays (rectangles untouched, trace scripts unchanged), what is not built (spec §9), and "not seen on screen".
- [ ] **Step 3: Commit and push**

```bash
git add CHANGELOG.md CLAUDE.md apps/api/CLAUDE.md apps/web/CLAUDE.md packages/shared/CLAUDE.md docs/recreation/06-api/endpoints.md
git commit -m "docs: Layout Designer — counts, endpoints, page list"
git push origin data-layer
```

---

## Self-review

- **Spec coverage.** §3.1 points → Tasks 2–3; §3.2 doors by edge → Tasks 1, 3, 5; §3.3 links table + adjacency + duplicate rule → Tasks 2, 4; §3.4 image optional / canvas presets → Tasks 2, 3, 8; §3.5 migration + counts → Tasks 2, 4, 9; §4 shared module → Task 1 (all listed functions; `insetPolygon` replaced by a clip-path halo, stated in Task 6); §5 routes and schema declarations → Tasks 3–4; §6 designer (layout, tools, panel, saving, existing plans, merge) → Tasks 7–8; §7 dashboard → Task 6; §8 tests → each task; §9 exclusions → none built; §10 docs → Task 9.
- **Placeholders.** Task 8 describes the canvas and page by behaviour with the exact calls and payloads rather than the full JSX; the executor writes the JSX from the old editor's patterns (quoted in full in this session) and the props listed in the Interfaces block. Task 4's `validateLinkPayload` body is "the same shape as `validateRoomPayload`", which is in the file the executor edits.
- **Type consistency.** `EdgeOpening {edge, offset, width}` and `SharedEdge {aEdge, bEdge, start, end}` are used with those names in Tasks 1, 4, 5, 6, 8; `roomOutline`/`roomOpenings` in Task 6's test match its exports; `DoorPlacement.edge` (Task 5) is what Task 6 renders; the link wire shape in Task 4 is `FloorplanLinkShape` in Task 6.
