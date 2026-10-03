import { describe, it, expect } from 'vitest';
import { polygonArea, pointInPolygon, validatePolygon, sharedEdges } from '@digilog/shared';
import {
  MODULE_F_GROUND_TRACE as G, MODULE_F_FIRST_TRACE as F, MODULE_F_GROUP,
  MODULE_F_GROUND_LAYOUT, MODULE_F_FIRST_LAYOUT, MODULE_F_GROUND_ENLARGE, MODULE_F_FIRST_ENLARGE,
} from '../module-f-layout.js';
import {
  archPoints, archAnnotations, archCanvas, edgeDoor, axisMap, enlargeLayout,
  type ArchLayout, type ArchRoom, type EnlargeSpec,
} from '../architectural-layout.js';
import { validateRoomPayload, roomGeometry } from '../validation.js';

/**
 * Module-F's two floors, traced from `Layouts/CWH/Mod-F Ground floor.pdf` and
 * `Mod-F First floor.pdf` (2026-10-01, operator: "for module F there are 2
 * layouts ground floor and first floor, we need to show as 2 seperate layouts").
 * The discipline a hand-authored table needs, tested on BOTH: rooms valid, no
 * overlap, the module covered except for the voids the drawing has, every
 * corner on a wall line read from the PDF, every door on its own room's wall,
 * every symbol inside the canvas, every instrument in the room its `Location`
 * attribute names.
 */
type Box = [number, number, number, number];
const px = (r: ArchRoom) => r.outline.map(([x, y]) => ({ x, y }));
const roomOf = (L: ArchLayout) => (code: string) => L.rooms.find((r) => r.code === code)!;

interface Floor {
  name: string;
  /** As measured. */
  L: ArchLayout;
  /** As drawn, and where it is drawn larger. */
  drawn: ArchLayout;
  enlarge: EnlargeSpec;
  drawnCanvas: { width: number; height: number };
  rooms: number;
  /** The wall lines, in PDF points: each the midpoint of a pair of lines read from the file. */
  xs: number[]; ys: number[];
  /** The module the rooms tile, and the annex rooms west of it (which need not reach its south wall). */
  module: Box;
  annex: string[];
  /** What the drawing leaves outside every room, inside the module. */
  voids: Box[];
  leafless: number; leaves: number; doubles: number;
  /** Leafless openings that are an open side or an open bay, not a sliding / lift door: no bar. */
  open: [string, number][];
  columns: number; windows: number; stubs: number; equipment: number;
  canvas: { width: number; height: number };
  source: string;
  label: string; order: number;
}

const FLOORS: Floor[] = [
  {
    name: 'ground floor', L: G, drawn: MODULE_F_GROUND_LAYOUT, enlarge: MODULE_F_GROUND_ENLARGE, drawnCanvas: { width: 1028, height: 475 }, rooms: 28,
    xs: [64, 132.5, 179.8, 217.7, 246.3, 328.7, 341.3, 449, 543.3, 706.9, 711.2, 777.4, 779.4, 836.3, 875.7, 905.6, 932.7, 935.4, 952.1, 985.5],
    ys: [321.8, 369.5, 385.7, 389.4, 409.4, 415.4, 467, 470, 523.1, 524.5, 532.6, 544.6, 569.6, 591.6, 607.5],
    module: [132.5, 321.8, 985.5, 607.5],
    annex: ['STAIRCASE-A', 'LIFT LOBBY', 'MAT. LIFT-02', 'MAT. LIFT-01'],
    voids: [[328.7, 591.6, 706.9, 607.5]],                            // behind the granulation area's south wall
    leafless: 17, leaves: 22, doubles: 4,
    open: [['STAIRCASE-A', 409.4], ['LIFT LOBBY', 132.5], ['CWH-I/044', 369.5], ['STAIRCASE-B', 341.3]],
    columns: 15, windows: 2, stubs: 1, equipment: 13,
    canvas: { width: 960, height: 332 },
    source: 'Layouts/CWH/Mod-F Ground floor.pdf',
    label: 'Ground Floor', order: 0,
  },
  {
    name: 'first floor', L: F, drawn: MODULE_F_FIRST_LAYOUT, enlarge: MODULE_F_FIRST_ENLARGE, drawnCanvas: { width: 996, height: 452 }, rooms: 21,
    xs: [96.3, 161.5, 207.7, 267.7, 272.7, 352.7, 361.5, 404, 431.2, 508.8, 581.9, 670.3, 718.5, 790.7, 832.9, 911.3, 993.7],
    ys: [238.3, 277, 297.4, 304.6, 316, 328.3, 362.2, 376.7, 379.5, 408.7, 440.2, 459.1, 474.7, 501.2, 504.2, 517.3],
    module: [161.5, 238.3, 993.7, 517.3],
    annex: ['STAIRCASE-A', 'LIFT LOBBY', 'MAT. LIFT-02', 'MAT. LIFT-01'],
    voids: [[404, 238.3, 431.2, 297.4], [352.7, 501.2, 718.5, 517.3]], // the duct opening shaft; behind the granulation area's south wall
    leafless: 14, leaves: 17, doubles: 6,
    open: [['STAIRCASE-A', 328.3], ['LIFT LOBBY', 161.5], ['STAIRCASE-B', 361.5], ['CWH-I/040', 297.4]],
    columns: 15, windows: 8, stubs: 2, equipment: 13,
    canvas: { width: 922, height: 312 },
    source: 'Layouts/CWH/Mod-F First floor.pdf',
    label: 'First Floor', order: 1,
  },
];

