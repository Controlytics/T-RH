import { describe, it, expect } from 'vitest';
import { polygonArea, pointInPolygon, validatePolygon, sharedEdges } from '@digilog/shared';
import { QC3_LAYOUT as L } from '../qc3-layout.js';
import { archPoints, archAnnotations, archCanvas, edgeDoor } from '../architectural-layout.js';
import { validateRoomPayload, roomGeometry } from '../validation.js';

/**
 * "CWH — QC 3", traced from `Layouts/CWH/QC 3 Layout.png` and drawn in the 2D
 * architectural style (2026-10-01, operator: "everything should 100 % matched
 * doors and room lines everything"). The discipline a hand-traced table needs,
 * tested: rooms valid, no overlap, the L-shaped building covered EXACTLY,
 * every corner on a measured wall line, every door on its own room's wall,
 * every symbol inside the canvas, every instrument in the room its `Location`
 * attribute names.
 */
const px = (r: (typeof L.rooms)[number]) => r.outline.map(([x, y]) => ({ x, y }));
const room = (code: string) => L.rooms.find((r) => r.code === code)!;
const XS = new Set([21.5, 192.5, 238.5, 249.5, 311.5, 312.5, 338, 386.5, 387, 450.5, 461.5, 506, 640.5, 696, 786, 845]);
const YS = new Set([6, 54, 74.5, 120, 131.5, 134.5, 178, 211.5, 283, 332.5, 375, 438.5, 482, 494.5, 511.5, 530.5, 593.5, 663.5, 665.5, 709.5, 785.5]);
// The building is an L: the main block, and the east band down to y 530.5.
const inBuilding = (x: number, y: number) =>
  (x > 21.5 && x < 696 && y > 6 && y < 785.5) || (x >= 696 && x < 845 && y > 6 && y < 530.5);
const BUILDING_AREA = (696 - 21.5) * (785.5 - 6) + (845 - 696) * (530.5 - 6);

