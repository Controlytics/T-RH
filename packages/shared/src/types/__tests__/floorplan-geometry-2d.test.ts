import { describe, it, expect } from 'vitest';
import { segmentOnEdge, splitDoor, rectanglePoints, SEGMENT_SNAP_TOL } from '../floorplan-geometry';

/**
 * Two pure helpers for the Layout Designer's 2D tools (2026-10-05): a window or
 * wall stub drawn ALONG a wall lands ON the wall; a double door is two doors.
 */
const room = rectanglePoints({ x: 0.2, y: 0.2, w: 0.4, h: 0.3 }); // top edge y=0.2 from x=0.2..0.6

describe('segmentOnEdge', () => {
  it('snaps both ends onto the one edge they both lie beside', () => {
    const r = segmentOnEdge({ x: 0.3, y: 0.205 }, { x: 0.5, y: 0.196 }, [room]);
    expect(r.snapped).toBe(true);
    expect(r.a).toEqual({ x: 0.3, y: 0.2 });
    expect(r.b).toEqual({ x: 0.5, y: 0.2 });
  });

  it('leaves a free segment alone (a duct stub across a room)', () => {
    const r = segmentOnEdge({ x: 0.3, y: 0.3 }, { x: 0.5, y: 0.35 }, [room]);
    expect(r.snapped).toBe(false);
    expect(r.a).toEqual({ x: 0.3, y: 0.3 });
    expect(r.b).toEqual({ x: 0.5, y: 0.35 });
  });

  it('never snaps one end to each of two DIFFERENT edges', () => {
    // a beside the top edge, b beside the left edge: not one wall.
    const r = segmentOnEdge({ x: 0.3, y: 0.205 }, { x: 0.205, y: 0.4 }, [room]);
    expect(r.snapped).toBe(false);
    expect(r.a).toEqual({ x: 0.3, y: 0.205 });
    expect(r.b).toEqual({ x: 0.205, y: 0.4 });
  });

  it('honours the tolerance', () => {
    expect(SEGMENT_SNAP_TOL).toBe(0.01);
    expect(segmentOnEdge({ x: 0.3, y: 0.22 }, { x: 0.5, y: 0.22 }, [room]).snapped).toBe(false);
    expect(segmentOnEdge({ x: 0.3, y: 0.22 }, { x: 0.5, y: 0.22 }, [room], 0.03).snapped).toBe(true);
  });
});

describe('splitDoor', () => {
  it('returns two half-width doors with mirrored hinges, abutting', () => {
    const [a, b] = splitDoor({ edge: 1, offset: 0.4, width: 0.2, kind: 'ENTRY', hinge: 'start', swing: 'in' });
    expect(a).toEqual({ edge: 1, offset: 0.4, width: 0.1, kind: 'ENTRY', hinge: 'start', swing: 'in' });
    expect(b).toEqual({ edge: 1, offset: 0.5, width: 0.1, kind: 'ENTRY', hinge: 'end', swing: 'in' });
  });

  it('keeps a wall-named door on its wall', () => {
    const [a, b] = splitDoor({ wall: 'top', offset: 0.1, width: 0.3, kind: 'EXIT' });
    expect(a.wall).toBe('top'); expect(b.wall).toBe('top');
    expect(a.width + b.width).toBeCloseTo(0.3, 9);
  });
});
