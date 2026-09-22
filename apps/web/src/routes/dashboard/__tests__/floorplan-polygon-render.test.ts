import { describe, it, expect } from 'vitest';
import { roomOutline, roomOpenings } from '../floorplan-view';
import type { FloorplanRoomShape, FloorplanLinkShape } from '../use-telemetry';

/**
 * The pure halves of the dashboard's polygon drawing (Layout Designer,
 * 2026-09-22): which outline a room draws, and which link openings land on
 * which of its edges. The SVG itself cannot be asserted in jsdom; these
 * numbers are where it breaks.
 */
const rect = (id: string, x: number, y: number, w: number, h: number): FloorplanRoomShape => ({
  id, code: id, label: null, grade: null, x, y, w, h,
  tempMin: null, tempMax: null, rhMin: null, rhMax: null, doors: null, meta: null, points: null,
});

describe('roomOutline', () => {
  it('a rectangle room outlines as its four corners scaled to the viewBox', () => {
    expect(roomOutline(rect('A', 0.1, 0.1, 0.2, 0.2), 1000, 500)).toEqual([
      { x: 100, y: 50 }, { x: 300, y: 50 }, { x: 300, y: 150 }, { x: 100, y: 150 },
    ]);
  });
  it('a stored polygon is used as drawn', () => {
    const r = { ...rect('L', 0, 0, 1, 1), points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.1, y: 0.5 }] };
    expect(roomOutline(r, 1000, 1000)).toEqual([{ x: 100, y: 100 }, { x: 500, y: 100 }, { x: 100, y: 500 }]);
  });
});

describe('roomOpenings', () => {
  it('an opening link lands on the from-room as stored and on the to-room mirrored', () => {
    const a = rect('A', 0.1, 0.1, 0.2, 0.2), b = rect('B', 0.3, 0.1, 0.2, 0.2);
    const links: FloorplanLinkShape[] = [
      { id: 'l', fromRoomId: 'A', toRoomId: 'B', kind: 'OPENING', fromEdge: 1, offset: 0.2, width: 0.3, door: null, label: null },
    ];
    const drawn = [{ room: a }, { room: b }];
    expect(roomOpenings(a, links, drawn, 1000, 1000)).toEqual([{ edge: 1, offset: 0.2, width: 0.3 }]);
    expect(roomOpenings(b, links, drawn, 1000, 1000)).toEqual([{ edge: 3, offset: 0.5, width: 0.3 }]);
  });
  it('a connector adds no opening, and a link to a room that is not drawn is ignored', () => {
    const a = rect('A', 0.1, 0.1, 0.2, 0.2), b = rect('B', 0.3, 0.1, 0.2, 0.2);
    const links: FloorplanLinkShape[] = [
      { id: 'c', fromRoomId: 'A', toRoomId: 'B', kind: 'CONNECTOR', fromEdge: null, offset: null, width: null, door: null, label: 'x' },
      { id: 'o', fromRoomId: 'B', toRoomId: 'A', kind: 'OPENING', fromEdge: 3, offset: 0.1, width: 0.2, door: null, label: null },
    ];
    expect(roomOpenings(a, links, [{ room: a }], 1000, 1000)).toEqual([]);
  });
});
