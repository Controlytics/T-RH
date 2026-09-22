import { describe, it, expect } from 'vitest';
import { wallSegments, doorPlacements, sharedOpenings, type RoomDoor } from '../room-geometry';
import { tileLayout, captionHeader } from '../room-geometry';

/** A 100x100 box at the origin — every expected number below is readable by hand. */
const box = { x: 0, y: 0, w: 100, h: 100 };

describe('wallSegments', () => {
  it('returns four whole walls when there are no doors', () => {
    expect(wallSegments(box, null)).toHaveLength(4);
    expect(wallSegments(box, [])).toHaveLength(4);
  });

  it('closes the rectangle when there are no doors', () => {
    const segs = wallSegments(box, []);
    const total = segs.reduce((sum, s) => sum + Math.abs(s.x2 - s.x1) + Math.abs(s.y2 - s.y1), 0);
    expect(total).toBe(400);
  });

  it('splits one wall into two segments around a door in the middle', () => {
    const doors: RoomDoor[] = [{ wall: 'top', offset: 0.4, width: 0.2, kind: 'ENTRY' }];
    const segs = wallSegments(box, doors);
    expect(segs).toHaveLength(5); // 3 whole walls + 2 pieces of the top
    const top = segs.filter((s) => s.y1 === 0 && s.y2 === 0);
    expect(top).toHaveLength(2);
    expect(top[0]).toEqual({ x1: 0, y1: 0, x2: 40, y2: 0 });
    expect(top[1]).toEqual({ x1: 60, y1: 0, x2: 100, y2: 0 });
  });

  it('emits no zero-length stub when a door starts at the wall corner', () => {
    const doors: RoomDoor[] = [{ wall: 'top', offset: 0, width: 0.2, kind: 'ENTRY' }];
    const segs = wallSegments(box, doors);
    expect(segs).toHaveLength(4); // 3 whole walls + the single remaining piece
    expect(segs.every((s) => s.x1 !== s.x2 || s.y1 !== s.y2)).toBe(true);
  });

  it('emits no zero-length stub when a door ends at the far corner', () => {
    const doors: RoomDoor[] = [{ wall: 'left', offset: 0.8, width: 0.2, kind: 'EXIT' }];
    const segs = wallSegments(box, doors);
    expect(segs).toHaveLength(4);
    expect(segs.every((s) => s.x1 !== s.x2 || s.y1 !== s.y2)).toBe(true);
  });

  it('handles two doors on one wall, in either input order', () => {
    const a: RoomDoor = { wall: 'bottom', offset: 0.1, width: 0.1, kind: 'ENTRY' };
    const b: RoomDoor = { wall: 'bottom', offset: 0.6, width: 0.1, kind: 'EXIT' };
    expect(wallSegments(box, [a, b])).toHaveLength(6); // 3 whole + 3 pieces
    expect(wallSegments(box, [b, a])).toEqual(wallSegments(box, [a, b]));
  });

  it('removes the wall entirely when a door spans all of it', () => {
    const doors: RoomDoor[] = [{ wall: 'right', offset: 0, width: 1, kind: 'PASSAGE' }];
    expect(wallSegments(box, doors)).toHaveLength(3);
  });

  it('respects the box origin', () => {
    const segs = wallSegments({ x: 10, y: 20, w: 50, h: 40 }, []);
    const xs = segs.flatMap((s) => [s.x1, s.x2]);
    const ys = segs.flatMap((s) => [s.y1, s.y2]);
    expect(Math.min(...xs)).toBe(10);
    expect(Math.max(...xs)).toBe(60);
    expect(Math.min(...ys)).toBe(20);
    expect(Math.max(...ys)).toBe(60);
  });
});

