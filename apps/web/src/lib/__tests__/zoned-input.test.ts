import { describe, it, expect } from 'vitest';
import { isoToZonedInput, zonedInputToIso } from '../zoned-input';

/**
 * Every zone is named explicitly, so these hold on any host clock (this
 * laptop is IST; CI is UTC). Audit 2026-10-12, findings 4 and 11.
 */
describe('isoToZonedInput', () => {
  it('shows an instant as wall-clock text in the configured zone', () => {
    expect(isoToZonedInput('2026-10-12T00:00:00.000Z', 'Asia/Kolkata')).toBe('2026-10-12T05:30');
    expect(isoToZonedInput('2026-10-12T00:00:00.000Z', 'America/New_York')).toBe('2026-10-11T20:00');
    expect(isoToZonedInput('2026-10-12T00:00:00.000Z', 'UTC')).toBe('2026-10-12T00:00');
  });

  it('prints midnight as 00, not 24', () => {
    expect(isoToZonedInput('2026-10-11T18:30:00.000Z', 'Asia/Kolkata')).toBe('2026-10-12T00:00');
  });

  it('is empty for nothing or garbage', () => {
    expect(isoToZonedInput('', 'Asia/Kolkata')).toBe('');
    expect(isoToZonedInput('not a date', 'Asia/Kolkata')).toBe('');
  });

  it('an unknown zone prints in UTC, as the formatter does', () => {
    expect(isoToZonedInput('2026-10-12T00:00:00.000Z', 'Mars/Olympus')).toBe('2026-10-12T00:00');
  });
});

describe('zonedInputToIso', () => {
  it('reads typed wall-clock text in the configured zone', () => {
    expect(zonedInputToIso('2026-10-12T05:30', 'Asia/Kolkata')).toBe('2026-10-12T00:00:00.000Z');
    expect(zonedInputToIso('2026-10-11T20:00', 'America/New_York')).toBe('2026-10-12T00:00:00.000Z');
  });

  it('takes the offset in force on THAT date, either side of a DST change', () => {
    expect(zonedInputToIso('2026-01-15T12:00', 'America/New_York')).toBe('2026-01-15T17:00:00.000Z');
    expect(zonedInputToIso('2026-07-15T12:00', 'America/New_York')).toBe('2026-07-15T16:00:00.000Z');
    // The morning of the spring-forward day, after the jump.
    expect(zonedInputToIso('2026-03-08T12:00', 'America/New_York')).toBe('2026-03-08T16:00:00.000Z');
  });

  it('round-trips with isoToZonedInput', () => {
    for (const tz of ['Asia/Kolkata', 'America/New_York', 'Europe/London', 'Australia/Adelaide']) {
      const iso = '2026-10-12T07:45:00.000Z';
      expect(zonedInputToIso(isoToZonedInput(iso, tz), tz)).toBe(iso);
    }
  });

  it('is undefined for nothing or garbage', () => {
    expect(zonedInputToIso('', 'Asia/Kolkata')).toBeUndefined();
    expect(zonedInputToIso('2026-10-12', 'Asia/Kolkata')).toBeUndefined();
    expect(zonedInputToIso('yesterday', 'Asia/Kolkata')).toBeUndefined();
  });
});
