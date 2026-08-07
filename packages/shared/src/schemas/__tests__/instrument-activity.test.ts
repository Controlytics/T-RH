import { describe, it, expect } from 'vitest';
import { isInstrumentReporting, INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN } from '../config.js';

/**
 * "Active" on the instruments page means TELEMETRY IS ARRIVING — an observed
 * fact, not the admin enable/disable flag. Every row and every tile is coloured
 * on this, so a wrong answer is wrong everywhere at once.
 *
 * Two tiers, and the split is the point: an instrument that declares an
 * expected interval is judged against ITS OWN contract, so a probe reporting
 * every 30s and a rig read once a shift are both correctly called healthy. The
 * configured window is only the fallback for the ones that declare nothing.
 */
const NOW = new Date('2026-08-07T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

describe('isInstrumentReporting — declared interval', () => {
  it('is active inside the interval and its slack', () => {
    expect(isInstrumentReporting(ago(30 * SEC), 60, 1440, NOW)).toBe(true);
    // 2x slack: jitter and one retry must not flip the whole page.
    expect(isInstrumentReporting(ago(110 * SEC), 60, 1440, NOW)).toBe(true);
  });

  it('is inactive once the interval and its slack have passed', () => {
    expect(isInstrumentReporting(ago(5 * MIN), 60, 1440, NOW)).toBe(false);
  });

  // The configured window must NOT rescue an instrument that declared a tighter
  // contract — otherwise a 60s probe silent for an hour would read Active
  // because the site default is 24h.
  it('ignores the configured window when an interval is declared', () => {
    expect(isInstrumentReporting(ago(HOUR), 60, 1440, NOW)).toBe(false);
  });

  it('lets a slow reporter stay active where a fast one would not', () => {
    expect(isInstrumentReporting(ago(6 * HOUR), 86_400, 1440, NOW)).toBe(true);
    expect(isInstrumentReporting(ago(6 * HOUR), 60, 1440, NOW)).toBe(false);
  });
});

describe('isInstrumentReporting — configured window fallback', () => {
  it('uses the window when no interval is declared', () => {
    expect(isInstrumentReporting(ago(30 * MIN), null, 60, NOW)).toBe(true);
    expect(isInstrumentReporting(ago(90 * MIN), null, 60, NOW)).toBe(false);
  });

  it('honours a window the admin widened or narrowed', () => {
    expect(isInstrumentReporting(ago(20 * HOUR), null, 1440, NOW)).toBe(true);
    expect(isInstrumentReporting(ago(20 * HOUR), null, 15, NOW)).toBe(false);
  });

  it('defaults to 24 hours when no window is supplied', () => {
    expect(INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN).toBe(1440);
    expect(isInstrumentReporting(ago(23 * HOUR), null, undefined, NOW)).toBe(true);
    expect(isInstrumentReporting(ago(25 * HOUR), null, undefined, NOW)).toBe(false);
  });
});

describe('isInstrumentReporting — edges', () => {
  it('is inactive when it has never reported', () => {
    expect(isInstrumentReporting(null, 60, 1440, NOW)).toBe(false);
    expect(isInstrumentReporting(undefined, null, 1440, NOW)).toBe(false);
  });

  // A device whose clock runs ahead sends a future timestamp. Treating that as
  // infinitely stale would mark a healthy device inactive.
  it('treats a future timestamp as fresh', () => {
    expect(isInstrumentReporting(new Date(NOW.getTime() + 5 * MIN).toISOString(), 60, 1440, NOW)).toBe(true);
  });

  it('accepts a Date as well as a string', () => {
    expect(isInstrumentReporting(new Date(NOW.getTime() - MIN), 60, 1440, NOW)).toBe(true);
  });
});