describe('doorPlacements', () => {
  it('returns nothing for no doors', () => {
    expect(doorPlacements(box, null)).toEqual([]);
  });

  it('hinges a top-wall door on the opening and swings the leaf INTO the room', () => {
    const [d] = doorPlacements(box, [{ wall: 'top', offset: 0.4, width: 0.2, kind: 'ENTRY' }]);
    expect(d.hinge).toEqual({ x: 40, y: 0 });
    // The leaf ends inside the room, i.e. below the top wall.
    expect(d.leaf.y2).toBeGreaterThan(0);
    expect(d.arc.startsWith('M')).toBe(true);
  });

  it('swings a bottom-wall door into the room too — upward', () => {
    const [d] = doorPlacements(box, [{ wall: 'bottom', offset: 0.4, width: 0.2, kind: 'EXIT' }]);
    expect(d.hinge.y).toBe(100);
    expect(d.leaf.y2).toBeLessThan(100);
  });

  it('carries the kind through untouched', () => {
    const placements = doorPlacements(box, [
      { wall: 'top', offset: 0.1, width: 0.1, kind: 'ENTRY' },
      { wall: 'left', offset: 0.1, width: 0.1, kind: 'PASSAGE' },
    ]);
    expect(placements.map((p) => p.kind)).toEqual(['ENTRY', 'PASSAGE']);
  });
});

describe('tileLayout — degrade steps', () => {
  const big = { x: 0, y: 0, w: 300, h: 200 };
  const tiny = { x: 0, y: 0, w: 26, h: 18 };

  it('draws full tiles when there is room', () => {
    const l = tileLayout(big, 2);
    expect(l.step).toBe('FULL');
    expect(l.visible).toBe(2);
    expect(l.hidden).toBe(0);
  });

  it('never reports more visible tiles than there are instruments', () => {
    expect(tileLayout(big, 1).visible).toBe(1);
    expect(tileLayout(big, 0).visible).toBe(0);
  });

  it('falls to CODE_ONLY in a box too small for any tile', () => {
    expect(tileLayout(tiny, 3).step).toBe('CODE_ONLY');
    expect(tileLayout(tiny, 3).visible).toBe(0);
  });

  it('overflows rather than overlapping when the instruments do not fit', () => {
    const l = tileLayout({ x: 0, y: 0, w: 120, h: 70 }, 12);
    expect(l.step).toBe('OVERFLOW');
    expect(l.visible + l.hidden).toBe(12);
    expect(l.hidden).toBeGreaterThan(0);
    // The +K marker occupies a slot, so a tile is given up to make space for it.
    expect(l.visible).toBeLessThan(l.cols * l.rows);
  });

  it('keeps every tile inside the box', () => {
    const l = tileLayout(big, 4);
    expect(l.cols * l.tile.w).toBeLessThanOrEqual(big.w);
    expect(l.bodyTop + l.rows * l.tile.h).toBeLessThanOrEqual(big.y + big.h);
  });

  it('leaves the header strip clear for the room code', () => {
    const l = tileLayout(big, 2);
    expect(l.bodyTop).toBeGreaterThan(big.y);
  });

  it('is monotonic — a smaller box never degrades to a richer step', () => {
    const order: Record<string, number> = { FULL: 0, VALUES_ONLY: 1, OVERFLOW: 2, COMPACT: 3, CODE_ONLY: 4 };
    const wide = tileLayout({ x: 0, y: 0, w: 300, h: 200 }, 3);
    const narrow = tileLayout({ x: 0, y: 0, w: 90, h: 60 }, 3);
    expect(order[narrow.step]).toBeGreaterThanOrEqual(order[wide.step]);
  });
});

import { CHIP_HEIGHT_FACTOR, CHIP_GAP, FULL_CODE_GAP, VALUES_TOP_GAP, CODE_LINE_H } from '../room-geometry';

