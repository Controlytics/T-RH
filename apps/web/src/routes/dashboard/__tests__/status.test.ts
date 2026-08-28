import { describe, it, expect } from 'vitest';
import { statusClasses, readingAge, oldestReadingTs } from '../status';
import { STATUS_RANK, type InstrumentStatus } from '@digilog/shared';

const ALL = Object.keys(STATUS_RANK) as InstrumentStatus[];

describe('statusClasses', () => {
  it('covers every status — a new status must not fall through to undefined', () => {
    for (const s of ALL) {
      const c = statusClasses(s);
      expect(c.label).toBeTruthy();
      expect(c.dot).toBeTruthy();
    }
  });

  it('gives OUT_OF_SPEC red and OK emerald', () => {
    expect(statusClasses('OUT_OF_SPEC').dot).toContain('red');
    expect(statusClasses('OK').dot).toContain('emerald');
  });

  it('gives STALE and PARTIAL amber — both mean "cannot confirm", not "bad"', () => {
    expect(statusClasses('STALE').dot).toContain('amber');
    expect(statusClasses('PARTIAL').dot).toContain('amber');
  });

  it('gives NO_DATA slate, distinct from every other colour', () => {
    expect(statusClasses('NO_DATA').dot).toContain('slate');
  });

  it('labels are human sentences, not enum names', () => {
    expect(statusClasses('OUT_OF_SPEC').label).toBe('Out of limit');
    expect(statusClasses('NO_DATA').label).toBe('No data');
  });

  it('distinguishes STALE from PARTIAL by label even though they share a colour', () => {
    expect(statusClasses('STALE').label).not.toBe(statusClasses('PARTIAL').label);
  });
});

describe('readingAge', () => {
  const now = new Date('2026-08-11T12:00:00Z').getTime();
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('says Never for a missing timestamp', () => {
    expect(readingAge(null, now)).toBe('Never');
    expect(readingAge(undefined, now)).toBe('Never');
  });

  it('reports seconds, minutes, hours and days', () => {
    expect(readingAge(ago(12_000), now)).toBe('12s ago');
    expect(readingAge(ago(5 * 60_000), now)).toBe('5m ago');
    expect(readingAge(ago(4 * 3_600_000), now)).toBe('4h ago');
    expect(readingAge(ago(3 * 86_400_000), now)).toBe('3d ago');
  });

  it('clamps a future timestamp to 0 rather than showing a negative age', () => {
    // A device whose clock runs ahead must not render "-30s ago".
    expect(readingAge(new Date(now + 30_000).toISOString(), now)).toBe('0s ago');
  });
});

describe('oldestReadingTs', () => {
  const T = (iso: string) => ({ ts: iso });

  it('returns the OLDER of the two slots', () => {
    // A different question from the one the Status column asks. That one uses the
    // LATEST timestamp — "are we hearing from this instrument at all". This one
    // drives the "As of" column — "how stale might the numbers on this row be" —
    // and the freshest of two values cannot answer it. A row whose humidity
    // arrived a second ago and whose temperature stopped an hour ago IS an hour
    // stale in the only sense the reading columns care about.
    expect(oldestReadingTs(T('2026-08-28T09:00:00Z'), T('2026-08-28T10:00:00Z')))
      .toBe('2026-08-28T09:00:00Z');
    expect(oldestReadingTs(T('2026-08-28T10:00:00Z'), T('2026-08-28T09:00:00Z')))
      .toBe('2026-08-28T09:00:00Z');
  });

  it('uses whichever slot exists when only one does', () => {
    expect(oldestReadingTs(T('2026-08-28T09:00:00Z'), null)).toBe('2026-08-28T09:00:00Z');
    expect(oldestReadingTs(null, T('2026-08-28T09:00:00Z'))).toBe('2026-08-28T09:00:00Z');
  });

  it('returns null when the instrument has reported neither', () => {
    // readingAge(null) renders "Never", which is exactly what an instrument that
    // has never reported should show — not a blank that reads as "fine".
    expect(oldestReadingTs(null, null)).toBeNull();
    expect(oldestReadingTs(undefined, undefined)).toBeNull();
    expect(readingAge(oldestReadingTs(null, null))).toBe('Never');
  });
});