describe('QC 3 trace', () => {
  it('is drawn ON the area\'s own plan, in the 2D style', () => {
    expect(L.area).toBe('QC 3');
    expect(L.planName).toBe('CWH — QC 3');
    expect(archAnnotations(L.building, L.annotations).style).toBe('architectural');
  });

  it('gives every room a unique code', () => {
    const codes = L.rooms.map((r) => r.code);
    expect(codes).toHaveLength(31);
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

  it('takes every corner from a measured wall line', () => {
    for (const r of L.rooms) {
      for (const [x, y] of r.outline) {
        expect(XS.has(x), `${r.code} x ${x} off-grid`).toBe(true);
        expect(YS.has(y), `${r.code} y ${y} off-grid`).toBe(true);
      }
    }
  });

  it('the rooms TILE the L-shaped building: areas sum to it exactly, every point in exactly one room, the yard in none', () => {
    const total = L.rooms.reduce((n, r) => n + polygonArea(px(r)), 0);
    expect(total).toBeCloseTo(BUILDING_AREA, 3);
    for (let y = 9.3; y < 786; y += 11) {
      for (let x = 24.3; x < 846; x += 11) {
        const inside = L.rooms.filter((r) => pointInPolygon({ x, y }, px(r)));
        expect(inside.length, `(${x},${y}) in ${inside.map((r) => r.code).join(', ')}`).toBe(inBuilding(x, y) ? 1 : 0);
      }
    }
  });

  it('CORRIDOR-11 is two pieces of ONE code that meet on both legs, so the view draws one ring', () => {
    const ring = room('CWH-I/235'), south = room('CWH-I/235 (2)');
    expect(ring.outline).toHaveLength(8);                 // the north band and both legs: a U
    expect(ring.grade).toBe('CIRCULATION'); expect(south.grade).toBe('CIRCULATION');
    expect(sharedEdges(archPoints(L.building, ring), archPoints(L.building, south))).toHaveLength(2);
    // No other continuation pieces: the hold area is one L, not two boxes.
    expect(L.rooms.filter((r) => / \(\d+\)$/.test(r.code)).map((r) => r.code)).toEqual(['CWH-I/235 (2)']);
    expect(room('CWH-I/187').outline).toHaveLength(6);
  });

  it('every door converts onto an edge of its own room, inside that edge', () => {
    let leaves = 0, openings = 0;
    for (const r of L.rooms) {
      for (const d of r.doors) {
        const e = edgeDoor(r, d);
        expect(e.offset, r.code).toBeGreaterThanOrEqual(0);
        expect(e.width, r.code).toBeGreaterThan(0);
        expect(e.offset + e.width, r.code).toBeLessThanOrEqual(1);
        if (d.hinge === 'none') openings += 1; else leaves += 1;
      }
    }
    // 16 single doors + 14 double (two leaves each) = 44 leaves; 4 openings.
    expect(leaves).toBe(44);
    expect(openings).toBe(4);
  });

  it('the three weighing areas are open bays, and the hot zone opens into the wet lab — an opening, no leaf', () => {
    for (const code of ['CWH-I/244', 'CWH-I/241', 'CWH-I/254']) {
      const r = room(code);
      expect(r.doors, code).toHaveLength(1);
      const e = edgeDoor(r, r.doors[0]);
      expect(e, code).toMatchObject({ offset: 0, width: 1, hinge: 'none' });   // the whole corridor side
    }
    const hot = edgeDoor(room('CWH-I/258'), room('CWH-I/258').doors[0]);
    expect(hot.hinge).toBe('none');
    expect(hot.width).toBeCloseTo(28 / 190, 5);
  });

  it('a double door is two leaves hung on the two jambs, a pixel apart', () => {
    const r = room('CWH-I/245');
    expect(r.doors.map((d) => [d.from, d.to, d.hinge])).toEqual([[99, 113, 'from'], [114, 128, 'to']]);
    const [a, b] = r.doors.map((d) => edgeDoor(r, d));
    expect(a.edge).toBe(b.edge);
    expect(a.offset + a.width).toBeLessThan(b.offset);
  });

  it('only the corridor\'s two exits open OUT of the building', () => {
    const out = L.rooms.flatMap((r) => r.doors.filter((d) => d.swing === 'out').map((d) => [r.code, d.at, d.kind]));
    expect(out).toEqual([
      ['CWH-I/235', 785.5, 'EXIT'], ['CWH-I/235', 785.5, 'EXIT'], ['CWH-I/235', 785.5, 'EXIT'], ['CWH-I/235', 785.5, 'EXIT'],
    ]);
    // ...and the canvas holds their leaves: 19 px below the south wall.
    expect(L.building.y1).toBeGreaterThan(785.5 + 19 + 6);
  });

  it('the KF room has no door to the corridor: it is reached through the airlock', () => {
    const kf = room('CWH-I/260');
    expect(kf.doors.map((d) => d.at)).toEqual([640.5]);               // the wall it shares with the AIRLOCK
    expect(room('CWH-I/259').doors.map((d) => d.at)).toEqual([511.5]); // the AIRLOCK's, in the WET LAB's south wall
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

  it('the structure is the drawing\'s: a 4 x 4 grid of columns plus the wall ones, the windows, the outlined plant — all inside the canvas', () => {
    const b = L.building, a = L.annotations;
    expect(a.columns).toHaveLength(16 + 7 + 3);
    expect(a.windows).toHaveLength(7);
    expect(a.equipment).toHaveLength(3);
    for (const [x0, y0, x1, y1] of [...a.columns, ...a.windows, ...a.equipment!]) {
      expect(x0).toBeGreaterThanOrEqual(b.x0); expect(x1).toBeLessThanOrEqual(b.x1);
      expect(y0).toBeGreaterThanOrEqual(b.y0); expect(y1).toBeLessThanOrEqual(b.y1);
      expect(x1).toBeGreaterThan(x0); expect(y1).toBeGreaterThan(y0);
    }
    // The interior grid is regular: four columns across, four down.
    const grid = a.columns.slice(0, 16);
    expect(new Set(grid.map((c) => c[0])).size).toBe(4);
    expect(new Set(grid.map((c) => c[1])).size).toBe(4);
    expect(archCanvas(b)).toEqual({ width: 870, height: 818 });
  });

  it('sites each instrument in the room its Location attribute names, once', () => {
    const actual = Object.fromEntries(L.rooms.filter((r) => r.instrument).map((r) => [r.code, r.instrument]));
    expect(actual).toEqual({
      'CWH-I/250': 'CWH/RDU/002-01', // LCMS Room-II
      'CWH-I/245': 'CWH/RDU/003-00', // Working standard & reference standard storage Room
      'CWH-I/261': 'CWH/RDU/004-00', // Sieve Analyzer & BD Apparatus Room
      'CWH-I/260': 'CWH/RDU/005-00', // KF & Auto titrator Room
      'CWH-I/252': 'CWH/RDU/006-00', // Dissolution & UV Room
      'CWH-I/255': 'CWH/RDU/007-00', // Malvern/AAS Instrument Room
      'CWH-I/256': 'CWH/RDU/008-00', // GC/GCMS Room
      'CWH-I/257': 'CWH/RDU/009-00', // Wet Lab
      'CWH-I/243': 'CWH/RDU/010-00', // Sample Preparation Room
      'CWH-I/242': 'CWH/RDU/011-00', // HPLC Room
      'CWH-I/246': 'CWH/RDU/012-00', // LCMS Room-I
      'CWH-I/240': 'CWH/RDU/026-00', // Sample Receipt & Sample Storage Room
    });
  });
});
