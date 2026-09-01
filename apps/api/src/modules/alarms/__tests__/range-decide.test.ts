import { describe, it, expect } from 'vitest';
import { decideRange, type RangeSample } from '../range-decide.js';
import { isOutOfRange, rangeLimitText, describeRangeFault } from '@digilog/shared';

const sample = (over: Partial<RangeSample> = {}): RangeSample => ({
  outOfRange: false, hasReading: true, isActive: true, hasOpenAlarm: false, ...over,
});

describe('isOutOfRange — range is NOT a limit', () => {
  it('flags a reading above the high bound and below the low bound', () => {
    expect(isOutOfRange(60, -40, 50)).toBe(true);
    expect(isOutOfRange(-50, -40, 50)).toBe(true);
  });

  it('treats the boundaries as IN range, matching the limit comparator', () => {
    // A probe declaring a 50 °C maximum can report exactly 50.
    expect(isOutOfRange(50, -40, 50)).toBe(false);
    expect(isOutOfRange(-40, -40, 50)).toBe(false);
  });

  it('leaves an undeclared bound UNBOUNDED, never a silent zero', () => {
    // A zero default would put every negative temperature out of range.
    expect(isOutOfRange(-100, null, 50)).toBe(false);
    expect(isOutOfRange(999, -40, null)).toBe(false);
    expect(isOutOfRange(999, null, null)).toBe(false);
  });

  it('refuses an inverted span rather than alarming forever', () => {
    expect(isOutOfRange(20, 50, -40)).toBe(false);
  });

  it('is not the RS485 question — a non-finite value is not out of range', () => {
    // Answering it here too would raise two alarms for one broken probe.
    expect(isOutOfRange(NaN, -40, 50)).toBe(false);
    expect(isOutOfRange(Infinity, -40, 50)).toBe(false);
  });

  it('does not confuse the SPEC with the SPAN', () => {
    // 30 °C breaches this installation's 25 limit but is well inside the 50
    // range: a genuine excursion, measured by a healthy probe. It must NOT be
    // called a sensor failure, or a real breach would be filed as hardware.
    expect(isOutOfRange(30, -40, 50)).toBe(false);
  });
});

describe('raising and clearing', () => {
  it('raises on an out-of-range reading', () => {
    expect(decideRange(sample({ outOfRange: true }))).toBe('raise');
  });

  it('does not raise on an in-range reading', () => {
    expect(decideRange(sample())).toBe('none');
  });

  it('does not raise when there is no usable reading', () => {
    // Silence, or an `NA` the RS485 source owns.
    expect(decideRange(sample({ hasReading: false, outOfRange: true }))).toBe('none');
  });

  it('does not raise for a decommissioned instrument', () => {
    expect(decideRange(sample({ outOfRange: true, isActive: false }))).toBe('none');
  });

  it('does not raise twice for one continuing fault', () => {
    expect(decideRange(sample({ outOfRange: true, hasOpenAlarm: true }))).toBe('none');
  });

  it('clears when an IN-RANGE number arrives', () => {
    expect(decideRange(sample({ hasOpenAlarm: true }))).toBe('clear');
  });

  it('HOLDS the alarm open when the instrument goes silent', () => {
    expect(decideRange(sample({ hasOpenAlarm: true, hasReading: false }))).toBe('none');
  });

  it('HOLDS when the probe breaks a SECOND way and starts sending NA', () => {
    // `hasReading` is false for a non-numeric value. Clearing here would declare
    // a saturated probe healthy at the moment it failed completely.
    expect(decideRange(sample({ hasOpenAlarm: true, hasReading: false, outOfRange: false }))).toBe('none');
  });

  it('clears an open alarm even on a decommissioned instrument', () => {
    expect(decideRange(sample({ hasOpenAlarm: true, isActive: false }))).toBe('clear');
  });
});

describe('how it reads back', () => {
  it('states the span in the Limit column', () => {
    expect(rangeLimitText(-40, 50)).toBe('-40 – 50');
    expect(rangeLimitText(null, 50)).toBe('> 50');
    expect(rangeLimitText(-40, null)).toBe('< -40');
    expect(rangeLimitText(null, null)).toBe('—');
  });

  it('names the reading and the span in one wording', () => {
    expect(describeRangeFault('TEMPERATURE', '60.0', -40, 50))
      .toBe('temperature 60.0 is outside the sensor range -40 to 50');
    expect(describeRangeFault('HUMIDITY', '120', 0, 100))
      .toBe('humidity 120 is outside the sensor range 0 to 100');
  });
});
