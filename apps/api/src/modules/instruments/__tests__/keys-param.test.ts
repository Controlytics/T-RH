import { describe, it, expect } from 'vitest';
import { parseKeysParam } from '../keys-param.js';

/**
 * The `keys` query parameter of the two history routes (widget data keys,
 * 2026-10-28): a comma list of telemetry keys, exactly as stored. Absent means
 * "no filter" — never "no keys".
 */
describe('parseKeysParam', () => {
  it('absent or blank is no filter', () => {
    expect(parseKeysParam(undefined)).toEqual({ keys: null });
    expect(parseKeysParam('')).toEqual({ keys: null });
    expect(parseKeysParam(' , ')).toEqual({ keys: null });
  });

  it('splits, trims, drops blanks and de-duplicates in order', () => {
    expect(parseKeysParam('p, t,,p')).toEqual({ keys: ['p', 't'] });
  });

  it('keeps case — `T` and `t` are two stored keys', () => {
    expect(parseKeysParam('T,t')).toEqual({ keys: ['T', 't'] });
  });

  it('refuses more than 20 keys', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `k${i}`).join(',');
    expect(parseKeysParam(twenty)).toEqual({ keys: twenty.split(',') });
    expect(parseKeysParam(`${twenty},k20`)).toEqual({ error: expect.stringMatching(/20/) });
  });

  it('refuses a key longer than 128 characters', () => {
    expect(parseKeysParam('k'.repeat(128))).toEqual({ keys: ['k'.repeat(128)] });
    expect(parseKeysParam('k'.repeat(129))).toEqual({ error: expect.stringMatching(/128/) });
  });
});
