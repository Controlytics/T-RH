import { doorEdge, polygonEdges, type EdgeOpening, type Polygon, type Point } from '@digilog/shared';
import type { RoomDoor } from '@/routes/dashboard/room-geometry';
import type { DesignerLink } from './types';

/**
 * Where a door or an opening sits after its room's OUTLINE changes
 * (audit 2026-10-12 finding 3). A door names an edge INDEX (or, from before
 * polygons, a wall, which is edge 0..3), and an opening link names
 * `fromEdge`; inserting a corner renumbers every edge after it, deleting one
 * merges two edges, and a merge replaces the outline. Re-sending the stored
 * index put the door on the wrong wall. These are pure, so each rule is
 * tested on its own; the server still checks every opening against the real
 * geometry (409 LINK_OFF_WALL) and every door against the outline.
 *
 * A mapper takes a span on an OLD edge and returns it on the NEW outline, or
 * null when it no longer sits on one edge (it straddled the new corner, or
 * its wall is gone). `reversed` is true when the edge now runs the other way,
 * so a door's hinge end flips with it.
 */
export type SpanMap = (span: EdgeOpening) => (EdgeOpening & { reversed: boolean }) | null;

const EPS = 1e-6;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** A corner `p` inserted on edge `edge`: that edge splits in two, every later edge moves up one. */
export function insertCornerMap(old: Polygon, edge: number, p: Point): SpanMap {
  const e = polygonEdges(old)[edge];
  const len2 = (e.x2 - e.x1) ** 2 + (e.y2 - e.y1) ** 2;
  // Where along the split edge the new corner falls, 0..1.
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((p.x - e.x1) * (e.x2 - e.x1) + (p.y - e.y1) * (e.y2 - e.y1)) / len2)) : 0.5;
  return (s) => {
    if (s.edge < edge) return { ...s, reversed: false };
    if (s.edge > edge) return { ...s, edge: s.edge + 1, reversed: false };
    // On the split edge: the half it lies in, its fractions rescaled to that half.
    if (t > EPS && s.offset + s.width <= t + EPS) return { edge, offset: r6(s.offset / t), width: r6(s.width / t), reversed: false };
    if (t < 1 - EPS && s.offset >= t - EPS) return { edge: edge + 1, offset: r6((s.offset - t) / (1 - t)), width: r6(s.width / (1 - t)), reversed: false };
    return null;   // straddles the new corner
  };
}

/**
 * Corner `k` deleted: edges k-1 and k (the two that met at it) become one
 * edge; every later edge moves down one. A span on either merged edge keeps
 * its place only if it still lies along the new edge (the corner was on a
 * straight wall); otherwise its wall is gone.
 */
export function deleteCornerMap(old: Polygon, k: number): SpanMap {
  const n = old.length;
  const next = old.filter((_, i) => i !== k);
  const geo = geometricMap(old, next);
  const before = (k - 1 + n) % n;
  return (s) => {
    if (s.edge === before || s.edge === k) return geo(s);
    const shifted = s.edge > k ? s.edge - 1 : s.edge;
    return { ...s, edge: shifted, reversed: false };
  };
}

/**
 * By geometry: the span's two end points on the old outline, found again on
 * whichever edge of the new outline they both lie along. For a MERGE, where
 * the new outline shares no numbering with the old.
 */
export function geometricMap(old: Polygon, next: Polygon, tol = 0.0005): SpanMap {
  const oldEdges = polygonEdges(old);
  const newEdges = polygonEdges(next);
  return (s) => {
    const e = oldEdges[s.edge];
    if (!e) return null;
    const at = (t: number) => ({ x: e.x1 + (e.x2 - e.x1) * t, y: e.y1 + (e.y2 - e.y1) * t });
    const p1 = at(s.offset), p2 = at(s.offset + s.width);
    for (let j = 0; j < newEdges.length; j++) {
      const f = newEdges[j];
      const dx = f.x2 - f.x1, dy = f.y2 - f.y1;
      const len = Math.hypot(dx, dy);
      if (len < EPS) continue;
      const dist = (q: Point) => Math.abs((q.x - f.x1) * dy - (q.y - f.y1) * dx) / len;
      if (dist(p1) > tol || dist(p2) > tol) continue;
      const param = (q: Point) => ((q.x - f.x1) * dx + (q.y - f.y1) * dy) / (len * len);
      const u1 = param(p1), u2 = param(p2);
      const lo = Math.min(u1, u2), hi = Math.max(u1, u2);
      if (lo < -tol / len || hi > 1 + tol / len) continue;
      return { edge: j, offset: r6(Math.max(0, lo)), width: r6(Math.min(1, hi) - Math.max(0, lo)), reversed: u1 > u2 };
    }
    return null;
  };
}

/** The room's doors on the new outline, and how many no longer fit on any wall. */
export function remapDoors(doors: RoomDoor[], oldPoly: Polygon, map: SpanMap): { doors: RoomDoor[]; dropped: number } {
  const out: RoomDoor[] = [];
  let dropped = 0;
  for (const d of doors) {
    const edge = doorEdge(d, oldPoly);
    const m = edge < 0 ? null : map({ edge, offset: d.offset, width: d.width });
    if (!m) { dropped += 1; continue; }
    // Always by EDGE now: a wall name means edge 0..3 only on a four-corner room.
    const { wall: _wall, ...rest } = d;
    void _wall;
    const hinge = m.reversed && (d.hinge === 'start' || d.hinge === undefined) ? 'end' : m.reversed && d.hinge === 'end' ? 'start' : d.hinge;
    out.push({ ...rest, edge: m.edge, offset: m.offset, width: m.width, ...(hinge !== undefined ? { hinge } : {}) });
  }
  return { doors: out, dropped };
}

/**
 * The room's OWN openings (links that start on it) on the new outline, as the
 * room PUT's `linkEdges`, and the ones that no longer sit on any wall — which
 * the caller must refuse rather than drop: a link is its own §11 record.
 */
export function remapOpenings(links: DesignerLink[], roomId: string, map: SpanMap): {
  linkEdges: { id: string; fromEdge: number; offset: number; width: number }[];
  off: DesignerLink[];
} {
  const linkEdges: { id: string; fromEdge: number; offset: number; width: number }[] = [];
  const off: DesignerLink[] = [];
  for (const l of links) {
    if (l.kind !== 'OPENING' || l.fromRoomId !== roomId || l.fromEdge === null || l.offset === null || l.width === null) continue;
    const m = map({ edge: l.fromEdge, offset: l.offset, width: l.width });
    if (!m) off.push(l);
    else if (m.edge !== l.fromEdge || m.offset !== l.offset || m.width !== l.width) linkEdges.push({ id: l.id, fromEdge: m.edge, offset: m.offset, width: m.width });
  }
  return { linkEdges, off };
}