describe.each(FLOORS)('Module-F trace — $name', (f) => {
  const { L } = f;
  const room = roomOf(L);
  const [MW, MN, ME, MS] = f.module;
  const inVoid = (x: number, y: number) => f.voids.some(([x0, y0, x1, y1]) => x > x0 && x < x1 && y > y0 && y < y1);
  const voidArea = f.voids.reduce((n, [x0, y0, x1, y1]) => n + (x1 - x0) * (y1 - y0), 0);
  const moduleRooms = L.rooms.filter((r) => !f.annex.includes(r.code));

  it('is one FLOOR of the Module-F building, drawn in the 2D style, with north to the right', () => {
    expect(L.area).toBe('Module-F');
    expect(L.planName).toBe(`${MODULE_F_GROUP} — ${f.label}`);
    expect(L.source).toBe(f.source);
    const a = archAnnotations(L.building, L.annotations, { floor: L.floor, north: L.north });
    expect(a.style).toBe('architectural');
    expect(a.floor).toEqual({ group: 'CWH — Module-F', label: f.label, order: f.order });
    expect(a.north).toBe(90);
  });

  it('gives every room a unique code', () => {
    const codes = L.rooms.map((r) => r.code);
    expect(codes).toHaveLength(f.rooms);
    expect(new Set(codes.map((c) => c.toUpperCase())).size).toBe(codes.length);
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
    const XS = new Set(f.xs), YS = new Set(f.ys);
    for (const r of L.rooms) {
      for (const [x, y] of r.outline) {
        expect(XS.has(x), `${r.code} x ${x} off-grid`).toBe(true);
        expect(YS.has(y), `${r.code} y ${y} off-grid`).toBe(true);
      }
    }
  });

  it('the rooms and the drawing\'s voids TILE the module: every point in exactly one room or in a void, never both', () => {
    const total = moduleRooms.reduce((n, r) => n + polygonArea(px(r)), 0);
    expect(total + voidArea).toBeCloseTo((ME - MW) * (MS - MN), 3);
    for (let y = MN + 2.3; y < MS; y += 6) {
      for (let x = MW + 2.3; x < ME; x += 6) {
        const inside = L.rooms.filter((r) => pointInPolygon({ x, y }, px(r)));
        expect(inside.length, `(${x},${y}) in ${inside.map((r) => r.code).join(', ') || 'nothing'}`).toBe(inVoid(x, y) ? 0 : 1);
      }
    }
  });

  it('the annex is four rooms in one column west of the module, none overlapping', () => {
    const annex = f.annex.map(room);
    for (const r of annex) for (const [x] of r.outline) expect(x).toBeLessThanOrEqual(MW);
    for (let i = 0; i < annex.length; i++) {
      for (let j = i + 1; j < annex.length; j++) {
        const a = annex[i].outline, b = annex[j].outline;
        const overlapY = Math.min(a[2][1], b[2][1]) - Math.max(a[0][1], b[0][1]);
        expect(overlapY, `${annex[i].code} | ${annex[j].code}`).toBeLessThanOrEqual(0);
      }
    }
    // Each is on the module's west wall, so the view joins nothing and gaps nothing.
    for (const r of annex) expect(r.outline.some(([x]) => x === MW), r.code).toBe(true);
  });

  it('a door is on a wall of the room it is stored on', () => {
    for (const r of L.rooms) {
      for (const d of r.doors) {
        const e = edgeDoor(r, d);                                    // throws when no edge carries it
        expect(e.offset, `${r.code} door at ${d.at}`).toBeGreaterThanOrEqual(0);
        expect(e.offset + e.width, `${r.code} door at ${d.at}`).toBeLessThanOrEqual(1 + 1e-6);
        expect(d.to, `${r.code} door at ${d.at}`).toBeGreaterThan(d.from);
      }
    }
  });

  it('counts what the drawing has: leaves, double doors, leafless openings', () => {
    const doors = L.rooms.flatMap((r) => r.doors);
    expect(doors.filter((d) => d.hinge === 'none')).toHaveLength(f.leafless);
    expect(doors.filter((d) => d.hinge !== 'none')).toHaveLength(f.leaves);
    // A double door: two leaves on one wall, 1 pt apart.
    const doubles = L.rooms.flatMap((r) => r.doors.filter((a) => a.hinge === 'from'
      && r.doors.some((b) => b !== a && b.hinge === 'to' && b.axis === a.axis && b.at === a.at && Math.abs(b.from - a.to - 1) < 1e-9)));
    expect(doubles).toHaveLength(f.doubles);
  });

  it('every sliding or lift door has its bar on the opening; an open side has none', () => {
    const isOpen = (code: string, at: number) => f.open.some(([c, a]) => c === code && a === at);
    const bars = L.annotations.equipment ?? [];
    let slides = 0;
    for (const r of L.rooms) {
      for (const d of r.doors.filter((x) => x.hinge === 'none')) {
        const bar = bars.find(([x0, y0, x1, y1]) => (d.axis === 'y'
          ? Math.abs((y0 + y1) / 2 - d.at) < 1e-9 && x0 === d.from && x1 === d.to
          : Math.abs((x0 + x1) / 2 - d.at) < 1e-9 && y0 === d.from && y1 === d.to));
        if (isOpen(r.code, d.at)) { expect(bar, `${r.code} ${d.axis}=${d.at}: an open side has no bar`).toBeUndefined(); continue; }
        slides += 1;
        expect(bar, `${r.code} ${d.axis}=${d.at} ${d.from}..${d.to}`).toBeDefined();
      }
    }
    expect(slides).toBe(f.leafless - f.open.length);
  });

  it('every room passes the API\'s own room validation', () => {
    for (const r of L.rooms) {
      const points = archPoints(L.building, r);
      const payload = { code: r.code, label: r.label, ...roomGeometry({ x: 0, y: 0, w: 1, h: 1, points }), points, doors: r.doors.map((d) => edgeDoor(r, d)), grade: r.grade ?? null };
      const v = validateRoomPayload(payload);
      expect(v.ok, `${r.code}: ${v.ok ? '' : v.error}`).toBe(true);
    }
  });

  it('the structure is inside the canvas', () => {
    const a = archAnnotations(L.building, L.annotations);
    expect(a.columns).toHaveLength(f.columns);
    expect(a.windows).toHaveLength(f.windows);
    expect(a.walls).toHaveLength(f.stubs);
    expect(a.equipment).toHaveLength(f.equipment);
    for (const b of [...a.columns, ...a.windows, ...a.equipment]) {
      expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.w).toBeLessThanOrEqual(1);
      expect(b.y).toBeGreaterThanOrEqual(0); expect(b.y + b.h).toBeLessThanOrEqual(1);
      expect(b.w).toBeGreaterThan(0); expect(b.h).toBeGreaterThan(0);
    }
    // A plan with no floor and no north stores exactly what it always did.
    expect(a).not.toHaveProperty('floor');
    expect(a).not.toHaveProperty('north');
  });

  it('a void has a stub on the outer wall to close it', () => {
    for (const [x0, y0, x1, y1] of f.voids) {
      const y = y0 === MN ? MN : y1;                                 // the side that is the module's own wall
      expect(L.annotations.walls.some((w) => w[0] === x0 && w[1] === y && w[2] === x1 && w[3] === y), `${x0}..${x1} @ ${y}`).toBe(true);
    }
  });

  it('the canvas is the building with its margin, in the page\'s points', () => {
    expect(archCanvas(L.building)).toEqual(f.canvas);
    const xs = L.rooms.flatMap((r) => r.outline.map(([x]) => x)), ys = L.rooms.flatMap((r) => r.outline.map(([, y]) => y));
    expect(Math.min(...xs) - L.building.x0).toBeGreaterThanOrEqual(10);
    expect(L.building.x1 - Math.max(...xs)).toBeGreaterThanOrEqual(10);
    expect(Math.min(...ys) - L.building.y0).toBeGreaterThanOrEqual(10);
    expect(L.building.y1 - Math.max(...ys)).toBeGreaterThanOrEqual(10);
  });
});

