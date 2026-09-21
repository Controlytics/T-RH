/**
 * The QC floor is the one plan in this repo whose geometry is hand-authored
 * rather than generated, so it is the one plan whose geometry can be WRONG.
 *
 * The generator got these properties for free: a guillotine split cannot
 * produce an overlap or a gap, because every cut runs edge to edge. A traced
 * table has no such guarantee — a single mistyped digit puts two rooms on top
 * of each other, or opens a hairline seam, and both look plausible in a table
 * and only show up on screen. The operator holds the browser session all day,
 * so "look at it" is not available as a check. These assertions are the check.
 */
import { describe, it, expect } from 'vitest';
import { QC_ROOMS, QC_BUILDING, QC_CANVAS, norm } from '../qc-layout.js';

const rect = (px: [number, number, number, number]) => ({
  x0: px[0], y0: px[1], x1: px[2], y1: px[3],
});

describe('QC floor layout', () => {
  it('gives every room a unique code', () => {
    const codes = QC_ROOMS.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('keeps every code inside the column width', () => {
    // floorplan_rooms.code is VarChar(60); a longer code is a write failure at
    // apply time, which is the worst moment to discover it.
    for (const r of QC_ROOMS) expect(r.code.length).toBeLessThanOrEqual(60);
  });

  it('draws every rectangle with positive area', () => {
    for (const r of QC_ROOMS) {
      const b = rect(r.px);
      expect(b.x1, `${r.code} width`).toBeGreaterThan(b.x0);
      expect(b.y1, `${r.code} height`).toBeGreaterThan(b.y0);
    }
  });

  it('keeps every room inside the building outline', () => {
    // The renderer strokes the viewBox border as the building wall. A room that
    // escapes it is drawn outside its own building.
    for (const r of QC_ROOMS) {
      const b = rect(r.px);
      expect(b.x0, `${r.code} left`).toBeGreaterThanOrEqual(QC_BUILDING.x0);
      expect(b.y0, `${r.code} top`).toBeGreaterThanOrEqual(QC_BUILDING.y0);
      expect(b.x1, `${r.code} right`).toBeLessThanOrEqual(QC_BUILDING.x1);
      expect(b.y1, `${r.code} bottom`).toBeLessThanOrEqual(QC_BUILDING.y1);
    }
  });

  it('never overlaps two rooms', () => {
    // The failure this catches: two rooms claiming the same floor. Whichever
    // sorts later by code paints over the other, so the hidden room's readings
    // silently vanish from the plan while its row still exists.
    for (let i = 0; i < QC_ROOMS.length; i++) {
      for (let j = i + 1; j < QC_ROOMS.length; j++) {
        const a = rect(QC_ROOMS[i].px), b = rect(QC_ROOMS[j].px);
        const overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const overlapY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        const area = Math.max(0, overlapX) * Math.max(0, overlapY);
        expect(area, `${QC_ROOMS[i].code} overlaps ${QC_ROOMS[j].code}`).toBe(0);
      }
    }
  });

  it('takes every edge from the canonical wall grid', () => {
    // Shared walls must be quoted identically by both rooms that touch them.
    // Asserting membership of one measured set is what stops a local rounding
    // from opening a seam that no room's own numbers look wrong.
    const XS = new Set([13, 97, 156, 163, 202, 272, 381, 404, 440, 488, 510, 586, 591]);
    const YS = new Set([5, 92, 155, 229, 240, 288, 567, 641, 681, 700, 791]);
    for (const r of QC_ROOMS) {
      const b = rect(r.px);
      expect(XS.has(b.x0), `${r.code} left ${b.x0} off-grid`).toBe(true);
      expect(XS.has(b.x1), `${r.code} right ${b.x1} off-grid`).toBe(true);
      expect(YS.has(b.y0), `${r.code} top ${b.y0} off-grid`).toBe(true);
      expect(YS.has(b.y1), `${r.code} bottom ${b.y1} off-grid`).toBe(true);
    }
  });

  it('covers most of the building, so no unexplained void is left', () => {
    // A gap between rooms renders as a hole in the floor. Total room area is
    // compared against the building box; the shortfall is the wall thickness
    // and the two blocks' setbacks.
    //
    // The figure was 0.9694 when this was written. The bound is set at 0.95 —
    // close enough to catch a room that has gone missing or collapsed, loose
    // enough that moving one wall by a few pixels does not fail the suite for
    // an innocent reason. A bound of 0.9 would have let a whole small room
    // vanish unnoticed.
    const total = QC_ROOMS.reduce((n, r) => {
      const b = rect(r.px);
      return n + (b.x1 - b.x0) * (b.y1 - b.y0);
    }, 0);
    const building = QC_CANVAS.width * QC_CANVAS.height;
    expect(total / building).toBeGreaterThan(0.95);
    expect(total / building).toBeLessThanOrEqual(1);
  });

  it('normalizes into the unit square', () => {
    for (const r of QC_ROOMS) {
      const n = norm(r.px);
      expect(n.x, `${r.code} x`).toBeGreaterThanOrEqual(0);
      expect(n.y, `${r.code} y`).toBeGreaterThanOrEqual(0);
      expect(n.x + n.w, `${r.code} right`).toBeLessThanOrEqual(1);
      expect(n.y + n.h, `${r.code} bottom`).toBeLessThanOrEqual(1);
      expect(n.w).toBeGreaterThan(0);
      expect(n.h).toBeGreaterThan(0);
    }
  });

  it('keeps every door on its own wall', () => {
    // offset and width are fractions OF THE WALL. A door running past the end
    // of its wall is drawn hanging in space outside the room.
    for (const r of QC_ROOMS) {
      for (const d of r.doors ?? []) {
        expect(d.offset, `${r.code} door offset`).toBeGreaterThanOrEqual(0);
        expect(d.width, `${r.code} door width`).toBeGreaterThan(0);
        expect(d.offset + d.width, `${r.code} door overruns its wall`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('sites each of the twelve QC instruments in the room the registry names', () => {
    // Written out rather than derived: a swapped pair puts one room's readings
    // in another and looks entirely correct on screen. The right-hand column is
    // the Location attribute from CWH.xlsx, which is what the mapping is FROM.
    const expected: Record<string, string> = {
      'CWH-I/231': 'CWH/RDU/015-00', // Hot Zone (QC)
      'CWH-I/230': 'CWH/RDU/022-00', // Wet lab (QC)
      'CWH-I/229': 'CWH/RDU/018-00', // Sieving & Sample destruction chamber room (QC)
      'CWH-I/228': 'CWH/RDU/017-00', // Chamber room (QC)
      'CWH-I/227': 'CWH/RDU/016-00', // Weighing Room (QC)
      'CWH-I/226': 'CWH/RDU/019-00', // Instrumentation room-1 (QC)
      'CWH-I/225': 'CWH/RDU/021-00', // Dissolution Room (QC)
      'CWH-I/224': 'CWH/RDU/013-00', // Sample Storage Room
      'CWH-I/223': 'CWH/RDU/020-00', // HPLC Room (QC)
      'CWH-I/222': 'CWH/RDU/023-00', // Sample Preparation area (QC)
      'CWH-I/219': 'CWH/RDU/014-00', // GC Room (QC)
      'CWH-I/218': 'CWH/RDU/024-00', // QC-II (Dissolution lab-II)
    };
    const actual = Object.fromEntries(
      QC_ROOMS.filter((r) => r.instrument).map((r) => [r.code, r.instrument]),
    );
    expect(actual).toEqual(expected);
  });

  it('places all twelve instruments and no instrument twice', () => {
    const sited = QC_ROOMS.map((r) => r.instrument).filter(Boolean) as string[];
    expect(sited).toHaveLength(12);
    expect(new Set(sited).size).toBe(12);
  });

  it('leaves the unmonitored rooms unmonitored', () => {
    // The drawing shows readings in WASH AREA-02 and CHANGE ROOM, but the
    // registry has no instrument in either — the drawing's numbers there are
    // illustrative. Those rooms render without chips, which is the honest
    // result; inventing a sensor to fill them would fabricate a §11 record.
    for (const code of ['CWH-I/216', 'CWH-I/217', 'CWH-I/220', 'CWH-I/232', 'CWH-I/233']) {
      const room = QC_ROOMS.find((r) => r.code === code);
      expect(room, code).toBeDefined();
      expect(room!.instrument, `${code} should have no instrument`).toBeUndefined();
    }
  });
});
