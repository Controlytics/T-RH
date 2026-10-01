import { describe, it, expect } from 'vitest';
import { polygonArea, pointInPolygon, validatePolygon, sharedEdges } from '@digilog/shared';
import { MODULE_E_LAYOUT as L } from '../module-e-layout.js';
import { archPoints, archAnnotations, archCanvas, edgeDoor } from '../architectural-layout.js';
import { validateRoomPayload, roomGeometry } from '../validation.js';

/**
 * "CWH — Module-E", traced from `Layouts/CWH/Module-E layout.pdf` and drawn in
 * the 2D architectural style (2026-10-01, operator: "do module-e layout also
 * same like qc"). The discipline a hand-authored table needs, tested: rooms
 * valid, no overlap, the module covered except for the voids the drawing has,
 * every corner on a wall line read from the PDF, every door on its own room's
 * wall, every symbol inside the canvas, every instrument in the room its
 * `Location` attribute names.
 */
const px = (r: (typeof L.rooms)[number]) => r.outline.map(([x, y]) => ({ x, y }));
const room = (code: string) => L.rooms.find((r) => r.code === code)!;
// The wall lines, in PDF points: each the midpoint of a pair of lines read from the file.
const XS = new Set([200.5, 233.5, 252.8, 267.3, 290.7, 305.4, 326.8, 363.9, 382.6, 389.9, 435, 483.5, 497.4, 506.5,
  558.9, 592.2, 611.1, 629.9, 730.9, 820.3, 838.7, 900.6, 974.5, 1001, 1023.9, 1061.4]);
const YS = new Set([253.5, 312.3, 321.2, 331.2, 379.7, 389.9, 399.9, 417.7, 418.2, 418.3, 434, 439.7, 449.5, 451,
  484.5, 488.4, 491.6, 536, 567.5, 580.5]);
const W = 200.5, E = 1061.4, N = 253.5, S = 580.5;

/** The VOIDS: what the drawing leaves outside every room, as rectangles [x0, y0, x1, y1]. */
const VOIDS: [number, number, number, number][] = [
  [497.4, N, 506.5, 312.3], [483.5, 312.3, 506.5, 321.2],            // the return duct beside the sifting room, and its foot
  [326.8, 389.9, 389.9, 399.9],                                      // the return duct under API dispensing
  [363.9, 399.9, 389.9, 439.7],                                      // the column casing east of binder preparation
  [558.9, 399.9, 838.7, 418.3],                                      // the central return duct
  [592.2, 418.3, 611.1, 434], [820.3, 418.3, 838.7, 434],            // the two column casings under it
  [W, 399.9, 305.4, 418.2],                                          // the cavity north of the south-west block
  [290.7, 418.2, 305.4, S],                                          // ...and east of it
  [305.4, 567.5, 730.9, S],                                          // behind the granulation area's south wall
];
const inVoid = (x: number, y: number) => VOIDS.some(([x0, y0, x1, y1]) => x > x0 && x < x1 && y > y0 && y < y1);
const VOID_AREA = VOIDS.reduce((n, [x0, y0, x1, y1]) => n + (x1 - x0) * (y1 - y0), 0);
const MODULE_AREA = (E - W) * (S - N);

