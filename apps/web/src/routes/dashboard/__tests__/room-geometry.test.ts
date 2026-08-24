import { describe, it, expect } from 'vitest';
import { wallSegments, doorPlacements, type RoomDoor } from '../room-geometry';
import { tileLayout } from '../room-geometry';

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
