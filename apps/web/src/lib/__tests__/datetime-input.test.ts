import { describe, it, expect } from 'vitest';
import {
  isoToDatetimeInput,
  isoToDateInput,
  datetimeInputToIso,
  startOfDayIso,
  endOfDayIso,
  toIsoIfNaiveDatetime,
  NAIVE_DATETIME_RE,
} from '../datetime-input';

const IST = 'Asia/Kolkata';
const NY = 'America/New_York';

describe('isoToDatetimeInput', () => {
  // The discriminating case: `.slice(0, 16)` yields '2026-07-15T09:30' here.
  // 15:00 is what the operator's IST clock actually says at that instant.
  it('renders the zone wall clock, not the sliced UTC clock', () => {
    expect(isoToDatetimeInput('2026-07-15T09:30:00.000Z', IST)).toBe('2026-07-15T15:00');
  });

  it('rolls the date over when the zone offset crosses midnight', () => {
    expect(isoToDatetimeInput('2026-07-15T20:00:00.000Z', IST)).toBe('2026-07-16T01:30');
    expect(isoToDatetimeInput('2026-07-15T02:00:00.000Z', NY)).toBe('2026-07-14T22:00');
  });

  it('returns empty for null/undefined/invalid input', () => {
    expect(isoToDatetimeInput(null, IST)).toBe('');
    expect(isoToDatetimeInput(undefined, IST)).toBe('');
    expect(isoToDatetimeInput('not-a-date', IST)).toBe('');
  });

  it('falls back to UTC for an unusable zone rather than throwing', () => {
    expect(isoToDatetimeInput('2026-07-15T09:30:00.000Z', 'Not/AZone')).toBe('2026-07-15T09:30');
  });
});

describe('datetimeInputToIso', () => {
  it('reads the wall clock in the given zone and emits an explicit-UTC instant', () => {
    expect(datetimeInputToIso('2026-07-15T15:00', IST)).toBe('2026-07-15T09:30:00.000Z');
  });

  // Guards the actual server contract: super-admin/routes.ts does
  // `new Date(body.updatedAt)`. A naive string would re-parse as server-local.
  it('emits a Z-marked string so a server-side new Date() cannot re-read it as local', () => {
    const iso = datetimeInputToIso('2026-07-15T15:00', IST);
    expect(iso.endsWith('Z')).toBe(true);
    expect(new Date(iso).toISOString()).toBe(iso);
  });

  it('resolves a zone with DST on both sides of the transition', () => {
    // EDT (−4) in July, EST (−5) in January.
    expect(datetimeInputToIso('2026-07-15T12:00', NY)).toBe('2026-07-15T16:00:00.000Z');
    expect(datetimeInputToIso('2026-01-15T12:00', NY)).toBe('2026-01-15T17:00:00.000Z');
  });

  it('accepts an optional seconds component', () => {
    expect(datetimeInputToIso('2026-07-15T15:00:30', IST)).toBe('2026-07-15T09:30:30.000Z');
  });

  it('returns empty for blank or unparseable input', () => {
    expect(datetimeInputToIso('', IST)).toBe('');
    expect(datetimeInputToIso(null, IST)).toBe('');
    expect(datetimeInputToIso('2026-07-15', IST)).toBe('');
  });
});

describe('round trip (M75)', () => {
  // The whole M75 defect in one assertion: display the stored instant, save it
  // back untouched, and the stored instant must not move.
  it('is lossless for a stored instant the operator does not retype', () => {
    const stored = '2026-07-15T09:30:00.000Z';
    const shown = isoToDatetimeInput(stored, IST);
    expect(datetimeInputToIso(shown, IST)).toBe(stored);
  });

  it('is lossless across zones and DST', () => {
    for (const zone of [IST, NY, 'UTC', 'Australia/Adelaide']) {
      for (const stored of [
        '2026-07-15T09:30:00.000Z',
        '2026-01-01T00:00:00.000Z',
        '2026-11-01T05:30:00.000Z', // inside the US fall-back window
        '2026-03-08T07:00:00.000Z', // inside the US spring-forward window
      ]) {
        expect(datetimeInputToIso(isoToDatetimeInput(stored, zone), zone)).toBe(stored);
      }
    }
  });

  it('stores the instant the operator actually picked', () => {
    // Operator picks 15:00 on their IST clock → 09:30Z, and reading it back
    // shows 15:00 again (not 09:30, which is what the old slice displayed).
    const picked = '2026-07-15T15:00';
    const stored = datetimeInputToIso(picked, IST);
    expect(stored).toBe('2026-07-15T09:30:00.000Z');
    expect(isoToDatetimeInput(stored, IST)).toBe(picked);
  });
});

