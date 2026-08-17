import { describe, it, expect } from 'vitest';
import { limitsFor } from '../load-limits.js';
import { parseLimitKeys, ALARM_LIMIT_KEYS_DEFAULT } from '@digilog/shared';

const keys = {
  temperatureHigh: parseLimitKeys(ALARM_LIMIT_KEYS_DEFAULT.temperatureHigh),
  temperatureLow: parseLimitKeys(ALARM_LIMIT_KEYS_DEFAULT.temperatureLow),
  humidityHigh: parseLimitKeys(ALARM_LIMIT_KEYS_DEFAULT.humidityHigh),
  humidityLow: parseLimitKeys(ALARM_LIMIT_KEYS_DEFAULT.humidityLow),
};

describe('limitsFor', () => {
  it('reads all four limits from attributes', () => {
    const { limits } = limitsFor(keys, [
      { key: 'High Temperature Limit', value: '25' },
      { key: 'Low Temperature Limit', value: '18' },
      { key: 'High Humidity Limit', value: '60' },
      { key: 'Low Humidity Limit', value: '40' },
    ]);
    expect(limits).toEqual({
      temperatureHigh: 25, temperatureLow: 18, humidityHigh: 60, humidityLow: 40,
    });
  });

  it('resolves the alias spelling that exists in the live database', () => {
    const { limits } = limitsFor(keys, [{ key: 'Low Temperature', value: '18' }]);
    expect(limits.temperatureLow).toBe(18);
  });

  it('leaves a bound null when the attribute is absent or unparseable', () => {
    const { limits } = limitsFor(keys, [
      { key: 'High Temperature Limit', value: 'warm' },
      { key: 'Slave ID', value: '3' },
    ]);
    expect(limits.temperatureHigh).toBeNull();
    expect(limits.temperatureLow).toBeNull();
  });

  it('reports which attribute key each limit came from, for the snapshot', () => {
    const { attributeKeys } = limitsFor(keys, [{ key: 'High Temperature', value: '25' }]);
    expect(attributeKeys.temperatureHigh).toBe('High Temperature');
    expect(attributeKeys.temperatureLow).toBeNull();
  });
});
