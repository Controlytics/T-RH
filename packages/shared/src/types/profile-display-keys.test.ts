import { describe, it, expect } from 'vitest';
import {
  PROFILE_DISPLAY_KEYS_MAX, profileDisplayKeysSchema, coerceProfileDisplayKeys, displayKeysEqual,
} from './profile-display-keys.js';

const issues = (v: unknown) => {
  const r = profileDisplayKeysSchema.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};
const keys = (n: number) => Array.from({ length: n }, (_, k) => ({ source: 'telemetry' as const, key: `k${k}` }));

describe('profileDisplayKeysSchema', () => {
  it('accepts up to 12 telemetry keys with every display setting', () => {
    expect(PROFILE_DISPLAY_KEYS_MAX).toBe(12);
    expect(issues(keys(12))).toEqual([]);
    expect(issues([{ source: 'telemetry', key: 'p', label: 'Pressure', unit: 'kPa', decimals: 2, color: 5 }])).toEqual([]);
    expect(issues([])).toEqual([]);
  });

  it('refuses an attribute, a 13th key and a duplicate', () => {
    expect(issues([{ source: 'attribute', key: 'Firmware' }]))
      .toContain('The trend page shows readings — an attribute has no history');
    expect(issues(keys(13))).not.toHaveLength(0);
    expect(issues([{ source: 'telemetry', key: 'p' }, { source: 'telemetry', key: 'p' }])).not.toHaveLength(0);
    expect(issues([{ source: 'telemetry', key: 'p', decimals: 7 }])).not.toHaveLength(0);
  });
});

describe('coerceProfileDisplayKeys — the ONE reader, forgiving', () => {
  it('reads anything that is not a list as none', () => {
    expect(coerceProfileDisplayKeys(null)).toEqual([]);
    expect(coerceProfileDisplayKeys(undefined)).toEqual([]);
    expect(coerceProfileDisplayKeys('x')).toEqual([]);
    expect(coerceProfileDisplayKeys({})).toEqual([]);
  });

  it('keeps the good entries of a list with a bad one, the first of a duplicate, and at most 12', () => {
    expect(coerceProfileDisplayKeys([{ source: 'telemetry', key: 'p' }, { source: 'attribute', key: 'F' }, 7, { source: 'telemetry', key: 'q', label: 'Q' }]))
      .toEqual([{ source: 'telemetry', key: 'p' }, { source: 'telemetry', key: 'q', label: 'Q' }]);
    expect(coerceProfileDisplayKeys([{ source: 'telemetry', key: 'p', label: 'A' }, { source: 'telemetry', key: 'p', label: 'B' }]))
      .toEqual([{ source: 'telemetry', key: 'p', label: 'A' }]);
    expect(coerceProfileDisplayKeys(keys(20))).toHaveLength(12);
  });
});

describe('displayKeysEqual', () => {
  it('ignores object-key order and sees a changed label', () => {
    expect(displayKeysEqual([{ source: 'telemetry', key: 'p', label: 'P' }], JSON.parse('[{"label":"P","key":"p","source":"telemetry"}]'))).toBe(true);
    expect(displayKeysEqual([{ source: 'telemetry', key: 'p', label: 'P' }], [{ source: 'telemetry', key: 'p', label: 'Q' }])).toBe(false);
    expect(displayKeysEqual(null, [])).toBe(true);
  });
});