/**
 * AS DRAWN: both floors are drawn larger than measured (taller overall, the
 * narrow instrument columns wider — see the trace's header). The enlargement
 * must leave a floor that is still the drawing: the same rooms on the same
 * walls, still tiling, every door still a door of its own width.
 */
describe.each(FLOORS)('Module-F as drawn — $name', (f) => {
  const { L, drawn: D } = f;
  const fx = axisMap(f.enlarge.x), fy = axisMap(f.enlarge.y);
  const [MW, MN, ME, MS] = [fx(f.module[0]), fy(f.module[1]), fx(f.module[2]), fy(f.module[3])];
  const voids = f.voids.map(([x0, y0, x1, y1]) => [fx(x0), fy(y0), fx(x1), fy(y1)] as Box);
  const inVoid = (x: number, y: number) => voids.some(([x0, y0, x1, y1]) => x > x0 && x < x1 && y > y0 && y < y1);
  const isOpen = (code: string, at: number) => f.open.some(([c, a]) => c === code && a === at);

  it('is the measured floor passed through the enlargement, and nothing else', () => {
    expect(D).toEqual(enlargeLayout(L, f.enlarge));
    expect(D.planName).toBe(L.planName);
    expect(D.rooms.map((r) => [r.code, r.label, r.instrument, r.grade])).toEqual(L.rooms.map((r) => [r.code, r.label, r.instrument, r.grade]));
    expect(archCanvas(D.building)).toEqual(f.drawnCanvas);
    // The plan stores its canvas as integers.
    expect(Number.isInteger(f.drawnCanvas.width) && Number.isInteger(f.drawnCanvas.height)).toBe(true);
  });

  it('is LARGER where it says, and only there: every corner is its measured corner moved by the two axis maps', () => {
    for (const [i, r] of L.rooms.entries()) {
      expect(D.rooms[i].outline).toEqual(r.outline.map(([x, y]) => [fx(x), fy(y)]));
    }
    // West of the first widened column and north of the module nothing moves.
    expect(fx(f.module[0])).toBe(f.module[0]);
    expect(fy(f.module[1])).toBe(f.module[1]);
    // The whole floor is half as tall again.
    expect((MS - MN) / (f.module[3] - f.module[1])).toBeCloseTo(1.5, 2);
  });

  it('still TILES: every point in exactly one room or in a void', () => {
    const rooms = D.rooms.filter((r) => !f.annex.includes(r.code));
    const total = rooms.reduce((n, r) => n + polygonArea(px(r)), 0);
    const voidArea = voids.reduce((n, [x0, y0, x1, y1]) => n + (x1 - x0) * (y1 - y0), 0);
    expect(total + voidArea).toBeCloseTo((ME - MW) * (MS - MN), 3);
    for (let y = MN + 2.3; y < MS; y += 7) {
      for (let x = MW + 2.3; x < ME; x += 7) {
        const inside = D.rooms.filter((r) => pointInPolygon({ x, y }, px(r)));
        expect(inside.length, `(${x},${y}) in ${inside.map((r) => r.code).join(', ') || 'nothing'}`).toBe(inVoid(x, y) ? 0 : 1);
      }
    }
  });

  it('a hinged door keeps its width and stays on its wall; an opening with no leaf stretches with the wall', () => {
    for (const [i, r] of L.rooms.entries()) {
      for (const [j, d] of r.doors.entries()) {
        const e = D.rooms[i].doors[j];
        expect(() => edgeDoor(D.rooms[i], e), `${r.code} door ${j}`).not.toThrow();
        if (d.hinge === 'none') {
          const along = d.axis === 'x' ? fy : fx;
          expect([e.from, e.to]).toEqual([along(d.from), along(d.to)]);
        } else {
          expect(e.to - e.from, `${r.code} door ${j}`).toBeCloseTo(d.to - d.from, 9);
        }
        expect([e.hinge, e.kind, e.swing, e.axis]).toEqual([d.hinge, d.kind, d.swing, d.axis]);
      }
    }
  });

  it('the two leaves of a double door are still 1 pt apart', () => {
    const doubles = D.rooms.flatMap((r) => r.doors.filter((a) => a.hinge === 'from'
      && r.doors.some((b) => b !== a && b.hinge === 'to' && b.axis === a.axis && b.at === a.at && Math.abs(b.from - a.to - 1) < 1e-9)));
    expect(doubles).toHaveLength(f.doubles);
  });

  it('every room still passes the room validation of the API, inside the larger canvas', () => {
    for (const r of D.rooms) {
      const points = archPoints(D.building, r);
      for (const p of points) {
        expect(p.x, r.code).toBeGreaterThan(0); expect(p.x, r.code).toBeLessThan(1);
        expect(p.y, r.code).toBeGreaterThan(0); expect(p.y, r.code).toBeLessThan(1);
      }
      const payload = { code: r.code, label: r.label, ...roomGeometry({ x: 0, y: 0, w: 1, h: 1, points }), points, doors: r.doors.map((d) => edgeDoor(r, d)), grade: r.grade ?? null };
      const v = validateRoomPayload(payload);
      expect(v.ok, `${r.code}: ${v.ok ? '' : v.error}`).toBe(true);
    }
  });

  it('a column keeps its size and the corner columns stay on the corners', () => {
    for (const [i, [x0, y0, x1, y1]] of L.annotations.columns.entries()) {
      const [a0, b0, a1, b1] = D.annotations.columns[i];
      expect(a1 - a0).toBeCloseTo(x1 - x0, 9);
      expect(b1 - b0).toBeCloseTo(y1 - y0, 9);
    }
    // A column on the south wall as measured is on the south wall as drawn.
    const south = (X: ArchLayout, s: number) => X.annotations.columns.filter(([, y0, , y1]) => y0 < s && y1 > s - 6).length;
    expect(south(L, f.module[3])).toBe(5);
    expect(south(D, MS)).toBe(5);
  });

  it('a sliding door keeps its bar on the opening, at the bar thickness it had', () => {
    const bars = D.annotations.equipment ?? [];
    let n = 0;
    for (const [i, r] of L.rooms.entries()) {
      for (const [j, d] of r.doors.entries()) {
        if (d.hinge !== 'none' || isOpen(r.code, d.at)) continue;
        const e = D.rooms[i].doors[j];
        const bar = bars.find(([bx0, by0, bx1, by1]) => (e.axis === 'y'
          ? Math.abs((by0 + by1) / 2 - e.at) < 1e-9 && bx0 === e.from && bx1 === e.to && Math.abs(by1 - by0 - 3) < 1e-9
          : Math.abs((bx0 + bx1) / 2 - e.at) < 1e-9 && by0 === e.from && by1 === e.to && Math.abs(bx1 - bx0 - 3) < 1e-9));
        expect(bar, `${r.code} ${e.axis}=${e.at} ${e.from}..${e.to}`).toBeDefined();
        n += 1;
      }
    }
    expect(n).toBe(f.leafless - f.open.length);
  });

  it('everything drawn is inside the canvas', () => {
    const a = archAnnotations(D.building, D.annotations);
    for (const b of [...a.columns, ...a.windows, ...a.equipment]) {
      expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.w).toBeLessThanOrEqual(1);
      expect(b.y).toBeGreaterThanOrEqual(0); expect(b.y + b.h).toBeLessThanOrEqual(1);
    }
    for (const w of a.walls) for (const v of [w.x1, w.y1, w.x2, w.y2]) { expect(v).toBeGreaterThan(0); expect(v).toBeLessThan(1); }
  });
});

