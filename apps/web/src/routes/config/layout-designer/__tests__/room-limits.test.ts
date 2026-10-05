import { describe, it, expect } from 'vitest';
import { limitChanges, numOrNull } from '../room-limits';

/**
 * The browser's copy of the server's `limitsChanged` rule (DATA-11): the
 * designer asks for a reason exactly when the API would refuse the save
 * without one. Blank = null, null against null = unchanged.
 */
const stored = { tempMin: 18, tempMax: 25, rhMin: null, rhMax: 60 };
const form = { tempMin: '18', tempMax: '25', rhMin: '', rhMax: '60' };

describe('limitChanges', () => {
  it('re-sending the stored limits is no change', () => {
    expect(limitChanges(stored, form)).toEqual([]);
  });

  it('a moved bound is one labelled line with before and after', () => {
    expect(limitChanges(stored, { ...form, tempMax: '27' })).toEqual([
      { label: 'Max temperature (°C)', from: '25', to: '27' },
    ]);
  });

  it('clearing a bound counts, and setting an absent one counts', () => {
    expect(limitChanges(stored, { ...form, rhMax: '', rhMin: '30' })).toEqual([
      { label: 'Min humidity (%RH)', from: '', to: '30' },
      { label: 'Max humidity (%RH)', from: '60', to: '' },
    ]);
  });

  it('whitespace and a trailing zero do not count as a change', () => {
    expect(limitChanges(stored, { ...form, tempMin: ' 18.0 ' })).toEqual([]);
  });
});

describe('numOrNull', () => {
  it('blank and non-numeric are null; a number parses', () => {
    expect(numOrNull('')).toBeNull();
    expect(numOrNull('  ')).toBeNull();
    expect(numOrNull('abc')).toBeNull();
    expect(numOrNull('21.5')).toBe(21.5);
  });
});
