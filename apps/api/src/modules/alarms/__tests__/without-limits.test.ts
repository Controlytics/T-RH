import { describe, it, expect } from 'vitest';
import { countWithoutLimits } from '../load-limits.js';
import { parseLimitKeys, ALARM_LIMIT_KEYS_DEFAULT } from '@digilog/shared';

const keys = {
  temperatureHigh: parseLimitKeys(ALARM_LIMIT_KEYS_DEFAULT.temperatureHigh),
  temperatureLow: parseLimitKeys(ALARM_LIMIT_KEYS_DEFAULT.temperatureLow),
  humidityHigh: parseLimitKeys(ALARM_LIMIT_KEYS_DEFAULT.humidityHigh),
  humidityLow: parseLimitKeys(ALARM_LIMIT_KEYS_DEFAULT.humidityLow),
};

describe('countWithoutLimits', () => {
  it('counts an instrument with no usable limit at all', () => {
    const out = countWithoutLimits(
      [{ code: 'CWH-01', attributes: [{ key: 'Slave ID', value: '3' }] }],
      keys,
    );
    expect(out).toEqual({ count: 1, codes: ['CWH-01'] });
  });

  it('does not count an instrument with even one usable limit', () => {
    const out = countWithoutLimits(
      [{ code: 'CWH-02', attributes: [{ key: 'High Temperature Limit', value: '25' }] }],
      keys,
    );
    expect(out).toEqual({ count: 0, codes: [] });
  });

  it('counts an instrument whose only limit is unparseable', () => {
    // The dangerous case: the operator believes it is configured.
    const out = countWithoutLimits(
      [{ code: 'CWH-03', attributes: [{ key: 'High Temperature Limit', value: 'warm' }] }],
      keys,
    );
    expect(out.count).toBe(1);
  });

  it('counts an instrument whose limits are inverted', () => {
    const out = countWithoutLimits(
      [{
        code: 'CWH-04',
        attributes: [
          { key: 'High Temperature Limit', value: '20' },
          { key: 'Low Temperature Limit', value: '30' },
        ],
      }],
      keys,
    );
    expect(out.count).toBe(1);
  });

  it('caps the code list at 50 while keeping the true count', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ code: `I-${i}`, attributes: [] }));
    const out = countWithoutLimits(many, keys);
    expect(out.count).toBe(60);
    expect(out.codes).toHaveLength(50);
  });
});
