// Pin a TZ ahead of UTC BEFORE importing anything that touches Date, so the
// discriminating "UTC off-by-one" case is meaningful. Guarded below in case a
// platform doesn't honour a runtime TZ change.
process.env.TZ = 'Asia/Kolkata'; // UTC+5:30

import { describe, it, expect } from 'vitest';
import { toLocalDateString } from '../helpers';

/**
 * Regression tests for the lastCleaningDate UTC off-by-one fix (2026-07-09 QA).
 * A cleaning completed near local midnight was stamped a day early because the
 * stamp used `completedAt.toISOString().slice(0,10)` (the UTC day).
 */
describe('toLocalDateString', () => {
  it('returns the LOCAL calendar day, zero-padded', () => {
    // Constructed from LOCAL components; getFullYear/getMonth/getDate read them
    // back, so these are deterministic in any runner TZ.
    expect(toLocalDateString(new Date(2026, 0, 5, 23, 59, 0))).toBe('2026-01-05'); // Jan 5, 23:59 local
    expect(toLocalDateString(new Date(2026, 11, 31, 0, 30, 0))).toBe('2026-12-31'); // Dec 31, 00:30 local
  });

  it('uses the local day, not the UTC day, near local midnight (the bug it fixes)', () => {
    const d = new Date('2026-07-08T20:30:00Z'); // = 2026-07-09 02:00 IST
    // Only assert the discriminating case if the IST pin actually took effect.
    if (d.getDate() === 9) {
      expect(toLocalDateString(d)).toBe('2026-07-09'); // local day (fixed)
      expect(d.toISOString().slice(0, 10)).toBe('2026-07-08'); // the OLD buggy value
    }
  });
});
