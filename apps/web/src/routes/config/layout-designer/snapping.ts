import { polygonEdges, type Point, type Polygon } from '@digilog/shared';

/**
 * Snapping for the Layout Designer canvas, pure. Plan units 0..1 throughout.
 *
 * Priority, and why: a corner of ANOTHER room first, then a point on another
 * room's edge, then the grid. Two rooms that share a wall must share it
 * EXACTLY — `sharedEdges` has a tolerance of half a viewBox unit — and the
 * only way a hand can hit that is by snapping to the neighbour, so the
 * neighbour beats the grid. The grid is for the first room on an empty plan.
 */

/** 2 % of the plan. */
export const GRID = 0.02;
/** 1 % of the plan: how close the pointer must be to a corner or an edge to snap. */
export const SNAP_TOL = 0.01;

const r = (n: number) => Math.round(n * 1e6) / 1e6;

/** The nearest point on any edge of `poly` to `p`, with its edge and fraction. */
export function nearestEdgePoint(p: Point, poly: Polygon): { edge: number; t: number; point: Point; dist: number } {
  let best = { edge: -1, t: 0, point: p, dist: Infinity };
  polygonEdges(poly).forEach((e, i) => {
    const dx = e.x2 - e.x1, dy = e.y2 - e.y1;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - e.x1) * dx + (p.y - e.y1) * dy) / len2));
    const q = { x: r(e.x1 + dx * t), y: r(e.y1 + dy * t) };
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < best.dist) best = { edge: i, t, point: q, dist: d };
  });
  return best;
}

/** Shift held: the next edge is horizontal or vertical, whichever is closer. */
export function rightAngle(from: Point, p: Point): Point {
  return Math.abs(p.x - from.x) >= Math.abs(p.y - from.y) ? { x: p.x, y: from.y } : { x: from.x, y: p.y };
}

export function snapPoint(p: Point, others: Polygon[], opts: { grid?: boolean; shiftFrom?: Point | null } = {}): Point {
  let q = opts.shiftFrom ? rightAngle(opts.shiftFrom, p) : p;
  let best: { point: Point; dist: number } | null = null;
  for (const poly of others) {
    for (const c of poly) {
      const d = Math.hypot(c.x - q.x, c.y - q.y);
      if (d <= SNAP_TOL && (!best || d < best.dist)) best = { point: c, dist: d };
    }
  }
  if (best) return best.point;
  for (const poly of others) {
    const n = nearestEdgePoint(q, poly);
    if (n.dist <= SNAP_TOL && (!best || n.dist < best.dist)) best = { point: n.point, dist: n.dist };
  }
  if (best) return best.point;
  if (opts.grid === false) return { x: Math.min(1, Math.max(0, q.x)), y: Math.min(1, Math.max(0, q.y)) };
  q = { x: r(Math.round(q.x / GRID) * GRID), y: r(Math.round(q.y / GRID) * GRID) };
  return { x: Math.min(1, Math.max(0, q.x)), y: Math.min(1, Math.max(0, q.y)) };
}
