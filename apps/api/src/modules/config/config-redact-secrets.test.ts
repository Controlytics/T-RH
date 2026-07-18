import { describe, it, expect } from 'vitest';
import { redactConfigSecrets } from './config.service.js';

describe('redactConfigSecrets', () => {
  it('drops declared-secret keys, keeps the rest', () => {
    expect(redactConfigSecrets({ host: 'smtp', password: 's3cret', port: 587 }, new Set(['password'])))
      .toEqual({ host: 'smtp', port: 587 });
  });
  it('returns non-objects and arrays unchanged', () => {
    expect(redactConfigSecrets(null, new Set(['password']))).toBe(null);
    expect(redactConfigSecrets([1, 2], new Set(['password']))).toEqual([1, 2]);
  });
  it('no secret keys → unchanged shape', () => {
    expect(redactConfigSecrets({ a: 1 }, new Set())).toEqual({ a: 1 });
  });
});
