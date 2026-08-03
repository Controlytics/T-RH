import { describe, it, expect } from 'vitest';
import { evaluate, numericValue, type ThresholdSpec } from '../threshold-evaluator.js';

const spec = (over: Partial<ThresholdSpec>): ThresholdSpec => ({
  id: 't1', key: 'temp', operator: 'GT', instrumentName: 'Chamber A',
  limit: 100, limitLow: null, limitHigh: null,
  hysteresis: 0, severity: 'MAJOR', ...over,
});

describe('numericValue', () => {
  it('accepts numbers and numeric strings', () => {
    expect(numericValue(21.5)).toBe(21.5);
    expect(numericValue('21.5')).toBe(21.5);
  });
  it('rejects non-numeric values rather than coercing them', () => {
    // Boolean/null/object readings are real (STATUS payloads), and Number(false)
    // is 0 — which would silently breach any `LT` threshold above zero.
    expect(numericValue(false)).toBeNull();
    expect(numericValue(null)).toBeNull();
    expect(numericValue('warm')).toBeNull();
    expect(numericValue({ v: 1 })).toBeNull();
  });
});

describe('evaluate — operators', () => {
  it('GT breaches strictly above the limit', () => {
    expect(evaluate(spec({}), 101, false)).toBe('BREACH');
    expect(evaluate(spec({}), 100, false)).toBe('NEUTRAL');
  });
  it('GTE breaches at the limit', () => {
    expect(evaluate(spec({ operator: 'GTE' }), 100, false)).toBe('BREACH');
  });
  it('LT breaches strictly below the limit', () => {
    expect(evaluate(spec({ operator: 'LT' }), 99, false)).toBe('BREACH');
    expect(evaluate(spec({ operator: 'LT' }), 100, false)).toBe('NEUTRAL');
  });
  it('LTE breaches at the limit', () => {
    expect(evaluate(spec({ operator: 'LTE' }), 100, false)).toBe('BREACH');
  });
  it('EQ and NEQ compare exactly', () => {
    expect(evaluate(spec({ operator: 'EQ' }), 100, false)).toBe('BREACH');
    expect(evaluate(spec({ operator: 'EQ' }), 99, false)).toBe('NEUTRAL');
    expect(evaluate(spec({ operator: 'NEQ' }), 99, false)).toBe('BREACH');
    expect(evaluate(spec({ operator: 'NEQ' }), 100, false)).toBe('NEUTRAL');
  });
  it('OUT_OF_RANGE breaches outside either bound', () => {
    const s = spec({ operator: 'OUT_OF_RANGE', limit: null, limitLow: 10, limitHigh: 20 });
    expect(evaluate(s, 9, false)).toBe('BREACH');
    expect(evaluate(s, 21, false)).toBe('BREACH');
    expect(evaluate(s, 15, false)).toBe('NEUTRAL');
  });
});

describe('evaluate — recovery and hysteresis', () => {
  it('reports RECOVERED only when an alarm is open', () => {
    expect(evaluate(spec({}), 50, true)).toBe('RECOVERED');
    expect(evaluate(spec({}), 50, false)).toBe('NEUTRAL');
  });
  it('holds an open GT alarm inside the dead-band', () => {
    // limit 100, hysteresis 5 -> must fall to <= 95 to count as recovered.
    const s = spec({ hysteresis: 5 });
    expect(evaluate(s, 97, true)).toBe('NEUTRAL');   // in the band: neither breach nor recovery
    expect(evaluate(s, 95, true)).toBe('RECOVERED');
    expect(evaluate(s, 101, true)).toBe('BREACH');   // re-breach while open
  });
  it('holds an open LT alarm inside the dead-band', () => {
    const s = spec({ operator: 'LT', hysteresis: 5 });
    expect(evaluate(s, 103, true)).toBe('NEUTRAL');
    expect(evaluate(s, 105, true)).toBe('RECOVERED');
  });
  it('applies hysteresis inward from both OUT_OF_RANGE bounds', () => {
    const s = spec({ operator: 'OUT_OF_RANGE', limit: null, limitLow: 10, limitHigh: 20, hysteresis: 2 });
    expect(evaluate(s, 11, true)).toBe('NEUTRAL');     // above low bound but inside the band
    expect(evaluate(s, 12, true)).toBe('RECOVERED');
    expect(evaluate(s, 18, true)).toBe('RECOVERED');
    expect(evaluate(s, 19, true)).toBe('NEUTRAL');
  });
  it('treats hysteresis as zero for EQ and NEQ', () => {
    // A dead-band around an equality test is meaningless; recovery is exact.
    expect(evaluate(spec({ operator: 'EQ', hysteresis: 5 }), 99, true)).toBe('RECOVERED');
  });
});
