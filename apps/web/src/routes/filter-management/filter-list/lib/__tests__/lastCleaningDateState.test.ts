import { describe, expect, it } from 'vitest';
import {
  decodeLastCleaningDate,
  encodeLastCleaningDate,
  type LastCleaningDateState,
} from '../lastCleaningDateState';

describe('decodeLastCleaningDate', () => {
  it('returns empty + NA=false for null/undefined', () => {
    expect(decodeLastCleaningDate(null)).toEqual({ date: '', na: false });
    expect(decodeLastCleaningDate(undefined)).toEqual({ date: '', na: false });
  });

  it('returns empty + NA=true for the literal "NA"', () => {
    expect(decodeLastCleaningDate('NA')).toEqual({ date: '', na: true });
  });

  it('returns the ISO date + NA=false for a date string', () => {
    expect(decodeLastCleaningDate('2026-04-15')).toEqual({ date: '2026-04-15', na: false });
  });
});

describe('encodeLastCleaningDate', () => {
  it('returns "NA" when na is true (regardless of date)', () => {
    expect(encodeLastCleaningDate({ date: '', na: true })).toBe('NA');
    expect(encodeLastCleaningDate({ date: '2026-04-15', na: true })).toBe('NA');
  });

  it('returns undefined when na is false and date is empty', () => {
    expect(encodeLastCleaningDate({ date: '', na: false })).toBeUndefined();
  });

  it('returns the date string when na is false and date is set', () => {
    expect(encodeLastCleaningDate({ date: '2026-04-15', na: false })).toBe('2026-04-15');
  });
});

describe('NA toggle interaction', () => {
  it('clears the date when NA is checked', () => {
    const before: LastCleaningDateState = { date: '2026-04-15', na: false };
    const after: LastCleaningDateState = { ...before, na: true, date: '' };
    expect(encodeLastCleaningDate(after)).toBe('NA');
  });

  it('round-trips: decode(encode(s)) === s for canonical states', () => {
    const cases: LastCleaningDateState[] = [
      { date: '', na: false },
      { date: '', na: true },
      { date: '2026-04-15', na: false },
    ];
    for (const s of cases) {
      expect(decodeLastCleaningDate(encodeLastCleaningDate(s) ?? null)).toEqual(s);
    }
  });
});
