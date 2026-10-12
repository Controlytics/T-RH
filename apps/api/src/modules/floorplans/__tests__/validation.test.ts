import { describe, it, expect } from 'vitest';
import { validateRoomPayload, roomGeometry } from '../validation.js';

const base = { code: 'CWH-I/142', x: 0.1, y: 0.1, w: 0.2, h: 0.2 };

describe('validateRoomPayload — geometry', () => {
  it('accepts a box inside the plan', () => {
    expect(validateRoomPayload(base).ok).toBe(true);
  });

  it('accepts a box exactly filling the plan', () => {
    expect(validateRoomPayload({ ...base, x: 0, y: 0, w: 1, h: 1 }).ok).toBe(true);
  });

  it('rejects a negative origin', () => {
    const r = validateRoomPayload({ ...base, x: -0.01 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/x/);
  });

  it('rejects a box running off the right edge', () => {
    const r = validateRoomPayload({ ...base, x: 0.9, w: 0.2 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/right edge/i);
  });

  it('rejects a box running off the bottom edge', () => {
    const r = validateRoomPayload({ ...base, y: 0.95, h: 0.1 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/bottom edge/i);
  });

  it('rejects a zero-width box — an unclickable hotspot is a bug, not a choice', () => {
    expect(validateRoomPayload({ ...base, w: 0 }).ok).toBe(false);
  });

  it('rejects a zero-height box', () => {
    expect(validateRoomPayload({ ...base, h: 0 }).ok).toBe(false);
  });

  it('rejects pixel coordinates, which is the likely mistake', () => {
    const r = validateRoomPayload({ ...base, x: 420, y: 300, w: 120, h: 80 });
    expect(r.ok).toBe(false);
  });

  it('rejects a missing coordinate rather than defaulting it to zero', () => {
    const { x, ...noX } = base;
    expect(validateRoomPayload(noX).ok).toBe(false);
  });
});

describe('validateRoomPayload — limits', () => {
  it('accepts no limits at all — a corridor has no specification', () => {
    expect(validateRoomPayload(base).ok).toBe(true);
  });

  it('accepts one bound without the other', () => {
    expect(validateRoomPayload({ ...base, tempMax: 25 }).ok).toBe(true);
  });

  it('accepts a valid range', () => {
    expect(validateRoomPayload({ ...base, tempMin: 18, tempMax: 25 }).ok).toBe(true);
  });

  it('accepts an explicit null, which is how the editor clears a limit', () => {
    const r = validateRoomPayload({ ...base, tempMin: null, tempMax: null });
    expect(r.ok).toBe(true);
    expect(r.ok && r.data.tempMin).toBeNull();
  });

  it('rejects an inverted temperature range', () => {
    const r = validateRoomPayload({ ...base, tempMin: 25, tempMax: 18 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/temperature/i);
  });

  it('rejects an inverted humidity range', () => {
    const r = validateRoomPayload({ ...base, rhMin: 60, rhMax: 40 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/humidity/i);
  });

  it('rejects equal bounds — nothing could ever be in spec', () => {
    expect(validateRoomPayload({ ...base, tempMin: 20, tempMax: 20 }).ok).toBe(false);
  });

  it('rejects humidity outside 0-100', () => {
    expect(validateRoomPayload({ ...base, rhMin: -1 }).ok).toBe(false);
    expect(validateRoomPayload({ ...base, rhMax: 101 }).ok).toBe(false);
  });

  it('rejects a non-numeric limit rather than coercing it', () => {
    expect(validateRoomPayload({ ...base, tempMax: '25' }).ok).toBe(false);
  });
});

describe('validateRoomPayload — code', () => {
  it('rejects a blank code', () => {
    expect(validateRoomPayload({ ...base, code: '   ' }).ok).toBe(false);
  });

  it('trims the code', () => {
    const r = validateRoomPayload({ ...base, code: '  CWH-I/142  ' });
    expect(r.ok && r.data.code).toBe('CWH-I/142');
  });

  it('keeps a slash — room codes on the drawing contain them', () => {
    const r = validateRoomPayload({ ...base, code: 'CWH-I/142' });
    expect(r.ok && r.data.code).toBe('CWH-I/142');
  });
});

const door = { wall: 'top' as const, offset: 0.2, width: 0.1, kind: 'ENTRY' as const };

describe('validateRoomPayload — doors', () => {
  it('accepts a room with no doors key at all — every existing room', () => {
    expect(validateRoomPayload(base).ok).toBe(true);
  });

  it('accepts an explicit null and an empty list', () => {
    expect(validateRoomPayload({ ...base, doors: null }).ok).toBe(true);
    expect(validateRoomPayload({ ...base, doors: [] }).ok).toBe(true);
  });

  // 2026-10-01: an exterior door that opens OUT of the building. The parsed
  // payload is what the HTTP route stores, so a field the schema does not name
  // is dropped there — the door would be saved, and drawn, swinging in.
  it('KEEPS a door\'s hinge end and swing side, and refuses a side that is neither', () => {
    const r = validateRoomPayload({ ...base, doors: [{ ...door, kind: 'EXIT', hinge: 'end', swing: 'out' }] });
    expect(r.ok).toBe(true);
    expect(r.ok && r.data.doors).toEqual([{ ...door, kind: 'EXIT', hinge: 'end', swing: 'out' }]);
    expect(validateRoomPayload({ ...base, doors: [{ ...door, swing: 'in' }] }).ok).toBe(true);
    expect(validateRoomPayload({ ...base, doors: [{ ...door, swing: 'sideways' }] }).ok).toBe(false);
  });

  it('accepts one door on each wall', () => {
    const doors = (['top', 'right', 'bottom', 'left'] as const).map((wall) => ({ ...door, wall }));
    expect(validateRoomPayload({ ...base, doors }).ok).toBe(true);
  });

  it('accepts a door flush against the far corner of its wall', () => {
    expect(validateRoomPayload({ ...base, doors: [{ ...door, offset: 0.8, width: 0.2 }] }).ok).toBe(true);
  });

  it('rejects an unknown wall', () => {
    const r = validateRoomPayload({ ...base, doors: [{ ...door, wall: 'ceiling' }] });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/wall/i);
  });

  it('rejects an unknown kind', () => {
    const r = validateRoomPayload({ ...base, doors: [{ ...door, kind: 'AIRLOCK' }] });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/kind/i);
  });

  it('rejects a zero-width door — a slip while dragging, never an intent', () => {
    expect(validateRoomPayload({ ...base, doors: [{ ...door, width: 0 }] }).ok).toBe(false);
  });

  it('rejects a negative offset', () => {
    expect(validateRoomPayload({ ...base, doors: [{ ...door, offset: -0.01 }] }).ok).toBe(false);
  });

  it('rejects a door running past the end of its wall', () => {
    const r = validateRoomPayload({ ...base, doors: [{ ...door, offset: 0.9, width: 0.2 }] });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/past the end of the top wall/i);
  });

  it('rejects two doors overlapping on the same wall', () => {
    const doors = [
      { ...door, offset: 0.2, width: 0.2 },
      { ...door, offset: 0.3, width: 0.2 },
    ];
    const r = validateRoomPayload({ ...base, doors });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/overlap/i);
  });

  it('accepts two doors that merely touch end to start', () => {
    const doors = [
      { ...door, offset: 0.2, width: 0.2 },
      { ...door, offset: 0.4, width: 0.2 },
    ];
    expect(validateRoomPayload({ ...base, doors }).ok).toBe(true);
  });

  it('accepts overlapping offsets when the doors are on DIFFERENT walls', () => {
    const doors = [
      { ...door, wall: 'top' as const, offset: 0.2, width: 0.2 },
      { ...door, wall: 'left' as const, offset: 0.3, width: 0.2 },
    ];
    expect(validateRoomPayload({ ...base, doors }).ok).toBe(true);
  });

  it('rejects more than six doors — a runaway client, not a real room', () => {
    const doors = Array.from({ length: 7 }, (_, i) => ({ ...door, offset: i * 0.1, width: 0.05 }));
    expect(validateRoomPayload({ ...base, doors }).ok).toBe(false);
  });

  // The route handler (routes.ts) relies on `undefined` and `null` staying
  // DISTINCT out of validateRoomPayload: an omitted key must leave a room's
  // stored doors untouched on PUT, while an explicit null must clear them.
  // That branch lives in the Fastify route and isn't reachable from this
  // module without standing up the server, so the assertion here is the part
  // that IS reachable: that validation does not collapse the two.
  it('leaves doors absent from the parsed data when the key is omitted, distinct from an explicit null', () => {
    const omitted = validateRoomPayload(base);
    expect(omitted.ok).toBe(true);
    expect(omitted.ok && 'doors' in omitted.data).toBe(false);

    const explicitNull = validateRoomPayload({ ...base, doors: null });
    expect(explicitNull.ok).toBe(true);
    expect(explicitNull.ok && 'doors' in explicitNull.data).toBe(true);
    expect(explicitNull.ok && explicitNull.data.doors).toBeNull();
  });
});

describe('validateRoomPayload — grade', () => {
  it.each(['A', 'B', 'C', 'D', 'CIRCULATION', 'UTILITY'] as const)(
    'accepts grade %s',
    (grade) => {
      const r = validateRoomPayload({ ...base, grade });
      expect(r.ok).toBe(true);
      expect(r.ok && r.data.grade).toBe(grade);
    },
  );

  it('rejects an unknown grade, naming the field', () => {
    const r = validateRoomPayload({ ...base, grade: 'AA' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.startsWith('grade:')).toBe(true);
  });

  it('accepts an explicit null grade — nobody has classified this room', () => {
    const r = validateRoomPayload({ ...base, grade: null });
    expect(r.ok).toBe(true);
    expect(r.ok && r.data.grade).toBeNull();
  });

  it('accepts an omitted grade — every existing room', () => {
    const r = validateRoomPayload(base);
    expect(r.ok).toBe(true);
    expect(r.ok && 'grade' in r.data).toBe(false);
  });
});

describe('polygon rooms (Layout Designer, 2026-09-22)', () => {
  const L = [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.3 }, { x: 0.3, y: 0.3 }, { x: 0.3, y: 0.5 }, { x: 0.1, y: 0.5 }];
  const tri = [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.1, y: 0.5 }];

  it('accepts a simple polygon and derives its box', () => {
    const r = validateRoomPayload({ ...base, points: L });
    expect(r.ok).toBe(true);
    if (r.ok) expect(roomGeometry(r.data)).toEqual({ x: 0.1, y: 0.1, w: 0.4, h: 0.4 });
  });

  it('a rectangle room keeps the box it sent', () => {
    const r = validateRoomPayload(base);
    if (r.ok) expect(roomGeometry(r.data)).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
  });

  it('refuses a bow-tie, naming points', () => {
    const r = validateRoomPayload({ ...base, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }] });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/points/);
  });

  it('accepts a door by edge on a polygon and refuses one past its last edge', () => {
    expect(validateRoomPayload({ ...base, points: tri, doors: [{ edge: 2, offset: 0.2, width: 0.2, kind: 'ENTRY' }] }).ok).toBe(true);
    const r = validateRoomPayload({ ...base, points: tri, doors: [{ edge: 3, offset: 0.2, width: 0.2, kind: 'ENTRY' }] });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/edge the room does not have/);
  });

  it('a rectangle door still names a wall, and a door naming neither is refused', () => {
    expect(validateRoomPayload({ ...base, doors: [{ wall: 'top', offset: 0.2, width: 0.2, kind: 'ENTRY' }] }).ok).toBe(true);
    expect(validateRoomPayload({ ...base, doors: [{ offset: 0.2, width: 0.2, kind: 'ENTRY' }] }).ok).toBe(false);
  });

  it('a PUT that omits points checks doors against the STORED polygon, not a 4-edge box (finding 8)', () => {
    const door = { edge: 5, offset: 0.2, width: 0.2, kind: 'ENTRY' as const };
    // L has six edges; edge 5 exists on the stored outline.
    expect(validateRoomPayload({ ...base, doors: [door] }, L).ok).toBe(true);
    // Without the stored outline the room is a rectangle, which has no edge 5.
    expect(validateRoomPayload({ ...base, doors: [door] }).ok).toBe(false);
    // An explicit points:null clears the polygon: the rectangle rule applies again.
    expect(validateRoomPayload({ ...base, points: null, doors: [door] }, L).ok).toBe(false);
    // Points SENT win over the stored ones.
    expect(validateRoomPayload({ ...base, points: tri, doors: [door] }, L).ok).toBe(false);
  });

  it('two doors overlapping on one polygon edge are refused', () => {
    const r = validateRoomPayload({ ...base, points: tri, doors: [
      { edge: 0, offset: 0.1, width: 0.3, kind: 'ENTRY' },
      { edge: 0, offset: 0.3, width: 0.3, kind: 'EXIT' },
    ] });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/overlap/);
  });
});