describe('enlargeLayout', () => {
  it('with no bands returns the trace unchanged', () => {
    expect(enlargeLayout(G, {})).toEqual(G);
  });

  it('axisMap spreads a band evenly and moves everything past it along', () => {
    const f = axisMap([{ from: 10, to: 20, add: 5 }]);
    expect([f(0), f(10), f(15), f(20), f(50)]).toEqual([0, 10, 17.5, 25, 55]);
  });
});

describe('Module-F — the ground floor', () => {
  const room = roomOf(G);

  it('RENAMES the plan the area had before it had two floors; the first floor is a new plan', () => {
    expect(G.renamesPlan).toBe('CWH — Module-F');
    expect(F.renamesPlan).toBeUndefined();
  });

  it('the GRANULATION AREA is one room that takes in the bay between the blender rooms and the corridor', () => {
    const g = px(room('CWH-I/031'));
    expect(pointInPolygon({ x: 400, y: 350 }, g)).toBe(true);        // under its label
    expect(pointInPolygon({ x: 620, y: 530 }, g)).toBe(true);        // the `6330 x 8650` bay
    expect(pointInPolygon({ x: 335, y: 420 }, g)).toBe(true);        // the strip beside the wash area
    expect(pointInPolygon({ x: 500, y: 380 }, g)).toBe(false);       // binder preparation
    expect(pointInPolygon({ x: 500, y: 600 }, g)).toBe(false);       // the cavity behind its south wall
  });

  it('the two corridors are each ONE outline round a corner', () => {
    expect(room('CWH-I/352').outline).toHaveLength(6);
    expect(room('CWH-I/028').outline).toHaveLength(6);
    expect(pointInPolygon({ x: 215, y: 560 }, px(room('CWH-I/352')))).toBe(true);    // under the entry rooms
    expect(pointInPolygon({ x: 960, y: 420 }, px(room('CWH-I/028')))).toBe(true);    // the leg up to the change room
  });

  it('the two doors that open OUT of the building are the change rooms\' on the east wall, and the canvas has room for their leaves', () => {
    const out = G.rooms.flatMap((r) => r.doors.filter((d) => d.swing === 'out').map((d) => [r.code, d.at]));
    expect(out).toEqual([['CWH-I/004', 985.5], ['CWH-I/003', 985.5]]);
    expect(G.building.x1).toBeGreaterThan(985.5 + 18 + 6);
    expect(F.rooms.flatMap((r) => r.doors.filter((d) => d.swing === 'out'))).toEqual([]);
  });

  it('a door between two rooms is on a wall they share', () => {
    const pairs: [string, string][] = [
      ['STAIRCASE-A', 'LIFT LOBBY'], ['LIFT LOBBY', 'CWH-I/352'], ['MAT. LIFT-02', 'CWH-I/352'], ['MAT. LIFT-01', 'CWH-I/352'],
      ['CWH-I/044', 'CWH-I/350'], ['CWH-I/351', 'CWH-I/350'], ['CWH-I/351', 'CWH-I/352'], ['CWH-I/349', 'CWH-I/350'], ['CWH-I/349', 'CWH-I/352'],
      ['STAIRCASE-B', 'CWH-I/031'], ['CWH-I/034', 'CWH-I/031'], ['CWH-I/033', 'CWH-I/031'], ['CWH-I/032', 'CWH-I/352'], ['CWH-I/032', 'CWH-I/031'],
      ['CWH-I/031', 'CWH-I/035'], ['CWH-I/036', 'CWH-I/031'], ['CWH-I/036', 'CWH-I/037'], ['CWH-I/037', 'CWH-I/028'], ['CWH-I/037', 'CWH-I/038'],
      ['CWH-I/038', 'CWH-I/028'], ['CWH-I/028', 'CWH-I/027'], ['CWH-I/028', 'CWH-I/031'], ['CWH-I/028', 'CWH-I/030'], ['CWH-I/028', 'CWH-I/356'],
      ['CWH-I/028', 'CWH-I/355'], ['CWH-I/029', 'CWH-I/028'], ['CWH-I/356', 'CWH-I/354'], ['CWH-I/355', 'CWH-I/004'], ['CWH-I/353', 'CWH-I/354'],
      ['CWH-I/003', 'CWH-I/353'],
    ];
    for (const [a, b] of pairs) expect(sharedEdges(px(room(a)), px(room(b))).length, `${a} | ${b}`).toBeGreaterThan(0);
  });

  it('puts each of its six instruments in the room its Location attribute names', () => {
    const placed = Object.fromEntries(G.rooms.filter((r) => r.instrument).map((r) => [r.instrument!, r.label]));
    expect(placed).toEqual({
      'CWH/RDU/038-00': 'BINDER PREPARATION',       // Binder preparation Area
      'CWH/RDU/039-00': 'GRANULATION AREA(GF)',     // Granulation Area(Near Office Room)
      'CWH/RDU/040-00': 'BLENDER AREA-01',          // Blender Area-01
      'CWH/RDU/042-00': 'HOLD AREA-01',             // Hold Area-01
      'CWH/RDU/044-00': 'BLENDER AREA-02',          // Blender Area-02
      'CWH/RDU/071-00': 'BLENDER AREA',             // 1.6KL Blender — by judgement
    });
  });
});

