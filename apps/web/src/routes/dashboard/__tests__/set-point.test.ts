import { describe, it, expect } from 'vitest';
import { formatSetPoint, outOfSpec, NOT_AVAILABLE, quantityVerdict } from '../set-point';

const WORDS = { failure: 'Error', outOfRange: 'OL' };

describe('quantityVerdict — the ONE per-quantity verdict (band gauge + widgets)', () => {
  it('no reading is No data', () => {
    expect(quantityVerdict({ value: null, min: 18, max: 27 }, WORDS)).toEqual({ status: 'NO_DATA', assessed: true, fault: null });
  });

  it('a breach is Out of limit, whatever the instrument says', () => {
    expect(quantityVerdict({ value: 30, min: 18, max: 27, instrumentStatus: 'STALE' }, WORDS).status).toBe('OUT_OF_SPEC');
  });

  it('only STALE is inherited from the instrument', () => {
    expect(quantityVerdict({ value: 21, min: 18, max: 27, instrumentStatus: 'STALE' }, WORDS).status).toBe('STALE');
    expect(quantityVerdict({ value: 21, min: 18, max: 27, instrumentStatus: 'OUT_OF_SPEC' }, WORDS).status).toBe('OK');
    expect(quantityVerdict({ value: 21, min: 18, max: 27, instrumentStatus: 'PARTIAL' }, WORDS).status).toBe('OK');
  });

  it('a reading with no bound at all is not assessed', () => {
    expect(quantityVerdict({ value: 21, min: null, max: null }, WORDS)).toEqual({ status: 'OK', assessed: false, fault: null });
    expect(quantityVerdict({ value: 21, min: null, max: 27 }, WORDS).assessed).toBe(true);
  });

  it('a faulted reading is not a reading: the fault word, never Out of limit', () => {
    expect(quantityVerdict({ value: 60, min: 18, max: 27, rangeError: true }, WORDS))
      .toEqual({ status: 'NO_DATA', assessed: true, fault: 'OL' });
    expect(quantityVerdict({ value: 60, min: 18, max: 27, sensorError: true }, WORDS).fault).toBe('Error');
  });
});

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

  // Operator, 2026-10-03: "text is included in limits … in dashboard show the
  // same text only". The server sends the attribute's text beside the number
  // (`limitText`); the text prints in the number's place, verbatim.
  describe('a bound carrying text', () => {
    it('prints the text in place of the number, keeping the NMT / NLT word', () => {
      expect(formatSetPoint(null, 60, 0, { max: '60 (For Reference)' })).toBe('NMT 60 (For Reference)');
      expect(formatSetPoint(30, null, 0, { min: '30 min' })).toBe('NLT 30 min');
    });

    it('mixes a text bound and a numeric bound in one range', () => {
      expect(formatSetPoint(18, 27, 1, { max: '27 (For Reference)' })).toBe('18.0 - 27 (For Reference)');
    });

    it('never captions a bound that is not in force', () => {
      // A text for a null bound is a stale caller; the server nulls both together.
      expect(formatSetPoint(null, null, 1, { max: '60 (For Reference)' })).toBe(NOT_AVAILABLE);
      expect(formatSetPoint(18, null, 1, { max: '60 (For Reference)' })).toBe('NLT 18.0');
    });

    it('a null text prints the number at the precision, as before', () => {
      expect(formatSetPoint(18, 25, 1, { min: null, max: null })).toBe('18.0 - 25.0');
    });
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
