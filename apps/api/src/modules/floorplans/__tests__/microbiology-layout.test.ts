import { describe, it, expect } from 'vitest';
import { polygonArea, pointInPolygon, validatePolygon, sharedEdges } from '@digilog/shared';
import { MICROBIOLOGY_LAYOUT as L } from '../microbiology-layout.js';
import { archPoints, archAnnotations, archCanvas, edgeDoor } from '../architectural-layout.js';
import { validateRoomPayload, roomGeometry } from '../validation.js';

/**
 * "CWH — QC Microbiology", traced from `Layouts/CWH/Microbiology.png` and drawn
 * in the 2D architectural style (2026-10-01). A hand-traced table only
 * tessellates by discipline, so the discipline is tested — the same set
 * `qc-layout-2.test.ts` runs for the QC floor: rooms valid, no overlap, the
 * interior covered EXACTLY, every edge on the measured grid, every door on its
 * room's wall, every symbol inside the building, and every instrument in the
 * room its `Location` attribute names.
 */
const px = (r: (typeof L.rooms)[number]) => r.outline.map(([x, y]) => ({ x, y }));
const INNER = { x0: 0, y0: 80, x1: 1381, y1: 660 };
const XS = new Set([0, 157, 297, 433, 488, 570.5, 707, 719, 844, 949, 1057, 1134, 1177, 1381]);
const YS = new Set([80, 178.5, 230.5, 323, 382.5, 415, 512.5, 660]);
const room = (code: string) => L.rooms.find((r) => r.code === code)!;