describe('Module-E trace', () => {
  it('is drawn ON the area\'s own plan, in the 2D style', () => {
    expect(L.area).toBe('Module-E');
    expect(L.planName).toBe('CWH — Module-E');
    expect(archAnnotations(L.building, L.annotations).style).toBe('architectural');
  });

  it('gives every room a unique code', () => {
    const codes = L.rooms.map((r) => r.code);
    expect(codes).toHaveLength(25);
    expect(new Set(codes).size).toBe(codes.length);
    // The drawing codes TWO rooms CWH-I/017; a plan cannot.
    expect(room('CWH-I/017').label).toBe('BLENDING AREA');
    expect(room('CWH-I/017 (3.5KL BLENDER)').label).toBe('BLENDER AREA');
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

  it('takes every corner from a wall line read from the PDF', () => {
    for (const r of L.rooms) {
      for (const [x, y] of r.outline) {
        expect(XS.has(x), `${r.code} x ${x} off-grid`).toBe(true);
        expect(YS.has(y), `${r.code} y ${y} off-grid`).toBe(true);
      }
    }
  });

  it('the rooms and the drawing\'s voids TILE the module: every point in exactly one room or in a void, never both', () => {
    const total = L.rooms.reduce((n, r) => n + polygonArea(px(r)), 0);
    expect(total + VOID_AREA).toBeCloseTo(MODULE_AREA, 3);
    for (let y = N + 2.3; y < S; y += 7) {
      for (let x = W + 2.3; x < E; x += 7) {
        const inside = L.rooms.filter((r) => pointInPolygon({ x, y }, px(r)));
        expect(inside.length, `(${x},${y}) in ${inside.map((r) => r.code).join(', ') || 'nothing'}`).toBe(inVoid(x, y) ? 0 : 1);
      }
    }
  });

  it('the GRANULATION AREA is one room: the west side and the east side are both inside it', () => {
    const g = px(room('CWH-I/014'));
    expect(pointInPolygon({ x: 560, y: 300 }, g)).toBe(true);      // WEST SIDE, under its label
    expect(pointInPolygon({ x: 480, y: 500 }, g)).toBe(true);      // EAST SIDE
    expect(pointInPolygon({ x: 800, y: 460 }, g)).toBe(true);      // the bay between the duct and the wash area
    expect(pointInPolygon({ x: 700, y: 409 }, g)).toBe(false);     // the central duct
    expect(pointInPolygon({ x: 330, y: 420 }, g)).toBe(false);     // binder preparation
  });

  it('a door is on a wall of the room it is stored on, clear of the wall\'s ends', () => {
    for (const r of L.rooms) {
      for (const d of r.doors) {
        const e = edgeDoor(r, d);                                    // throws when no edge carries it
        expect(e.offset, `${r.code} door at ${d.at}`).toBeGreaterThanOrEqual(0);
        expect(e.offset + e.width, `${r.code} door at ${d.at}`).toBeLessThanOrEqual(1);
        expect(d.to, `${r.code} door at ${d.at}`).toBeGreaterThan(d.from);
      }
    }
  });

  it('counts what the drawing has: 16 single doors, 3 double, 13 leafless openings', () => {
    const doors = L.rooms.flatMap((r) => r.doors);
    const leafless = doors.filter((d) => d.hinge === 'none');
    const leaves = doors.filter((d) => d.hinge !== 'none');
    expect(leafless).toHaveLength(13);
    expect(leaves).toHaveLength(22);
    // A double door: two leaves on one wall, 1 pt apart.
    const doubles = L.rooms.flatMap((r) => r.doors.filter((a) => a.hinge === 'from'
      && r.doors.some((b) => b !== a && b.hinge === 'to' && b.axis === a.axis && b.at === a.at && Math.abs(b.from - a.to - 1) < 1e-9)));
    expect(doubles).toHaveLength(3);
    // Twelve of the leafless ones are sliding doors and have their bar; the thirteenth is binder preparation's open side.
    expect(L.annotations.equipment).toHaveLength(12);
    expect(room('CWH-I/015').doors).toEqual([{ axis: 'y', at: 449.5, from: 310.4, to: 350.9, hinge: 'none', kind: 'PASSAGE' }]);
  });

  it('each sliding door\'s bar lies on its opening', () => {
    const slides = L.rooms.flatMap((r) => r.doors.filter((d) => d.hinge === 'none' && r.code !== 'CWH-I/015'));
    for (const d of slides) {
      const bar = L.annotations.equipment!.find(([x0, y0, x1, y1]) => (d.axis === 'y'
        ? Math.abs((y0 + y1) / 2 - d.at) < 1e-9 && x0 === d.from && x1 === d.to
        : Math.abs((x0 + x1) / 2 - d.at) < 1e-9 && y0 === d.from && y1 === d.to));
      expect(bar, `${d.axis}=${d.at} ${d.from}..${d.to}`).toBeDefined();
    }
  });

  it('the one door that opens OUT of the building is the gents entry\'s exit, and the canvas has room for its leaf', () => {
    const out = L.rooms.flatMap((r) => r.doors.filter((d) => d.swing === 'out').map((d) => [r.code, d.at, d.kind]));
    expect(out).toEqual([['CWH-I/026', S, 'EXIT']]);
    expect(L.building.y1).toBeGreaterThan(S + 18 + 6);
  });

  it('a door between two rooms is on a wall they share', () => {
    const pairs: [string, string][] = [
      ['CWH-I/023', 'CWH-I/019'], ['CWH-I/019', 'CWH-I/022'], ['CWH-I/021', 'CWH-I/019'], ['CWH-I/055', 'CWH-I/020'],
      ['CWH-I/020', 'CWH-I/019'], ['CWH-I/020', 'CWH-I/014'], ['CWH-I/014', 'CWH-I/018'], ['CWH-I/017', 'CWH-I/014'],
      ['CWH-I/017', 'CWH-I/016'], ['CWH-I/015', 'CWH-I/014'], ['CWH-I/011', 'CWH-I/014'], ['CWH-I/011', 'CWH-I/010'],
      ['CWH-I/011', 'CWH-I/030'], ['CWH-I/011', 'CWH-I/012'], ['CWH-I/013', 'CWH-I/014'], ['CWH-I/054', 'CWH-I/024'],
      ['CWH-I/337', 'CWH-I/024'], ['CWH-I/010', 'CWH-I/025'], ['CWH-I/025', 'CWH-I/024'], ['CWH-I/026', 'CWH-I/025'],
      ['CWH-I/099', 'CWH-I/017 (3.5KL BLENDER)'], ['CWH-I/100', 'CWH-I/017 (3.5KL BLENDER)'],
    ];
    for (const [a, b] of pairs) {
      expect(sharedEdges(px(room(a)), px(room(b))).length, `${a} | ${b}`).toBeGreaterThan(0);
    }
    // The AIR LOCK has no door to the corridor under it: the wall between them is solid on the drawing.
    expect(room('CWH-I/016').doors.every((d) => d.at !== 379.7)).toBe(true);
    expect(room('CWH-I/011').doors.every((d) => d.at !== 379.7)).toBe(true);
  });

  it('every room passes the API\'s own room validation', () => {
    for (const r of L.rooms) {
      const points = archPoints(L.building, r);
      const payload = { code: r.code, label: r.label, ...roomGeometry({ x: 0, y: 0, w: 1, h: 1, points }), points, doors: r.doors.map((d) => edgeDoor(r, d)), grade: r.grade ?? null };
      const v = validateRoomPayload(payload);
      expect(v.ok, `${r.code}: ${v.ok ? '' : v.error}`).toBe(true);
    }
  });

  it('puts each of the eight instruments in the room its Location attribute names', () => {
    const placed = Object.fromEntries(L.rooms.filter((r) => r.instrument).map((r) => [r.instrument!, r.label]));
    expect(placed).toEqual({
      'CWH/RDU/029-00': 'EXCIPIENT DISPENSING',     // Excipient Dispensing Area
      'CWH/RDU/030-00': 'API DISPENSING',           // API Dispensing Area
      'CWH/RDU/031-00': 'BLENDER AREA',             // Blender Area — the 3.5KL blender room, not the BLENDING AREA
      'CWH/RDU/032-00': 'GRANULATION AREA',         // Granulation Area
      'CWH/RDU/059-00': 'API STAGING',              // API Staging Area
      'CWH/RDU/060-00': 'EXCIPIENT STAGING',        // Excipient Staging Area
      'CWH/RDU/061-00': 'SIFTING ROOM',             // Shifter Area
      'CWH/RDU/090-00': 'AIR LOCK-02',              // Air Lock-02
    });
    expect(room('CWH-I/017 (3.5KL BLENDER)').instrument).toBe('CWH/RDU/031-00');
    expect(room('CWH-I/017').instrument).toBeUndefined();
  });

  it('the structure is inside the canvas: 17 columns, 7 windows, 4 stubs', () => {
    const a = archAnnotations(L.building, L.annotations);
    expect(a.columns).toHaveLength(17);
    expect(a.windows).toHaveLength(7);
    expect(a.walls).toHaveLength(4);
    for (const b of [...a.columns, ...a.windows, ...a.equipment]) {
      expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.w).toBeLessThanOrEqual(1);
      expect(b.y).toBeGreaterThanOrEqual(0); expect(b.y + b.h).toBeLessThanOrEqual(1);
      expect(b.w).toBeGreaterThan(0); expect(b.h).toBeGreaterThan(0);
    }
    expect(a.labels).toEqual([{ x: expect.any(Number), y: expect.any(Number), text: 'RETURN DUCT CUTOUT' }]);
  });

  it('a void that reaches an outer wall, or has no room on one side, has a stub to close it', () => {
    const has = (x1: number, y1: number, x2: number, y2: number) =>
      L.annotations.walls.some((w) => w[0] === x1 && w[1] === y1 && w[2] === x2 && w[3] === y2);
    expect(has(497.4, N, 506.5, N)).toBe(true);
    expect(has(363.9, 399.9, 389.9, 399.9)).toBe(true);
    expect(has(W, 399.9, W, 418.2)).toBe(true);
    expect(has(290.7, S, 730.9, S)).toBe(true);
  });

  it('the canvas is the module with its margin, in the page\'s points', () => {
    expect(archCanvas(L.building)).toEqual({ width: 882, height: 368 });
    expect(L.source).toBe('Layouts/CWH/Module-E layout.pdf');
  });
});
