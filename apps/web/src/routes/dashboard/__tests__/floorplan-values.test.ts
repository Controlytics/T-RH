import { describe, it, expect } from 'vitest';
import { tileValues } from '../floorplan-view';

/**
 * The colour of a reading chip on the floor plan (operator, 2026-09-22: "if in
 * limits green color, if its crossed or below the limits show red, if error
 * highlight with other color, if offline also show with other color").
 *
 * Green / red / VIOLET / amber — one tone per condition. The one this pins
 * hardest is ERROR: until 2026-09-22 a failed probe painted the breach red.
 */
type Row = Parameters<typeof tileValues>[0];
const words = { failure: 'Error', outOfRange: 'OL' };
const slot = (value: number | null) => (value === null ? null : { value, ts: '2026-09-22T10:00:00Z', key: 't' });
const base = (over: Partial<Row>): Row => ({
  temperature: slot(22.5),
  humidity: slot(45),
  limits: { tempMin: 18, tempMax: 27, rhMin: 30, rhMax: 60 },
  status: 'OK',
  decimals: { temperature: 1, humidity: 0 },
  ...over,
} as Row);

describe('tileValues — one tone per condition', () => {
  it('a reading inside its limits is green (OK), with the value printed', () => {
    expect(tileValues(base({}), words)).toEqual([
      { text: '22.5°', st: 'OK', bad: false },
      { text: '45%', st: 'OK', bad: false },
    ]);
  });

  it('a reading above or below a limit is red, and only that reading', () => {
    const v = tileValues(base({ temperature: slot(29), status: 'OUT_OF_SPEC' }), words);
    expect(v[0]).toEqual({ text: '29.0°', st: 'OUT_OF_SPEC', bad: true });
    // Humidity is inside its band: green, not red, although the instrument is OUT_OF_SPEC.
    expect(v[1]).toEqual({ text: '45%', st: 'OK', bad: false });
    expect(tileValues(base({ humidity: slot(12), status: 'OUT_OF_SPEC' }), words)[1].st).toBe('OUT_OF_SPEC');
  });

  it('a failed probe is ERROR (violet), never the breach red, printing the administered word', () => {
    const v = tileValues(base({ temperature: slot(null), sensorError: { temperature: true, humidity: false } }), words);
    expect(v[0]).toEqual({ text: 'Error', st: 'ERROR', bad: false });
    expect(v[1].st).toBe('OK');
  });

  it('a saturated probe is ERROR too, with its own word, and range wins over failure', () => {
    const v = tileValues(base({
      humidity: slot(null),
      sensorError: { temperature: false, humidity: true },
      rangeError: { temperature: false, humidity: true },
    }), words);
    expect(v[1]).toEqual({ text: 'OL', st: 'ERROR', bad: false });
  });

  it('an offline instrument prints its last readings in amber (STALE)', () => {
    const v = tileValues(base({ status: 'STALE' }), words);
    expect(v.map((x) => x.st)).toEqual(['STALE', 'STALE']);
  });

  it('a breach on an offline instrument is still red — the limit judgement outranks the age', () => {
    const v = tileValues(base({ status: 'STALE', temperature: slot(30) }), words);
    expect(v[0].st).toBe('OUT_OF_SPEC');
    expect(v[1].st).toBe('STALE');
  });

  it('a slot with no reading prints NA in grey, so a tile always shows both rows', () => {
    // Operator, 2026-09-22: "below the instrument ID temperature and humidity
    // data was not showing" — 98 of 100 instruments had never reported.
    const v = tileValues(base({ humidity: slot(null), status: 'PARTIAL' }), words);
    expect(v).toHaveLength(2);
    expect(v[0].st).toBe('PARTIAL');
    expect(v[1]).toEqual({ text: 'NA', st: 'NO_DATA', bad: false });
  });

  it('an instrument that has never reported prints two grey NA chips, not an empty tile', () => {
    const v = tileValues(base({ temperature: slot(null), humidity: slot(null), status: 'NO_DATA' }), words);
    expect(v.map((x) => [x.text, x.st])).toEqual([['NA', 'NO_DATA'], ['NA', 'NO_DATA']]);
  });
});