describe('tileLayout — chip fit (regression: a FULL/VALUES_ONLY tile must actually hold two chips)', () => {
  // The renderer's chip geometry (chipH = fontSize * factor, stacked `gap`
  // apart, starting `topGap` down) from the SAME exported constants the
  // renderer draws with, so the three cannot drift apart.
  function requiredHeight(fontSize: number, topGap: number): number {
    const chipH = fontSize * CHIP_HEIGHT_FACTOR;
    return topGap + 2 * chipH + CHIP_GAP;
  }

  it('gives a FULL tile enough height for a code line plus two chips', () => {
    const l = tileLayout({ x: 0, y: 0, w: 244, h: 234 }, 1);
    expect(l.step).toBe('FULL');
    expect(l.tile.h).toBeGreaterThanOrEqual(requiredHeight(l.fontSize, CODE_LINE_H + FULL_CODE_GAP));
  });

  it('gives a VALUES_ONLY tile enough height for two chips with no code line', () => {
    const l = tileLayout({ x: 0, y: 0, w: 300, h: 50 }, 1);
    expect(l.step).toBe('VALUES_ONLY');
    expect(l.tile.h).toBeGreaterThanOrEqual(requiredHeight(l.fontSize, VALUES_TOP_GAP));
  });

  it('does not clip the humidity chip for a single instrument in a wide room (exact reported case)', () => {
    const l = tileLayout({ x: 0, y: 0, w: 244, h: 234 }, 1);
    // One instrument should not be spread across a 5-column grid it doesn't need.
    expect(l.cols).toBe(1);
    expect(l.tile.h).toBeGreaterThanOrEqual(requiredHeight(l.fontSize, CODE_LINE_H + FULL_CODE_GAP));
  });
});

describe('tileLayout — column count', () => {
  it('never uses more columns than there are instruments', () => {
    const l = tileLayout({ x: 0, y: 0, w: 300, h: 200 }, 2);
    expect(l.cols).toBeLessThanOrEqual(2);
  });
});

describe('tileLayout header reservation', () => {
  // A TRACED room prints four caption lines (code, name, ceiling height, floor
  // dimensions) where a generated room prints one. The view passes the space
  // those need; if tileLayout ignored it, the first row of readings would be
  // drawn on top of the dimension text — legible enough in a screenshot to pass
  // review, and wrong on a wall display at three metres.
  const box = { x: 0, y: 0, w: 300, h: 200 };

  it('starts the tiles below the space the caller reserved', () => {
    expect(tileLayout(box, 1, 44).bodyTop).toBe(44);
    expect(tileLayout(box, 1).bodyTop).toBe(14);
  });

  it('sizes the tile grid from what is LEFT, not from the whole box', () => {
    // The bug this catches: reserving header space for the captions but still
    // laying tiles out over the full height, so they overrun the bottom wall.
    const generated = tileLayout(box, 2);
    const traced = tileLayout(box, 2, 44);
    expect(traced.tile.h).toBeLessThan(generated.tile.h);
    expect(traced.bodyTop + traced.rows * traced.tile.h).toBeLessThanOrEqual(box.y + box.h + 0.001);
  });

  it('falls back to code-only when the captions leave no room for a tile', () => {
    // A small room that would have shown its readings must not show them
    // half-overlapping its own dimension line; it shows the captions and says
    // how many instruments it is hiding.
    const small = { x: 0, y: 0, w: 300, h: 50 };
    expect(tileLayout(small, 1, 44).step).toBe('CODE_ONLY');
    expect(tileLayout(small, 1, 44).hidden).toBe(1);
  });

  it('leaves every existing caller unchanged', () => {
    // The parameter defaults, so no generated plan moves by a pixel.
    for (const n of [0, 1, 2, 5, 9]) {
      expect(tileLayout(box, n, 14)).toEqual(tileLayout(box, n));
    }
  });
});

