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
const XS = new Set([0, 146.5, 165, 297, 433, 488, 570.5, 707, 719, 844, 949, 1057, 1134, 1177, 1381]);
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
    expect(top.offset).toBeCloseTo((225 - 165) / 132, 5);
    // CORRIDOR-09's bottom wall runs RIGHT TO LEFT (edge 2), so the same
    // drawing-side hinge ('to', the higher x) is that edge's START.
    const cor = room('CWH-I/203');
    const south = edgeDoor(cor, cor.doors[1]);
    expect(south.edge).toBe(2);
    expect(south.hinge).toBe('start');
    expect(south.offset).toBeCloseTo((1134 - 793) / 563.5, 5);
  });

  /**
   * The four things the overlay on the drawing found off (operator: "rooms
   * dooars and room lines are some places not matches with image").
   */
  describe('where the first version did not sit on the drawing', () => {
    const inc2 = room('CWH-I/360');

    it('INCUBATOR ROOM-02 has TWO east walls: the labs\' wall is its edge, its own partition a stub broken at the doors', () => {
      // The room steps from the partition (beside the corridor) to the labs' wall.
      expect(inc2.outline).toEqual([[0, 80], [146.5, 80], [146.5, 178.5], [165, 178.5], [165, 660], [0, 660]]);
      expect(room('CWH-I/208').outline[0]).toEqual([146.5, 80]);          // CORRIDOR-10 starts at the partition
      expect(room('CWH-I/211').outline[0]).toEqual([165, 178.5]);         // the BSC room at the labs' wall
      expect(room('INCUBATOR-01').outline[0]).toEqual([165, 415]);
      // The door pair hangs on the labs' wall, x 165, as drawn...
      const pair = inc2.doors.filter((d) => d.axis === 'x');
      expect(pair.map((d) => d.at)).toEqual([165, 165]);
      // ...and the partition stub leaves exactly that stretch open.
      const [upper, lower] = L.annotations.walls;
      expect([upper[0], upper[2], lower[0], lower[2]]).toEqual([146.5, 146.5, 146.5, 146.5]);
      expect([upper[3], lower[1]]).toEqual([pair[0].from, pair[1].to]);
      expect([pair[0].from, pair[1].to]).toEqual([488, 572]);
      // ...starting below CORRIDOR-10's wall and stopping short of the south wall.
      expect(upper[1]).toBeGreaterThan(178.5); expect(upper[1]).toBeLessThan(190);
      expect(lower[3]).toBeLessThan(660); expect(lower[3]).toBeGreaterThan(648);
      // Each window sits ON its wall line.
      const onLine = (x: number) => L.annotations.windows.filter(([x0, , x1]) => x0 < x && x1 > x && x1 - x0 < 20);
      expect(onLine(146.5)).toHaveLength(1);    // the breakable glass
      expect(onLine(165)).toHaveLength(1);      // the BSC room's window
    });

    it('the emergency exit pair swings OUT of the building, and the canvas holds its leaves', () => {
      const exit = inc2.doors.filter((d) => d.axis === 'y');
      expect(exit).toHaveLength(2);
      for (const d of exit) {
        expect(d.swing).toBe('out');
        expect(edgeDoor(inc2, d).swing).toBe('out');
        // A leaf as long as its gap, standing above the north wall (y 80).
        expect(80 - (d.to - d.from)).toBeGreaterThan(L.building.y0);
      }
      // Every other door swings into its own room, and says nothing.
      const others = L.rooms.flatMap((r) => r.doors.map((d) => edgeDoor(r, d))).filter((d) => d.swing !== undefined);
      expect(others).toHaveLength(2);
    });

    it('the sterilizer and the cross-over bench are outlined, inside the building, clear of the wall faces', () => {
      const ann = archAnnotations(L.building, L.annotations);
      expect(ann.equipment).toHaveLength(2);
      expect(ann.labels.map((l) => l.text)).toEqual(['HPHV', 'STERILIZER']);
      const [ster, cob] = L.annotations.equipment!;
      // The sterilizer straddles the COOLING ZONE | STERILIZATION wall (x 844).
      expect(ster[0]).toBeLessThan(844); expect(ster[2]).toBeGreaterThan(844);
      // The bench stands inside the CHANGE ROOM, wall to wall.
      const change = room('CWH-I/196').outline;
      expect(cob[0]).toBeGreaterThan(change[0][0]); expect(cob[2]).toBeLessThan(change[1][0]);
      expect(cob[1]).toBeGreaterThan(change[0][1]); expect(cob[3]).toBeLessThan(change[2][1]);
      for (const b of ann.equipment) { expect(b.w).toBeGreaterThan(0); expect(b.h).toBeGreaterThan(0); }
    });
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
    expect(archCanvas(b)).toEqual({ width: 1406, height: 640 });
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
