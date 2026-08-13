import { describe, it, expect } from 'vitest';
import { formatSetPoint, outOfSpec, NOT_AVAILABLE } from '../set-point';

describe('formatSetPoint', () => {
  it('renders a range when both bounds exist', () => {
    expect(formatSetPoint(18, 25, 1)).toBe('18.0 - 25.0');
  });

  it('renders NMT when only a maximum exists', () => {
    expect(formatSetPoint(null, 25, 1)).toBe('NMT 25.0');
  });

  it('renders NLT when only a minimum exists', () => {
    expect(formatSetPoint(18, null, 1)).toBe('NLT 18.0');
  });

  it('renders NA when the room has no specification', () => {
    // All four bounds NULL is legitimate — a corridor has no spec — so this is a
    // real answer, not an error.
    expect(formatSetPoint(null, null, 1)).toBe(NOT_AVAILABLE);
  });

  it('renders NA for an unplaced instrument (undefined bounds)', () => {
    expect(formatSetPoint(undefined, undefined, 1)).toBe(NOT_AVAILABLE);
  });

  it('honours the configured decimal places', () => {
    expect(formatSetPoint(18.25, 25.5, 0)).toBe('18 - 26');
    expect(formatSetPoint(18.25, 25.5, 2)).toBe('18.25 - 25.50');
  });

  it('treats zero as a real bound, not as absent', () => {
    // A 0 °C minimum is a legitimate cold-room spec; a falsy check would drop it
    // and silently show NMT instead of a range.
    expect(formatSetPoint(0, 8, 1)).toBe('0.0 - 8.0');
    expect(formatSetPoint(0, null, 1)).toBe('NLT 0.0');
  });

  it('ignores NaN and Infinity rather than printing them', () => {
    expect(formatSetPoint(Number.NaN, Number.NaN, 1)).toBe(NOT_AVAILABLE);
    expect(formatSetPoint(Number.NEGATIVE_INFINITY, 25, 1)).toBe('NMT 25.0');
  });
});

describe('outOfSpec', () => {
  it('is false inside the range, at either boundary', () => {
    // Boundaries are IN spec. A room specified 18-25 is not breached at exactly
    // 25.0, and an off-by-one here would flag every compliant room at its limit.
    expect(outOfSpec(21, 18, 25)).toBe(false);
    expect(outOfSpec(18, 18, 25)).toBe(false);
    expect(outOfSpec(25, 18, 25)).toBe(false);
  });

  it('is true beyond either bound', () => {
    expect(outOfSpec(25.1, 18, 25)).toBe(true);
    expect(outOfSpec(17.9, 18, 25)).toBe(true);
  });

  it('treats a NULL bound as not checked, not as zero', () => {
    expect(outOfSpec(-40, null, 25)).toBe(false);
    expect(outOfSpec(900, 18, null)).toBe(false);
    expect(outOfSpec(900, null, null)).toBe(false);
  });

  it('honours a zero bound', () => {
    // A 0 degree minimum is a real cold-room spec; a falsy check would ignore it.
    expect(outOfSpec(-0.5, 0, 8)).toBe(true);
    expect(outOfSpec(0, 0, 8)).toBe(false);
  });

  it('is false for a missing or non-finite reading, not true', () => {
    // No reading is "cannot confirm", reported as NA. Calling it a breach would
    // raise a limit alarm for a probe that has simply gone quiet.
    expect(outOfSpec(null, 18, 25)).toBe(false);
    expect(outOfSpec(undefined, 18, 25)).toBe(false);
    expect(outOfSpec(Number.NaN, 18, 25)).toBe(false);
    expect(outOfSpec(Number.POSITIVE_INFINITY, 18, 25)).toBe(false);
  });
});
