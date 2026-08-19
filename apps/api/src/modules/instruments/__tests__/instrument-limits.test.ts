import { describe, it, expect } from 'vitest';
import { instrumentLimits } from '../telemetry-overview.js';
import { parseLimitKeys, ALARM_LIMIT_KEYS_DEFAULT } from '@digilog/shared';

const keys = {
  temperatureHigh: parseLimitKeys(ALARM_LIMIT_KEYS_DEFAULT.temperatureHigh),
  temperatureLow: parseLimitKeys(ALARM_LIMIT_KEYS_DEFAULT.temperatureLow),
  humidityHigh: parseLimitKeys(ALARM_LIMIT_KEYS_DEFAULT.humidityHigh),
  humidityLow: parseLimitKeys(ALARM_LIMIT_KEYS_DEFAULT.humidityLow),
};

/**
 * The set point the dashboard shows must be the spec the alarm evaluator
 * enforces. These are the properties that keep the two the same thing.
 */
describe('instrumentLimits', () => {
  it('reads all four bounds from the attributes, low as min and high as max', () => {
    expect(instrumentLimits(keys, [
      { key: 'High Temperature Limit', value: '25' },
      { key: 'Low Temperature Limit', value: '18' },
      { key: 'High Humidity Limit', value: '60' },
      { key: 'Low Humidity Limit', value: '40' },
    ])).toEqual({ tempMin: 18, tempMax: 25, rhMin: 40, rhMax: 60 });
  });

  it('resolves the alias spelling this database actually holds', () => {
    // CWH-01/02/03 carry `High Temperature`, not `High Temperature Limit`.
    expect(instrumentLimits(keys, [
      { key: 'High Temperature', value: '23' },
      { key: 'Low Temperature', value: '18' },
    ])).toEqual({ tempMin: 18, tempMax: 23, rhMin: null, rhMax: null });
  });

  it('returns null when the instrument declares nothing, so the room can answer', () => {
    expect(instrumentLimits(keys, [])).toBeNull();
    expect(instrumentLimits(keys, [{ key: 'Slave ID', value: '3' }])).toBeNull();
  });

  it('leaves an undeclared bound UNBOUNDED rather than borrowing the room half of it', () => {
    // The whole point. The evaluator reads only these attributes, so a
    // temperature with no low bound is not checked below — and the table must
    // not paint a lower bound the alarm would never fire on.
    expect(instrumentLimits(keys, [{ key: 'High Temperature', value: '23' }]))
      .toEqual({ tempMin: null, tempMax: 23, rhMin: null, rhMax: null });
  });

  it('drops an inverted pair, matching the evaluator raising nothing for it', () => {
    // Low above high is a misconfiguration, not a permanent breach. Showing the
    // band would paint a range no reading can satisfy.
    expect(instrumentLimits(keys, [
      { key: 'High Temperature', value: '18' },
      { key: 'Low Temperature', value: '25' },
      { key: 'High Humidity', value: '60' },
      { key: 'Low Humidity', value: '40' },
    ])).toEqual({ tempMin: null, tempMax: null, rhMin: 40, rhMax: 60 });
  });

  it('returns null when every declared pair is inverted — nothing usable to show', () => {
    expect(instrumentLimits(keys, [
      { key: 'High Temperature', value: '18' },
      { key: 'Low Temperature', value: '25' },
    ])).toBeNull();
  });

  it('ignores a blank or non-numeric limit rather than reading it as zero', () => {
    expect(instrumentLimits(keys, [
      { key: 'High Temperature', value: '' },
      { key: 'Low Temperature', value: 'cold' },
    ])).toBeNull();
  });
});
