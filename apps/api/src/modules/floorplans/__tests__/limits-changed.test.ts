import { describe, it, expect } from 'vitest';
import { limitsChanged } from '../routes.js';

/**
 * Audit 2026-10-03, DATA-11: `PUT /api/floorplans/:id/rooms/:roomId` requires
 * a `reason` exactly when it moves a LIMIT. This is the rule that decides
 * "moves": compared against the stored row, with an omitted limit read as a
 * clear (the client sends the whole room, and the update writes `undefined`
 * as null).
 */
const stored = { tempMin: 18, tempMax: 25, rhMin: null, rhMax: 60 };

describe('limitsChanged', () => {
  it('is false when the same limits are re-sent', () => {
    expect(limitsChanged(stored, { tempMin: 18, tempMax: 25, rhMin: null, rhMax: 60 })).toBe(false);
  });

  it('is false when an absent limit is omitted rather than sent as null', () => {
    expect(limitsChanged(stored, { tempMin: 18, tempMax: 25, rhMax: 60 })).toBe(false);
  });

  it('is true when any one bound moves', () => {
    expect(limitsChanged(stored, { ...stored, tempMax: 24 })).toBe(true);
    expect(limitsChanged(stored, { ...stored, rhMin: 30 })).toBe(true);
  });

  it('is true when a stored bound is cleared, by null or by omission', () => {
    expect(limitsChanged(stored, { ...stored, rhMax: null })).toBe(true);
    expect(limitsChanged(stored, { tempMin: 18, tempMax: 25, rhMin: null })).toBe(true);
  });

  it('is false for a geometry-only payload against a room with no limits', () => {
    expect(limitsChanged({ tempMin: null, tempMax: null, rhMin: null, rhMax: null }, {})).toBe(false);
  });
});