describe('Module-F — the first floor', () => {
  const room = roomOf(F);

  it('the GRANULATION AREA is one room round the staircase, the duct shaft and the charging rooms', () => {
    const g = px(room('CWH-I/031'));
    expect(room('CWH-I/031').outline).toHaveLength(10);
    expect(pointInPolygon({ x: 380, y: 260 }, g)).toBe(true);        // north of the shaft, beside the staircase
    expect(pointInPolygon({ x: 470, y: 390 }, g)).toBe(true);        // the RMG platform
    expect(pointInPolygon({ x: 700, y: 430 }, g)).toBe(true);        // the east end, under CORRIDOR-3
    expect(pointInPolygon({ x: 417, y: 270 }, g)).toBe(false);       // the duct opening shaft
    expect(pointInPolygon({ x: 620, y: 300 }, g)).toBe(false);       // blender charging area-01
  });

  it('the two TECHNICAL AREAS the drawing labels are one space, round the change-parts room', () => {
    const t = px(room('TECHNICAL AREA'));
    expect(pointInPolygon({ x: 950, y: 300 }, t)).toBe(true);        // the east strip
    expect(pointInPolygon({ x: 750, y: 440 }, t)).toBe(true);        // west of the change-parts room
    expect(pointInPolygon({ x: 850, y: 500 }, t)).toBe(true);        // south of it
    expect(pointInPolygon({ x: 850, y: 420 }, t)).toBe(false);       // the change-parts room itself
  });

  it('API DISPENSING has the 5 pt notch beside the wash area', () => {
    expect(room('CWH-I/041').outline).toEqual([[272.7, 277], [352.7, 277], [352.7, 408.7], [267.7, 408.7], [267.7, 304.6], [272.7, 304.6]]);
  });

  it('a door between two rooms is on a wall they share', () => {
    const pairs: [string, string][] = [
      ['STAIRCASE-A', 'LIFT LOBBY'], ['LIFT LOBBY', 'CWH-I/357'], ['MAT. LIFT-02', 'CWH-I/357'], ['MAT. LIFT-01', 'CWH-I/357'],
      ['CWH-I/051', 'CWH-I/043'], ['CWH-I/051', 'CWH-I/357'], ['CWH-I/051', 'CWH-I/041'], ['CWH-I/053', 'CWH-I/357'], ['CWH-I/053', 'CWH-I/041'],
      ['CWH-I/053', 'CWH-I/042'], ['CWH-I/052', 'CWH-I/357'], ['CWH-I/052', 'CWH-I/042'], ['CWH-I/041', 'CWH-I/031'], ['CWH-I/042', 'CWH-I/031'],
      ['STAIRCASE-B', 'CWH-I/031'], ['CWH-I/031', 'CWH-I/039'], ['CWH-I/031', 'CWH-I/046'], ['CWH-I/040', 'CWH-I/031'], ['CWH-I/044', 'CWH-I/045'],
      ['CWH-I/045', 'CWH-I/031'], ['CWH-I/045', 'CWH-I/048'], ['CWH-I/045', 'CWH-I/047'], ['TECHNICAL AREA', 'CWH-I/048'],
    ];
    for (const [a, b] of pairs) expect(sharedEdges(px(room(a)), px(room(b))).length, `${a} | ${b}`).toBeGreaterThan(0);
  });

  it('puts each of its ten instruments in the room its Location attribute names', () => {
    const placed = Object.fromEntries(F.rooms.filter((r) => r.instrument).map((r) => [r.instrument!, r.label]));
    expect(placed).toEqual({
      'CWH/RDU/033-00': 'API DISPENSING',               // API Dispensing Booth Area
      'CWH/RDU/034-00': 'EXCIPIENT DISPENSING',         // Excipient Dispensing Booth Area
      'CWH/RDU/035-00': 'SIFTING / HOLDING AREA',       // Sifting Holding Area
      'CWH/RDU/036-00': 'BINDER CHARGING AREA',         // Binder Charging Area
      'CWH/RDU/037-00': 'GRANULATION AREA',             // Charging Area( Near RMG & FBP Area) — by judgement
      'CWH/RDU/041-00': 'BLENDER CHARGING AREA-01',     // Blender Charging Area-01
      'CWH/RDU/043-00': 'BLENDER CHARGING AREA-02',     // Blender Charging Area-02
      'CWH/RDU/056-00': 'API STAGING',                  // API Dispensing Material Entry Area — by judgement
      'CWH/RDU/057-00': 'EXCIPIENT STAGING',            // Excipient Dispensing Material Entry Area — by judgement
      'CWH/RDU/058-00': 'MATERIAL STAGING AREA-01',     // Staging Area (Near lift 1st Floor) — by judgement
    });
  });

  it('as drawn, a door beside a corner stays beside that corner: API STAGING’s door is 4.9 pt from its east wall on both', () => {
    const fx = axisMap(MODULE_F_FIRST_ENLARGE.x);
    const measured = room('CWH-I/051').doors.find((d) => d.axis === 'y')!;
    const drawn = MODULE_F_FIRST_LAYOUT.rooms.find((r) => r.code === 'CWH-I/051')!.doors.find((d) => d.axis === 'y')!;
    expect(267.7 - measured.to).toBeCloseTo(4.9, 6);
    expect(fx(267.7) - drawn.to).toBeCloseTo(4.9, 6);
    expect(fx(267.7)).toBeGreaterThan(267.7 + 50);                 // the column IS widened, so centring would have moved it
  });

  it('the outlined plant is the two hoppers and the RMG platform, captioned as the drawing has it', () => {
    const a = archAnnotations(F.building, F.annotations);
    expect(a.labels).toEqual([{ x: expect.any(Number), y: expect.any(Number), text: 'RMG AREA @4MTR LVL' }]);
    expect(archAnnotations(G.building, G.annotations).labels).toEqual([]);
  });
});

describe('Module-F — the two floors together', () => {
  it('no instrument is on both, and 072-00 (the 3.5KL blender, which neither drawing has a room for) is on neither', () => {
    const g = G.rooms.flatMap((r) => (r.instrument ? [r.instrument] : []));
    const f = F.rooms.flatMap((r) => (r.instrument ? [r.instrument] : []));
    expect(g.filter((c) => f.includes(c))).toEqual([]);
    expect([...g, ...f]).toHaveLength(16);
    expect([...g, ...f]).not.toContain('CWH/RDU/072-00');
  });

  it('the floors sort ground first and carry different plan names', () => {
    expect(G.floor!.order).toBeLessThan(F.floor!.order);
    expect(G.floor!.group).toBe(F.floor!.group);
    expect(G.planName).not.toBe(F.planName);
  });
});
