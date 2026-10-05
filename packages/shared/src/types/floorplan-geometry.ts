/**
 * Polygon geometry for floor plans — ONE definition shared by the API's
 * validation, the Layout Designer and the dashboard's drawing, so a room the
 * designer lets you draw is a room the server accepts and the floor can draw.
 *
 * Coordinates are plan units 0..1 (storage and wire). Callers that render
 * scale to their viewBox first and pass the scaled polygon back in; every
 * function here is unit-agnostic except the tolerances, which are in plan
 * units and which a pixel-space caller overrides. y grows DOWN (screen
 * convention), which is what `signedArea > 0` means for a polygon drawn
 * clockwise on screen.
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
  // `clean` kills the float noise of x + w (0.1 + 0.2 is 0.30000000000000004),
  // so a rectangle's corners compare equal to the corners a neighbour was
  // snapped to and `sharedEdges` sees one wall, not two a hair apart.
  const x2 = clean(box.x + box.w), y2 = clean(box.y + box.h);
  return [
    { x: box.x, y: box.y },
    { x: x2, y: box.y },
    { x: x2, y: y2 },
    { x: box.x, y: y2 },
  ];
}

export function boundingBox(points: Polygon): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
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
    Math.min(s.x1, s.x2) - EPS <= x && x <= Math.max(s.x1, s.x2) + EPS
    && Math.min(s.y1, s.y2) - EPS <= y && y <= Math.max(s.y1, s.y2) + EPS;
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
  const t2 = opening.offset + opening.width;
  const p2 = { x: e.x1 + (e.x2 - e.x1) * t2, y: e.y1 + (e.y2 - e.y1) * t2 };
  const u1 = paramAlong(f, p1), u2 = paramAlong(f, p2);
  const lo = Math.max(0, Math.min(u1, u2)), hi = Math.min(1, Math.max(u1, u2));
  if (hi <= lo) return null;
  return { edge: shared.bEdge, offset: clean(lo), width: clean(hi - lo) };
}

function uniqSorted(values: number[]): number[] {
  return [...new Set(values.map(clean))].sort((p, q) => p - q);
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
  // pre[i][j] = number of inside cells in [0,i) × [0,j); O(1) rectangle sums.
  const pre: number[][] = Array.from({ length: nx + 1 }, () => new Array<number>(ny + 1).fill(0));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const c = { x: (xs[i] + xs[i + 1]) / 2, y: (ys[j] + ys[j + 1]) / 2 };
      const v = pointInPolygon(c, points) ? 1 : 0;
      pre[i + 1][j + 1] = v + pre[i][j + 1] + pre[i + 1][j] - pre[i][j];
    }
  }
  let best: Box = { x: xs[0], y: ys[0], w: 0, h: 0 };
  let bestArea = 0;
  for (let i0 = 0; i0 < nx; i0++) {
    for (let i1 = i0 + 1; i1 <= nx; i1++) {
      for (let j0 = 0; j0 < ny; j0++) {
        for (let j1 = j0 + 1; j1 <= ny; j1++) {
          const cells = (i1 - i0) * (j1 - j0);
          const sum = pre[i1][j1] - pre[i0][j1] - pre[i1][j0] + pre[i0][j0];
          if (sum !== cells) continue;
          const area = (xs[i1] - xs[i0]) * (ys[j1] - ys[j0]);
          if (area > bestArea) {
            bestArea = area;
            best = { x: xs[i0], y: ys[j0], w: clean(xs[i1] - xs[i0]), h: clean(ys[j1] - ys[j0]) };
          }
        }
      }
    }
  }
  return bestArea > 0 ? best : boundingBox(points);
}

/**
 * EVERY maximal axis-aligned rectangle inside the polygon, largest first — the
 * same grid search as `largestInscribedRect`, keeping each rectangle that no
 * other inscribed rectangle contains. An L-shaped room has two (its two arms);
 * `largestInscribedRect` is the first of them.
 *
 * Why the others matter (Module-E, 2026-10-01): API DISPENSING is an L whose
 * tall narrow arm is 2 % larger in area than its wide one, so the "largest"
 * rectangle was the arm a reading card fits worst. The caller that lays a card
 * out tries the next ones when the largest cannot hold a legible card.
 */
