import { describe, it, expect } from 'vitest';
import {
  MIN_INSTRUMENTS_FOR_BAND, peakReporting, shouldDrawBand, sparseMessage, derivedNote, limitNote,
  type AggregatePoint,
} from '../aggregate-trend';

const pt = (instrumentCount: number): AggregatePoint =>
  ({ ts: '2026-08-28T10:00:00.000Z', min: 20, mean: 22, max: 24, instrumentCount });

describe('shouldDrawBand', () => {
  it('draws a band when enough instruments reported', () => {
    expect(shouldDrawBand([pt(3), pt(3)])).toBe(true);
  });

  it('does NOT draw a band for a single instrument', () => {
    // A spread across one instrument is not a spread. This is the whole reason the
    // rule exists: the endpoint's first live run found 1 of 101 instruments
    // reporting, and a band labelled "across 33 instruments" drawn from one sensor
    // is technically correct and practically a lie.
    expect(shouldDrawBand([pt(1), pt(1)])).toBe(false);
  });

  it('does NOT draw a band when nothing reported', () => {
    expect(shouldDrawBand([])).toBe(false);
  });

  it('judges on the PEAK, not the last bucket', () => {
    // One quiet bucket at the end of a window is normal at a 30-90s cadence.
    // Collapsing the whole chart for it would make the card flicker between two
    // presentations as readings arrive.
    expect(shouldDrawBand([pt(5), pt(5), pt(1)])).toBe(true);
    expect(peakReporting([pt(5), pt(5), pt(1)])).toBe(5);
  });

  it('uses the documented threshold', () => {
    expect(MIN_INSTRUMENTS_FOR_BAND).toBe(2);
  });
});

describe('sparseMessage', () => {
  it('names BOTH numbers, so the reader knows what they are not seeing', () => {
    expect(sparseMessage([pt(1)], 33)).toBe(
      'Only 1 of 33 instruments reported in this period — too few for a meaningful spread.',
    );
  });

  it('distinguishes "nothing reported" from "no instruments here"', () => {
    // Different facts with different fixes: one is a dead feed, the other an empty
    // selection. A single message for both would send someone looking in the wrong
    // place.
    expect(sparseMessage([], 33)).toContain('No readings in this period');
    expect(sparseMessage([], 0)).toBe('No instruments in this selection.');
  });
});

describe('derivedNote', () => {
  it('says plainly that the values are computed', () => {
    expect(derivedNote(33)).toContain('computed values, not stored readings');
    expect(derivedNote(33)).toContain('33 instruments');
  });

  it('reads correctly for a single instrument', () => {
    expect(derivedNote(1)).toContain('1 instrument per interval');
  });
});

describe('limitNote', () => {
  it('says nothing when the lines are drawn', () => {
    expect(limitNote({ min: 15, max: 25 }, false)).toBeNull();
  });

  it('explains the absence when the selection has mixed limits', () => {
    expect(limitNote(null, true)).toContain('different limits');
  });

  it('says NOTHING when nothing in the selection is bounded', () => {
    // Unbounded is not mixed. Announcing "these instruments have different limits"
    // where none of them has any would be untrue.
    expect(limitNote(null, false)).toBeNull();
  });
});
