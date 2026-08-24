import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readExtraKeys, writeExtraKeys } from '../use-extra-keys';

beforeEach(() => localStorage.clear());

describe('extra key persistence', () => {
  it('returns an empty list when nothing is stored', () => {
    expect(readExtraKeys('abc')).toEqual([]);
  });
  it('round-trips keys per instrument', () => {
    writeExtraKeys('abc', ['co2']);
    expect(readExtraKeys('abc')).toEqual(['co2']);
    expect(readExtraKeys('def')).toEqual([]);
  });
  it('returns an empty list rather than throwing on malformed stored JSON', () => {
    localStorage.setItem('digilog.trendKeys.abc', '{not json');
    expect(readExtraKeys('abc')).toEqual([]);
  });
  it('returns an empty list when localStorage itself throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readExtraKeys('abc')).toEqual([]);
    spy.mockRestore();
  });
});
