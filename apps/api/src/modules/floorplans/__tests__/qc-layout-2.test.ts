import { describe, it, expect } from 'vitest';
import { polygonArea, pointInPolygon, validatePolygon, sharedEdges } from '@digilog/shared';
import { QC2_ROOMS, QC2_BUILDING, QC2_ANNOTATIONS, points2, edgeDoor } from '../qc-layout-2.js';
import { QC_ROOMS } from '../qc-layout.js';

/**
 * "CWH — QC Layout-2", traced from `Layouts/CWH/QC Layout-2.png` (2026-10-01).
 * A hand-traced table only tessellates by discipline, so the discipline is
 * tested: rooms valid, no overlap, the interior covered EXACTLY, every door on
 * its room's wall, every symbol inside the building, and every instrument in
 * the room the first QC trace (same floor) puts it in.
 */
const px = (r: (typeof QC2_ROOMS)[number]) => r.outline.map(([x, y]) => ({ x, y }));
const INNER = { x0: 23, y0: 10, x1: 1055, y1: 1426 };

describe('QC Layout-2 trace', () => {
  it('every outline is a valid simple polygon, stored inside the plan', () => {
    for (const r of QC2_ROOMS) {
      const v = validatePolygon(points2(r));
      expect(v.ok, r.code).toBe(true);
      for (const p of points2(r)) { expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(1); expect(p.y).toBeGreaterThanOrEqual(0); expect(p.y).toBeLessThanOrEqual(1); }
    }
  });

  it('the rooms TILE the interior: their areas sum to it exactly, and no point lies in two', () => {
    const total = QC2_ROOMS.reduce((n, r) => n + polygonArea(px(r)), 0);
    expect(total).toBeCloseTo((INNER.x1 - INNER.x0) * (INNER.y1 - INNER.y0), 3);
    for (let y = INNER.y0 + 3.3; y < INNER.y1; y += 17) {
      for (let x = INNER.x0 + 3.3; x < INNER.x1; x += 17) {
        const inside = QC2_ROOMS.filter((r) => pointInPolygon({ x, y }, px(r)));
        expect(inside.length, `(${x},${y}) in ${inside.map((r) => r.code).join(', ')}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('the two L-shaped rooms share the stepped partition exactly', () => {
    const prep = QC2_ROOMS.find((r) => r.code === 'CWH-I/222')!;
    const hplc = QC2_ROOMS.find((r) => r.code === 'CWH-I/223')!;
    const shared = sharedEdges(points2(prep), points2(hplc));
    expect(shared.length).toBe(3);   // x 365.5 upper, y 781.5 step, x 206 lower
  });

  it('every door converts onto an edge of its own room, inside that edge', () => {
    let n = 0;
    for (const r of QC2_ROOMS) {
      for (const d of r.doors) {
        const e = edgeDoor(r, d);
        expect(e.offset, `${r.code}`).toBeGreaterThanOrEqual(0);
        expect(e.offset + e.width, `${r.code}`).toBeLessThanOrEqual(1);
        n += 1;
      }
    }
    // 20 interior doors (one per swing arc on the drawing) + 4 exterior.
    expect(n).toBe(24);
  });

  it('a door is converted from its edge START along the edge direction', () => {
    // The corridor's west wall south piece runs UP from (23,1266.5) to (23,1161.5);
    // a gap at y 1184..1245 therefore starts 21.5 px along it.
    const corridor = QC2_ROOMS.find((r) => r.code === 'CWH-I/217')!;
    const e = edgeDoor(corridor, corridor.doors[0]);
    expect(e.edge).toBe(5);
    expect(e.offset).toBeCloseTo(21.5 / 105, 5);
  });

  it('every column and window lies inside the building', () => {
    for (const [x0, y0, x1, y1] of [...QC2_ANNOTATIONS.columns, ...QC2_ANNOTATIONS.windows]) {
      expect(x0).toBeGreaterThanOrEqual(QC2_BUILDING.x0); expect(x1).toBeLessThanOrEqual(QC2_BUILDING.x1);
      expect(y0).toBeGreaterThanOrEqual(QC2_BUILDING.y0); expect(y1).toBeLessThanOrEqual(QC2_BUILDING.y1);
    }
    expect(QC2_ANNOTATIONS.columns).toHaveLength(10);
    expect(QC2_ANNOTATIONS.windows).toHaveLength(17);
  });

  it('every instrument sits in the room of the same code as on the first QC trace', () => {
    const first = new Map(QC_ROOMS.filter((r) => r.instrument).map((r) => [r.instrument!, r.code]));
    const here = QC2_ROOMS.filter((r) => r.instrument);
    expect(here).toHaveLength(12);
    for (const r of here) expect(first.get(r.instrument!), r.instrument).toBe(r.code);
  });
});