export function inscribedRects(points: Polygon): Box[] {
  const xs = uniqSorted(points.map((p) => p.x)), ys = uniqSorted(points.map((p) => p.y));
  const nx = xs.length - 1, ny = ys.length - 1;
  if (nx < 1 || ny < 1) return [boundingBox(points)];
  const pre: number[][] = Array.from({ length: nx + 1 }, () => new Array<number>(ny + 1).fill(0));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const c = { x: (xs[i] + xs[i + 1]) / 2, y: (ys[j] + ys[j + 1]) / 2 };
      pre[i + 1][j + 1] = (pointInPolygon(c, points) ? 1 : 0) + pre[i][j + 1] + pre[i + 1][j] - pre[i][j];
    }
  }
  const full = (i0: number, i1: number, j0: number, j1: number) =>
    i0 >= 0 && j0 >= 0 && i1 <= nx && j1 <= ny
    && pre[i1][j1] - pre[i0][j1] - pre[i1][j0] + pre[i0][j0] === (i1 - i0) * (j1 - j0);
  const out: Box[] = [];
  for (let i0 = 0; i0 < nx; i0++) {
    for (let i1 = i0 + 1; i1 <= nx; i1++) {
      for (let j0 = 0; j0 < ny; j0++) {
        for (let j1 = j0 + 1; j1 <= ny; j1++) {
          if (!full(i0, i1, j0, j1)) continue;
          // Maximal: it cannot grow by one grid step on any side and stay inside.
          if (full(i0 - 1, i1, j0, j1) || full(i0, i1 + 1, j0, j1) || full(i0, i1, j0 - 1, j1) || full(i0, i1, j0, j1 + 1)) continue;
          out.push({ x: xs[i0], y: ys[j0], w: clean(xs[i1] - xs[i0]), h: clean(ys[j1] - ys[j0]) });
        }
      }
    }
  }
  if (!out.length) return [boundingBox(points)];
  return out.sort((a, b) => b.w * b.h - a.w * a.h);
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
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
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
  if (nx < 1 || ny < 1) return null;
  const centre = (i: number, j: number) => ({ x: (xs[i] + xs[i + 1]) / 2, y: (ys[j] + ys[j + 1]) / 2 });
  const inA = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < ny && pointInPolygon(centre(i, j), a);
  const inB = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < ny && pointInPolygon(centre(i, j), b);
  const inside = (i: number, j: number) => inA(i, j) || inB(i, j);

  // They touch when some cell is in both, or a cell of one is edge-adjacent to a cell of the other.
  let touch = false;
  for (let i = 0; i < nx && !touch; i++) {
    for (let j = 0; j < ny && !touch; j++) {
      if (inA(i, j) && inB(i, j)) { touch = true; break; }
      const nb: [number, number][] = [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]];
      for (const [p, q] of nb) {
        if ((inA(i, j) && inB(p, q)) || (inB(i, j) && inA(p, q))) { touch = true; break; }
      }
    }
  }
  if (!touch) return null;

  // Directed boundary edges, clockwise around each inside cell (y down):
  // top L→R, right T→B, bottom R→L, left B→T. Shared cell edges cancel.
  const key = (p: Point) => `${clean(p.x)},${clean(p.y)}`;
  const next = new Map<string, Point[]>();
  const add = (from: Point, to: Point) => { const k = key(from); next.set(k, [...(next.get(k) ?? []), to]); };
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      if (!inside(i, j)) continue;
      const tl = { x: xs[i], y: ys[j] }, tr = { x: xs[i + 1], y: ys[j] };
      const br = { x: xs[i + 1], y: ys[j + 1] }, bl = { x: xs[i], y: ys[j + 1] };
      if (!inside(i, j - 1)) add(tl, tr);
      if (!inside(i + 1, j)) add(tr, br);
      if (!inside(i, j + 1)) add(br, bl);
      if (!inside(i - 1, j)) add(bl, tl);
    }
  }
  let total = 0;
  for (const v of next.values()) total += v.length;
  if (total === 0) return null;

  // Chain from the top-left-most start; edges left over mean a second loop (a hole) → null.
  const startKey = [...next.keys()].sort((p, q) => {
    const [px, py] = p.split(',').map(Number), [qx, qy] = q.split(',').map(Number);
    return py - qy || px - qx;
  })[0];
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
  let remaining = 0;
  for (const v of next.values()) remaining += v.length;
  if (remaining !== 0) return null;

  // Drop collinear intermediate corners.
  const out: Polygon = [];
  for (let i = 0; i < loop.length; i++) {
    const p = loop[(i - 1 + loop.length) % loop.length], c = loop[i], n = loop[(i + 1) % loop.length];
    const collinear = (Math.abs(p.x - c.x) < 1e-9 && Math.abs(c.x - n.x) < 1e-9)
      || (Math.abs(p.y - c.y) < 1e-9 && Math.abs(c.y - n.y) < 1e-9);
    if (!collinear) out.push({ x: clean(c.x), y: clean(c.y) });
  }
  return out.length >= 3 ? out : null;
}

/** How close BOTH ends of a drawn segment must be to one edge to land on it (1 % of the plan). */
export const SEGMENT_SNAP_TOL = 0.01;

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

function projectOnto(p: Point, e: Segment): { point: Point; dist: number } {
  const dx = e.x2 - e.x1, dy = e.y2 - e.y1;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - e.x1) * dx + (p.y - e.y1) * dy) / len2));
  const q = { x: r6(e.x1 + dx * t), y: r6(e.y1 + dy * t) };
  return { point: q, dist: Math.hypot(q.x - p.x, q.y - p.y) };
}

/**
 * A two-click segment (a window, a wall stub) drawn ALONG a wall lands ON the
 * wall (Layout Designer 2D, 2026-10-05): when BOTH ends lie within `tol` of the
 * SAME polygon edge, both are projected onto it. One end near one edge and the
 * other near a different edge is not "along a wall" and is left alone, as is a
 * free segment across a room — Module-E's duct stubs are drawn that way.
 */
export function segmentOnEdge(a: Point, b: Point, polys: Polygon[], tol = SEGMENT_SNAP_TOL): { a: Point; b: Point; snapped: boolean } {
  let best: { a: Point; b: Point; worst: number } | null = null;
  for (const poly of polys) {
    for (const e of polygonEdges(poly)) {
      const pa = projectOnto(a, e), pb = projectOnto(b, e);
      const worst = Math.max(pa.dist, pb.dist);
      if (worst <= tol && (!best || worst < best.worst)) best = { a: pa.point, b: pb.point, worst };
    }
  }
  return best ? { a: best.a, b: best.b, snapped: true } : { a, b, snapped: false };
}

/**
 * A double door is TWO doors on the same edge: half the width each, the first
 * hinged at its start and the second at its end, abutting at the middle of the
 * original opening — the `vPair` / `hPair` rule the traced floors use. No flag
 * in the data; the dashboard needs none.
 */
export function splitDoor<D extends { offset: number; width: number; hinge?: string }>(door: D): [D, D] {
  const half = r6(door.width / 2);
  return [
    { ...door, width: half, hinge: 'start' },
    { ...door, offset: r6(door.offset + half), width: half, hinge: 'end' },
  ];
}
