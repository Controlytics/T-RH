import { describe, it, expect } from 'vitest';
import { parseWritableKeys, splitWritable, attributeValueOf } from '../attribute-report.js';

/** The pure half of the device → platform attribute path (2026-09-05). */
describe('parseWritableKeys', () => {
  it('blank or missing = any key', () => {
    expect(parseWritableKeys(undefined)).toBeNull();
    expect(parseWritableKeys('')).toBeNull();
    expect(parseWritableKeys('  \n \n')).toBeNull();
  });
  it('one key per line, trimmed', () => {
    expect([...parseWritableKeys(' Location \r\nMake\n\n')!]).toEqual(['Location', 'Make']);
  });
});

describe('attributeValueOf', () => {
  it('keeps strings, stringifies numbers and booleans, serialises objects, drops null', () => {
    expect(attributeValueOf('27')).toBe('27');
    expect(attributeValueOf(27)).toBe('27');
    expect(attributeValueOf(true)).toBe('true');
    expect(attributeValueOf({ a: 1 })).toBe('{"a":1}');
    expect(attributeValueOf(null)).toBeNull();
    expect(attributeValueOf(undefined)).toBeNull();
  });
});

describe('splitWritable', () => {
  const entries: [string, unknown][] = [[' Location ', 'QC 3'], ['High Temperature Limit', 27], ['', 'x'], ['Note', null]];
  it('with no list, every usable key is accepted, trimmed, as a string', () => {
    expect(splitWritable(entries, null)).toEqual({
      accepted: [['Location', 'QC 3'], ['High Temperature Limit', '27']],
      refused: [],
    });
  });
  it('with a list, an unlisted key is REFUSED by name, never silently dropped', () => {
    expect(splitWritable(entries, new Set(['Location']))).toEqual({
      accepted: [['Location', 'QC 3']],
      refused: ['High Temperature Limit'],
    });
  });
});
