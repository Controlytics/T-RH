import { describe, it, expect } from 'vitest';
import { formatSetPoint, NOT_AVAILABLE } from '../set-point';

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
