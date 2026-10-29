import { describe, it, expect } from 'vitest';
import { parseUuidList } from '../uuid-list.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('parseUuidList', () => {
  it('absent is no filter', () => {
    expect(parseUuidList(undefined, 200)).toEqual({});
  });
  it('present but empty selects nothing', () => {
    expect(parseUuidList('', 200)).toEqual({ ids: [] });
  });
  it('trims, drops empty entries and deduplicates', () => {
    expect(parseUuidList(` ${A} ,, ${B},${A}`, 200)).toEqual({ ids: [A, B] });
  });
  it('a non-uuid entry is an error', () => {
    expect(parseUuidList(`${A},nope`, 200)).toEqual({ error: 'instrumentIds must be instrument ids' });
  });
  it('more than max is an error', () => {
    expect(parseUuidList(`${A},${B}`, 1)).toEqual({ error: 'At most 1 instrumentIds' });
    expect(parseUuidList(`${A},${B}`, 2)).toEqual({ ids: [A, B] });
  });
});