describe('isoToDateInput', () => {
  it('returns the zone-local day, which can differ from the UTC day', () => {
    expect(isoToDateInput('2026-07-15T20:00:00.000Z', IST)).toBe('2026-07-16');
    expect(isoToDateInput('2026-07-15T09:30:00.000Z', IST)).toBe('2026-07-15');
    expect(isoToDateInput('2026-07-15T02:00:00.000Z', NY)).toBe('2026-07-14');
  });

  it('returns empty for missing input', () => {
    expect(isoToDateInput('', IST)).toBe('');
    expect(isoToDateInput(null, IST)).toBe('');
  });
});

describe('startOfDayIso / endOfDayIso (M60, M61)', () => {
  it('bounds the operator local day, not the UTC day', () => {
    // `new Date('2026-07-15').toISOString()` gives 2026-07-15T00:00:00.000Z —
    // 05:30 IST — so the old bounds cut 5.5h off the front and 18.5h off the back.
    expect(startOfDayIso('2026-07-15', IST)).toBe('2026-07-14T18:30:00.000Z');
    expect(endOfDayIso('2026-07-15', IST)).toBe('2026-07-15T18:29:59.999Z');
  });

  it('spans exactly one day, inclusive of its last millisecond', () => {
    const start = new Date(startOfDayIso('2026-07-15', IST)).getTime();
    const end = new Date(endOfDayIso('2026-07-15', IST)).getTime();
    expect(end - start).toBe(24 * 60 * 60 * 1000 - 1);
  });

  it('keeps a DST-shortened day whole (23h spring-forward day in New York)', () => {
    const start = new Date(startOfDayIso('2026-03-08', NY)).getTime();
    const end = new Date(endOfDayIso('2026-03-08', NY)).getTime();
    expect(end - start).toBe(23 * 60 * 60 * 1000 - 1);
  });

  it('keeps a DST-lengthened day whole (25h fall-back day in New York)', () => {
    const start = new Date(startOfDayIso('2026-11-01', NY)).getTime();
    const end = new Date(endOfDayIso('2026-11-01', NY)).getTime();
    expect(end - start).toBe(25 * 60 * 60 * 1000 - 1);
  });

  it('covers an event that falls in the local day but a different UTC day', () => {
    // 00:30 IST on the 15th = 2026-07-14T19:00Z. The old UTC-midnight "from"
    // bound (2026-07-15T00:00Z) excluded it from a 15th→15th query.
    const at = new Date('2026-07-14T19:00:00.000Z').getTime();
    expect(at).toBeGreaterThanOrEqual(new Date(startOfDayIso('2026-07-15', IST)).getTime());
    expect(at).toBeLessThanOrEqual(new Date(endOfDayIso('2026-07-15', IST)).getTime());
  });

  it('returns empty for a non date-only value', () => {
    expect(startOfDayIso('', IST)).toBe('');
    expect(endOfDayIso(null, IST)).toBe('');
    expect(startOfDayIso('2026-07-15T10:00', IST)).toBe('');
  });
});

describe('toIsoIfNaiveDatetime', () => {
  it('converts a naive datetime-local value', () => {
    expect(toIsoIfNaiveDatetime('2026-07-15T15:00', IST)).toBe('2026-07-15T09:30:00.000Z');
  });

  it('leaves an already-zoned ISO string untouched', () => {
    // The anchored regex is what prevents a double conversion here.
    expect(toIsoIfNaiveDatetime('2026-07-15T09:30:00.000Z', IST)).toBe('2026-07-15T09:30:00.000Z');
    expect(toIsoIfNaiveDatetime('2026-07-15T09:30:00+05:30', IST)).toBe('2026-07-15T09:30:00+05:30');
  });

  it('leaves non-datetime values untouched', () => {
    expect(toIsoIfNaiveDatetime('COMPLETED', IST)).toBe('COMPLETED');
    expect(toIsoIfNaiveDatetime('2026-07-15', IST)).toBe('2026-07-15');
    expect(toIsoIfNaiveDatetime(42, IST)).toBe(42);
    expect(toIsoIfNaiveDatetime(true, IST)).toBe(true);
    expect(toIsoIfNaiveDatetime('', IST)).toBe('');
  });
});

describe('NAIVE_DATETIME_RE', () => {
  it('matches only unzoned wall-clock datetimes', () => {
    expect(NAIVE_DATETIME_RE.test('2026-07-15T15:00')).toBe(true);
    expect(NAIVE_DATETIME_RE.test('2026-07-15T15:00:30')).toBe(true);
    expect(NAIVE_DATETIME_RE.test('2026-07-15T15:00:00.000Z')).toBe(false);
    expect(NAIVE_DATETIME_RE.test('2026-07-15T15:00Z')).toBe(false);
    expect(NAIVE_DATETIME_RE.test('2026-07-15T15:00+05:30')).toBe(false);
    expect(NAIVE_DATETIME_RE.test('2026-07-15')).toBe(false);
  });
});
