import { describe, it, expect } from 'vitest';
import { avoidDoorSwings, polygonDoorPlacements } from '../room-geometry';

/**
 * Operator, 2026-10-01: "on QC layout 2 instrument id CWH/RDU/024-00 showing
 * on door". A tile's text must not sit inside a door's swing.
 */
const room = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 160 }, { x: 0, y: 160 }];
const box = { x: 0, y: 0, w: 200, h: 160 };

describe('avoidDoorSwings', () => {
  it('a door in the TOP wall pushes the tile below its swing', () => {
    const doors = polygonDoorPlacements(room, [{ edge: 0, offset: 0.1, width: 0.2, kind: 'ENTRY' }]);
    const out = avoidDoorSwings(box, doors, 70);
    expect(out.y).toBeCloseTo(40); // swing = 0.2 x 200 = 40 deep
    expect(out.h).toBeCloseTo(120);
    expect(out.x).toBe(0);
    expect(out.w).toBe(200);
  });

  it('a door in the LEFT wall over the text narrows the tile away from it', () => {
    // edge 3 runs bottom-left -> top-left; offset 0.75 puts the door at the top.
    const doors = polygonDoorPlacements(room, [{ edge: 3, offset: 0.75, width: 0.2, kind: 'ENTRY' }]);
    const out = avoidDoorSwings(box, doors, 70);
    expect(out.x).toBeCloseTo(32); // 0.2 x 160
    expect(out.w).toBeCloseTo(168);
    expect(out.y).toBe(0);
  });

  it('a swing clear of the text band costs nothing', () => {
    // Left wall, low down: the swing is below the 70px text band.
    const doors = polygonDoorPlacements(room, [{ edge: 3, offset: 0.05, width: 0.2, kind: 'ENTRY' }]);
    expect(avoidDoorSwings(box, doors, 70)).toEqual(box);
  });

  it('never gives up more than three quarters of the box', () => {
    const doors = polygonDoorPlacements(room, [{ edge: 0, offset: 0.1, width: 0.9, kind: 'ENTRY' }]);
    expect(avoidDoorSwings(box, doors, 70)).toEqual(box);
  });

  it('an opening with no leaf has no swing to avoid', () => {
    const doors = polygonDoorPlacements(room, [{ edge: 0, offset: 0.1, width: 0.2, kind: 'ENTRY', hinge: 'none' }]);
    expect(avoidDoorSwings(box, doors, 70)).toEqual(box);
  });
});
