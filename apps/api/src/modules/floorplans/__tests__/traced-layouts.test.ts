/**
 * The QC 3 floor is a hand-traced table of RECTANGLES, and a hand-traced
 * table can be WRONG in ways a generated plan cannot: a mistyped digit puts
 * two rooms on top of each other or opens a seam, and both look fine in the
 * table. The operator holds the browser session, so these assertions are the
 * check — the same set `qc-layout.test.ts` runs for the QC floor.
 *
 * The Microbiology floor was a second case here until 2026-10-01, when it was
 * re-traced as polygons in the 2D style; its checks are
 * `microbiology-layout.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { QC3_LAYOUT } from '../qc3-layout.js';
import { normRect, canvasOf, type TracedLayout } from '../traced-layout.js';

const rect = (px: [number, number, number, number]) => ({ x0: px[0], y0: px[1], x1: px[2], y1: px[3] });

const CASES: { layout: TracedLayout; xs: number[]; ys: number[]; instruments: Record<string, string> }[] = [
  {
    layout: QC3_LAYOUT,
    xs: [22, 192, 238, 250, 312, 338, 387, 450, 462, 506, 640, 695, 775, 846],
    ys: [6, 54, 74, 120, 131, 134, 178, 211, 282, 336, 375, 438, 482, 494, 511, 531, 594, 663, 709, 786],
    // The right-hand column is each instrument's Location attribute, which is
    // what the mapping is FROM.
    instruments: {
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
    },
  },
];

describe.each(CASES)('traced floor $layout.area', ({ layout, xs, ys, instruments }) => {
  const rooms = layout.rooms;
  const b = layout.building;

  it('gives every room a unique code within the column width', () => {
    const codes = rooms.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c.length).toBeLessThanOrEqual(60);
  });

  it('draws every rectangle with positive area inside the building', () => {
    for (const r of rooms) {
      const x = rect(r.px);
      expect(x.x1, `${r.code} width`).toBeGreaterThan(x.x0);
      expect(x.y1, `${r.code} height`).toBeGreaterThan(x.y0);
      expect(x.x0, `${r.code} left`).toBeGreaterThanOrEqual(b.x0);
      expect(x.y0, `${r.code} top`).toBeGreaterThanOrEqual(b.y0);
      expect(x.x1, `${r.code} right`).toBeLessThanOrEqual(b.x1);
      expect(x.y1, `${r.code} bottom`).toBeLessThanOrEqual(b.y1);
    }
  });

  it('never overlaps two rooms', () => {
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const a = rect(rooms[i].px), c = rect(rooms[j].px);
        const ox = Math.min(a.x1, c.x1) - Math.max(a.x0, c.x0);
        const oy = Math.min(a.y1, c.y1) - Math.max(a.y0, c.y0);
        expect(Math.max(0, ox) * Math.max(0, oy), `${rooms[i].code} overlaps ${rooms[j].code}`).toBe(0);
      }
    }
  });

  it('takes every edge from the canonical wall grid', () => {
    const XS = new Set(xs), YS = new Set(ys);
    for (const r of rooms) {
      const x = rect(r.px);
      expect(XS.has(x.x0), `${r.code} left ${x.x0} off-grid`).toBe(true);
      expect(XS.has(x.x1), `${r.code} right ${x.x1} off-grid`).toBe(true);
      expect(YS.has(x.y0), `${r.code} top ${x.y0} off-grid`).toBe(true);
      expect(YS.has(x.y1), `${r.code} bottom ${x.y1} off-grid`).toBe(true);
    }
  });

  it('tessellates the building exactly — no void, no double cover', () => {
    // With no overlaps (above), total area == building area means no hole.
    const total = rooms.reduce((n, r) => { const x = rect(r.px); return n + (x.x1 - x.x0) * (x.y1 - x.y0); }, 0);
    const { width, height } = canvasOf(b);
    expect(total).toBe(width * height);
  });

  it('normalizes into the unit square', () => {
    for (const r of rooms) {
      const n = normRect(b, r.px);
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x + n.w).toBeLessThanOrEqual(1 + 1e-12);
      expect(n.y + n.h).toBeLessThanOrEqual(1 + 1e-12);
    }
  });

  it('keeps every door on its own wall', () => {
    for (const r of rooms) {
      for (const d of r.doors ?? []) {
        expect(d.offset, `${r.code} door offset`).toBeGreaterThanOrEqual(0);
        expect(d.width, `${r.code} door width`).toBeGreaterThan(0);
        expect(d.offset + d.width, `${r.code} door overruns its wall`).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('sites each instrument in the room its Location attribute names, once', () => {
    const actual = Object.fromEntries(rooms.filter((r) => r.instrument).map((r) => [r.code, r.instrument]));
    expect(actual).toEqual(instruments);
    const sited = Object.values(actual);
    expect(new Set(sited).size).toBe(sited.length);
  });

  it('stores every continuation piece beside its first piece', () => {
    // `X (2)` with no `X` would print a label that names a room that is not
    // on the plan, and the view could not merge it into anything.
    const codes = new Set(rooms.map((r) => r.code));
    for (const r of rooms) {
      const m = /^(.+) \(\d+\)$/.exec(r.code);
      if (m) expect(codes.has(m[1]), `${r.code} has no first piece`).toBe(true);
    }
  });
});