describe('captionHeader', () => {
  // The competition this resolves: a traced room wants four caption lines where
  // a generated one prints one, and that space comes out of the tile grid.
  const opts = { name: true, lines: 2 };

  it('gives a tall room its captions', () => {
    // SAMPLE PREPARATION-sized, 353x345 in viewBox units.
    const fit = captionHeader({ x: 0, y: 0, w: 353, h: 345 }, 1, opts);
    expect(fit.captions).toBe(true);
    expect(fit.headerH).toBe(44);
  });

  it('gives the tightest real QC room its captions AND its reading', () => {
    // SAMPLE STORAGE ROOM, 243x103 — the smallest instrument room on the plan,
    // and the one that would break first if the caption cost grew.
    const box = { x: 0, y: 0, w: 243, h: 103 };
    const fit = captionHeader(box, 1, opts);
    expect(fit.captions).toBe(true);
    expect(tileLayout(box, 1, fit.headerH).visible).toBe(1);
  });

  it('drops the captions rather than hide a reading', () => {
    // The whole point. A room short enough that reserving caption space costs
    // an instrument shows the instrument, not the ceiling height.
    const box = { x: 0, y: 0, w: 240, h: 62 };
    const withCaptions = tileLayout(box, 1, 44).visible;
    const fit = captionHeader(box, 1, opts);
    if (withCaptions < tileLayout(box, 1).visible) {
      expect(fit.captions).toBe(false);
      expect(fit.headerH).toBe(14);
    }
    // Whichever branch was taken, the reading must survive it.
    expect(tileLayout(box, 1, fit.headerH).visible).toBe(tileLayout(box, 1).visible);
  });

  it('never reserves more header than the room is tall', () => {
    expect(captionHeader({ x: 0, y: 0, w: 200, h: 30 }, 1, opts).captions).toBe(false);
  });

  it('captions a room with no instruments, which has no readings to lose', () => {
    // A corridor or an office still carries its dimensions on the drawing.
    expect(captionHeader({ x: 0, y: 0, w: 300, h: 60 }, 0, opts).captions).toBe(true);
  });

  it('asks for nothing when the drawing gave the room no captions', () => {
    const fit = captionHeader({ x: 0, y: 0, w: 353, h: 345 }, 1, { name: true, lines: 0 });
    expect(fit).toEqual({ headerH: 14, captions: false });
  });
});

describe('sharedOpenings — adjoining circulation rooms are one space', () => {
  // The QC corridor as stored: an east-west run, the north-south leg standing
  // on its top edge, and the short east piece against its right edge.
  const run = { x: 0, y: 641, w: 475, h: 59 };
  const leg = { x: 368, y: 288, w: 59, h: 353 };
  const east = { x: 475, y: 641, w: 98, h: 40 };

  it('opens the seam on BOTH rooms of an L-junction', () => {
    const onRun = sharedOpenings(run, [leg]);
    expect(onRun).toHaveLength(1);
    expect(onRun[0].wall).toBe('top');
    expect(onRun[0].offset).toBeCloseTo(368 / 475, 8);
    expect(onRun[0].width).toBeCloseTo(59 / 475, 8);
    const onLeg = sharedOpenings(leg, [run]);
    expect(onLeg).toEqual([{ wall: 'bottom', offset: 0, width: 1 }]);
  });

  it('opens a vertical seam over the overlapping height only', () => {
    const onRun = sharedOpenings(run, [east]);
    expect(onRun).toHaveLength(1);
    expect(onRun[0].wall).toBe('right');
    expect(onRun[0].offset).toBe(0);
    expect(onRun[0].width).toBeCloseTo(40 / 59, 8);
    expect(sharedOpenings(east, [run])).toEqual([{ wall: 'left', offset: 0, width: 1 }]);
  });

  it('yields nothing for a room that only touches at a corner, or not at all', () => {
    const corner = { x: 475, y: 700, w: 50, h: 50 }; // meets `run` at one point
    expect(sharedOpenings(run, [corner])).toEqual([]);
    expect(sharedOpenings(run, [{ x: 0, y: 100, w: 100, h: 100 }])).toEqual([]);
  });

  it('accepts a seam off by float noise but not by a real gap', () => {
    expect(sharedOpenings(run, [{ ...leg, y: leg.y + 0.0001 }])).toHaveLength(1);
    expect(sharedOpenings(run, [{ ...leg, y: leg.y - 3 }])).toEqual([]);
  });

  it('removes the seam from the drawn walls when passed with the doors', () => {
    const solid = wallSegments(run, []);
    const opened = wallSegments(run, sharedOpenings(run, [leg, east]));
    // Top wall cut where the leg stands on it: no drawn segment may run
    // along the seam for more than a pixel (the remainder starts at its end).
    const alongLegSeam = opened.filter((s) =>
      s.y1 === 641 && s.y2 === 641 && Math.min(s.x2, 427) - Math.max(s.x1, 368) > 1);
    expect(alongLegSeam).toEqual([]);
    // And the right wall, where the east piece abuts, is gone for the top 40.
    const alongEastSeam = opened.filter((s) =>
      s.x1 === 475 && s.x2 === 475 && Math.min(s.y2, 681) - Math.max(s.y1, 641) > 1);
    expect(alongEastSeam).toEqual([]);
    expect(opened.length).toBeGreaterThan(solid.length);
  });
});
