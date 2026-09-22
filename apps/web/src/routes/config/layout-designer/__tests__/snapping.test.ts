import { describe, it, expect } from 'vitest';
import { snapPoint, rightAngle, nearestEdgePoint, GRID } from '../snapping';
import { rectanglePoints } from '@digilog/shared';

const other = rectanglePoints({ x: 0.3, y: 0.3, w: 0.2, h: 0.2 });

describe('snapPoint', () => {
  it('snaps to a neighbouring corner within tolerance, before the grid', () => {
    expect(snapPoint({ x: 0.305, y: 0.296 }, [other])).toEqual({ x: 0.3, y: 0.3 });
  });
  it('snaps onto a neighbouring edge when no corner is near', () => {
    expect(snapPoint({ x: 0.405, y: 0.296 }, [other])).toEqual({ x: 0.405, y: 0.3 });
  });
  it('otherwise snaps to the grid', () => {
    expect(snapPoint({ x: 0.111, y: 0.129 }, [])).toEqual({ x: 0.12, y: 0.12 });
    expect(GRID).toBe(0.02);
  });
  it('never leaves the plan', () => {
    expect(snapPoint({ x: 1.3, y: -0.2 }, [])).toEqual({ x: 1, y: 0 });
  });
  it('with Shift the next edge is axis-aligned before snapping', () => {
    expect(snapPoint({ x: 0.401, y: 0.152 }, [], { shiftFrom: { x: 0.1, y: 0.1 } })).toEqual({ x: 0.4, y: 0.1 });
  });
});

describe('rightAngle', () => {
  it('keeps the longer axis', () => {
    expect(rightAngle({ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.15 })).toEqual({ x: 0.4, y: 0.1 });
    expect(rightAngle({ x: 0.1, y: 0.1 }, { x: 0.15, y: 0.4 })).toEqual({ x: 0.1, y: 0.4 });
  });
});

describe('nearestEdgePoint', () => {
  it('reports the edge and the fraction along it', () => {
    const n = nearestEdgePoint({ x: 0.4, y: 0.29 }, other);
    expect(n.edge).toBe(0);
    expect(n.t).toBeCloseTo(0.5, 6);
    expect(n.point).toEqual({ x: 0.4, y: 0.3 });
  });
});
