import { describe, it, expect } from 'vitest';
import { isBreaching, decide, describeRule, type RuleShape, type Sample } from '../decide.js';

const rule = (over: Partial<RuleShape> = {}): RuleShape => ({
  id: 'r1', metric: 'TEMPERATURE', comparison: 'ABOVE',
  thresholdLow: null, thresholdHigh: 25, delaySeconds: 0, ...over,
});
const sample = (over: Partial<Sample> = {}): Sample => ({
  value: null, offline: false, breachingSince: null, ...over,
});
const NOW = new Date('2026-08-13T12:00:00Z');

describe('isBreaching — ABOVE', () => {
  it('breaches strictly above the threshold', () => {
    expect(isBreaching(rule(), sample({ value: 25.1 }))).toBe(true);
  });

  it('does NOT breach exactly at the threshold', () => {
    // Boundaries are IN spec, matching outOfSpec() for room limits. Off by one here
    // would alarm every compliant room sitting at its limit.
    expect(isBreaching(rule(), sample({ value: 25 }))).toBe(false);
  });

  it('does not breach below', () => {
    expect(isBreaching(rule(), sample({ value: 10 }))).toBe(false);
  });
});

describe('isBreaching — BELOW and OUTSIDE_RANGE', () => {
  it('BELOW breaches strictly under thresholdLow', () => {
    const r = rule({ comparison: 'BELOW', thresholdLow: 2, thresholdHigh: null });
    expect(isBreaching(r, sample({ value: 1.9 }))).toBe(true);
    expect(isBreaching(r, sample({ value: 2 }))).toBe(false);
  });

  it('OUTSIDE_RANGE breaches on either side but not at the boundaries', () => {
    const r = rule({ comparison: 'OUTSIDE_RANGE', thresholdLow: 18, thresholdHigh: 25 });
    expect(isBreaching(r, sample({ value: 17.9 }))).toBe(true);
    expect(isBreaching(r, sample({ value: 25.1 }))).toBe(true);
    expect(isBreaching(r, sample({ value: 18 }))).toBe(false);
    expect(isBreaching(r, sample({ value: 25 }))).toBe(false);
    expect(isBreaching(r, sample({ value: 21 }))).toBe(false);
  });

  it('honours a zero threshold', () => {
    // A 0 degree limit is a real cold-room spec; a falsy check would ignore it.
    const r = rule({ comparison: 'BELOW', thresholdLow: 0, thresholdHigh: null });
    expect(isBreaching(r, sample({ value: -0.5 }))).toBe(true);
    expect(isBreaching(r, sample({ value: 0 }))).toBe(false);
  });
});

describe('isBreaching — missing and malformed input', () => {
  it('a MISSING reading is not a breach', () => {
    // "No reading" is unknown, not out-of-spec. Treating it as a breach would raise a
    // LIMIT alarm every time a probe went quiet, making it indistinguishable from the
    // OFFLINE metric in the record.
    expect(isBreaching(rule(), sample({ value: null }))).toBe(false);
  });

  it('a non-finite reading is not a breach', () => {
    expect(isBreaching(rule(), sample({ value: Number.NaN }))).toBe(false);
    expect(isBreaching(rule(), sample({ value: Number.POSITIVE_INFINITY }))).toBe(false);
  });

  it('a rule with no threshold NEVER fires', () => {
    // A misconfigured rule that fires on every reading is worse than one that never
    // fires: the first teaches people to ignore alarms.
    expect(isBreaching(rule({ thresholdHigh: null }), sample({ value: 999 }))).toBe(false);
    expect(isBreaching(rule({ comparison: 'BELOW', thresholdLow: null }), sample({ value: -999 }))).toBe(false);
    expect(isBreaching(rule({ comparison: 'OUTSIDE_RANGE', thresholdLow: 18, thresholdHigh: null }), sample({ value: 999 }))).toBe(false);
  });
});

describe('isBreaching — OFFLINE', () => {
  it('breaches on the offline flag and ignores any value', () => {
    const r = rule({ metric: 'OFFLINE' });
    expect(isBreaching(r, sample({ offline: true, value: 21 }))).toBe(true);
    expect(isBreaching(r, sample({ offline: false, value: null }))).toBe(false);
  });
});

describe('decide — raise, hold, clear', () => {
  it('raises when breaching with no active alarm', () => {
    expect(decide(rule(), sample({ value: 26 }), false, NOW).action).toBe('raise');
  });

  it('HOLDS rather than re-raising when an alarm is already active', () => {
    // One excursion must produce ONE alarm, not one per evaluation cycle.
    expect(decide(rule(), sample({ value: 26 }), true, NOW).action).toBe('hold');
  });

  it('clears when the condition ends and an alarm is active', () => {
    expect(decide(rule(), sample({ value: 21 }), true, NOW).action).toBe('clear');
  });

  it('does nothing when not breaching and nothing is active', () => {
    expect(decide(rule(), sample({ value: 21 }), false, NOW).action).toBe('none');
  });
});

describe('decide — delaySeconds', () => {
  const delayed = rule({ delaySeconds: 300 });

  it('holds when the breach has only just started', () => {
    // A one-sample spike must not produce an alarm nobody can act on.
    const d = decide(delayed, sample({ value: 26, breachingSince: null }), false, NOW);
    expect(d.action).toBe('hold');
  });

  it('holds while the breach is younger than the delay', () => {
    const since = new Date(NOW.getTime() - 120_000); // 2 min of 5
    const d = decide(delayed, sample({ value: 26, breachingSince: since }), false, NOW);
    expect(d.action).toBe('hold');
    expect(d.reason).toContain('120s of 300s');
  });

  it('raises once the breach has persisted for the full delay', () => {
    const since = new Date(NOW.getTime() - 300_000);
    expect(decide(delayed, sample({ value: 26, breachingSince: since }), false, NOW).action).toBe('raise');
  });

  it('clears immediately regardless of the delay', () => {
    // A delay guards against raising noise, never against recovering. Holding a
    // cleared condition open would misreport the plant as still excursing.
    expect(decide(delayed, sample({ value: 21 }), true, NOW).action).toBe('clear');
  });
});

describe('describeRule', () => {
  it('reads as a sentence for each comparison', () => {
    expect(describeRule(rule())).toBe('temperature above 25');
    expect(describeRule(rule({ comparison: 'BELOW', thresholdLow: 2 }))).toBe('temperature below 2');
    expect(describeRule(rule({ comparison: 'OUTSIDE_RANGE', thresholdLow: 18, thresholdHigh: 25 })))
      .toBe('temperature outside 18 – 25');
    expect(describeRule(rule({ metric: 'OFFLINE' }))).toBe('instrument not reporting');
  });
});