describe('Microbiology trace', () => {
  it('is drawn ON the area\'s own plan, in the 2D style', () => {
    expect(L.area).toBe('QC Microbiology');
    expect(L.planName).toBe('CWH — QC Microbiology');
    expect(archAnnotations(L.building, L.annotations).style).toBe('architectural');
  });

  it('gives every room a unique code', () => {
    const codes = L.rooms.map((r) => r.code);
    expect(codes).toHaveLength(21);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('every outline is a valid simple polygon, stored inside the plan', () => {
    for (const r of L.rooms) {
      const pts = archPoints(L.building, r);
      expect(validatePolygon(pts).ok, r.code).toBe(true);
      for (const p of pts) {
        expect(p.x, r.code).toBeGreaterThan(0); expect(p.x, r.code).toBeLessThan(1);
        expect(p.y, r.code).toBeGreaterThan(0); expect(p.y, r.code).toBeLessThan(1);
      }
    }
  });

  it('takes every corner from the measured wall grid', () => {
    for (const r of L.rooms) {
      for (const [x, y] of r.outline) {
        expect(XS.has(x), `${r.code} x ${x} off-grid`).toBe(true);
        expect(YS.has(y), `${r.code} y ${y} off-grid`).toBe(true);
      }
    }
  });

  it('the rooms TILE the interior: their areas sum to it exactly, and no point lies in two', () => {
    const total = L.rooms.reduce((n, r) => n + polygonArea(px(r)), 0);
    expect(total).toBeCloseTo((INNER.x1 - INNER.x0) * (INNER.y1 - INNER.y0), 3);
    for (let y = INNER.y0 + 3.3; y < INNER.y1; y += 13) {
      for (let x = INNER.x0 + 3.3; x < INNER.x1; x += 13) {
        const inside = L.rooms.filter((r) => pointInPolygon({ x, y }, px(r)));
        expect(inside.length, `(${x},${y}) in ${inside.map((r) => r.code).join(', ')}`).toBe(1);
      }
    }
  });

  it('INCUBATOR ROOM-01 is ONE L-shaped room: it wraps the GENERAL LAB\'s corner and meets CORRIDOR-09', () => {
    const inc = room('INCUBATOR-01');
    expect(inc.outline).toHaveLength(6);
    expect(L.rooms.some((r) => / \(\d+\)$/.test(r.code))).toBe(false);   // no continuation pieces
    const pts = archPoints(L.building, inc);
    expect(sharedEdges(pts, archPoints(L.building, room('CWH-I/201')))).toHaveLength(2);   // its top-left corner
    expect(sharedEdges(pts, archPoints(L.building, room('CWH-I/203')))).toHaveLength(1);   // the corridor's west end
  });

  it('the two corridors never touch, so the view cannot join them into one space', () => {
    expect(sharedEdges(archPoints(L.building, room('CWH-I/208')), archPoints(L.building, room('CWH-I/203')))).toHaveLength(0);
  });

  it('every door converts onto an edge of its own room, inside that edge', () => {
    let n = 0;
    for (const r of L.rooms) {
      for (const d of r.doors) {
        const e = edgeDoor(r, d);
        expect(e.offset, r.code).toBeGreaterThanOrEqual(0);
        expect(e.width, r.code).toBeGreaterThan(0);
        expect(e.offset + e.width, r.code).toBeLessThanOrEqual(1);
        n += 1;
      }
    }
    // 21 single doors (18 orange arcs, 2 black, 1 green) + the blue pair + the red pair.
    expect(n).toBe(25);
  });

  it('a door is hung on the end the drawing hangs it on', () => {
    // BSC room: gap x 225..282 in its top wall, leaf drawn at x 282 — the far
    // end of an edge that runs left to right.
    const bsc = room('CWH-I/211');
    const top = edgeDoor(bsc, bsc.doors[0]);
    expect(top.edge).toBe(0);
    expect(top.hinge).toBe('end');
    expect(top.offset).toBeCloseTo((225 - 157) / 140, 5);
    // CORRIDOR-09's bottom wall runs RIGHT TO LEFT (edge 2), so the same
    // drawing-side hinge ('to', the higher x) is that edge's START.
    const cor = room('CWH-I/203');
    const south = edgeDoor(cor, cor.doors[1]);
    expect(south.edge).toBe(2);
    expect(south.hinge).toBe('start');
    expect(south.offset).toBeCloseTo((1134 - 793) / 563.5, 5);
  });

  it('every room passes the API\'s own room validation, pairs of leaves included', () => {
    for (const r of L.rooms) {
      const points = archPoints(L.building, r);
      const v = validateRoomPayload({
        code: r.code, label: r.label, ...roomGeometry({ x: 0, y: 0, w: 1, h: 1, points }), points,
        doors: r.doors.map((d) => edgeDoor(r, d)), grade: r.grade ?? null,
      });
      expect(v.ok, `${r.code}: ${v.ok ? '' : v.error}`).toBe(true);
    }
  });

  it('every column and window lies inside the building', () => {
    const b = L.building;
    for (const [x0, y0, x1, y1] of [...L.annotations.columns, ...L.annotations.windows]) {
      expect(x0).toBeGreaterThanOrEqual(b.x0); expect(x1).toBeLessThanOrEqual(b.x1);
      expect(y0).toBeGreaterThanOrEqual(b.y0); expect(y1).toBeLessThanOrEqual(b.y1);
      expect(x1).toBeGreaterThan(x0); expect(y1).toBeGreaterThan(y0);
    }
    expect(L.annotations.columns).toHaveLength(4);
    expect(L.annotations.windows).toHaveLength(7);
  });

  it('the canvas is wider than the rooms on every side, so no outer wall is drawn on its edge', () => {
    const b = L.building;
    expect(INNER.x0 - b.x0).toBeGreaterThanOrEqual(6); expect(b.x1 - INNER.x1).toBeGreaterThanOrEqual(6);
    expect(INNER.y0 - b.y0).toBeGreaterThanOrEqual(6); expect(b.y1 - INNER.y1).toBeGreaterThanOrEqual(6);
    expect(archCanvas(b)).toEqual({ width: 1406, height: 600 });
  });

  it('sites each instrument in the room its Location attribute names, once', () => {
    const actual = Object.fromEntries(L.rooms.filter((r) => r.instrument).map((r) => [r.code, r.instrument]));
    expect(actual).toEqual({
      'CWH-I/209': 'CWH/RDU/045-00',    // LAF-1(Microbiology)
      'CWH-I/210': 'CWH/RDU/046-00',    // LAF-2(Microbiology)
      'CWH-I/211': 'CWH/RDU/047-00',    // BSC Room (Microbiology)
      'CWH-I/198': 'CWH/RDU/048-00',    // Water wet analysis Room (Microbiology)
      'CWH-I/213': 'CWH/RDU/049-00',    // Media Preparation Room (Microbiology)
      'CWH-I/201': 'CWH/RDU/050-00',    // General Lab (Microbiology)
      'INCUBATOR-01': 'CWH/RDU/051-00', // Incubator room (Microbiology) — unnumbered on the drawing
      'CWH-I/215': 'CWH/RDU/052-00',    // Media Storage room (Microbiology)
    });
  });
});
