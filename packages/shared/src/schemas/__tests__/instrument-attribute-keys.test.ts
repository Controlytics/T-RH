import { describe, it, expect } from 'vitest';
import { parseInstrumentAttributeKeys, INSTRUMENT_ATTRIBUTE_KEYS_DEFAULT } from '../config.js';

/**
 * The keys an admin types in Configuration become the fields the New Instrument
 * form asks for, so this parser decides what an operator is prompted with.
 *
 * The case that matters is the DUPLICATE fold: the entire reason keys are
 * administered rather than free-typed is to stop "Room" and "room" both
 * existing as separate attributes. A parser that let both through would leave
 * the form asking the same question twice and the register unfilterable — the
 * exact problem the config exists to solve.
 */
describe('parseInstrumentAttributeKeys', () => {
  it('takes one key per line, in order', () => {
    expect(parseInstrumentAttributeKeys('Room\nAsset Tag\nCalibration Due'))
      .toEqual(['Room', 'Asset Tag', 'Calibration Due']);
  });

  it('trims and drops blank lines, including a trailing newline', () => {
    expect(parseInstrumentAttributeKeys('  Room  \n\n\n Asset Tag \n')).toEqual(['Room', 'Asset Tag']);
  });

  it('de-duplicates case-insensitively, keeping the first spelling', () => {
    expect(parseInstrumentAttributeKeys('Room\nroom\nROOM')).toEqual(['Room']);
  });

  it('handles CRLF, which is what a Windows admin pastes', () => {
    expect(parseInstrumentAttributeKeys('Room\r\nAsset Tag')).toEqual(['Room', 'Asset Tag']);
  });

  it('is empty for empty, null or undefined', () => {
    expect(parseInstrumentAttributeKeys('')).toEqual([]);
    expect(parseInstrumentAttributeKeys(null)).toEqual([]);
    expect(parseInstrumentAttributeKeys(undefined)).toEqual([]);
    expect(parseInstrumentAttributeKeys('   \n  \n')).toEqual([]);
  });

  // There is NO cap (2026-08-07 operator decision, replacing a 25-key one).
  // Silently dropping key 26 is the kind of quiet data loss found months later;
  // an unwieldy form is a layout problem, not a reason to discard keys an admin
  // deliberately added.
  it('keeps every key, however many there are', () => {
    const many = Array.from({ length: 100 }, (_, i) => `Key ${i}`).join('\n');
    const keys = parseInstrumentAttributeKeys(many);
    expect(keys).toHaveLength(100);
    expect(keys[0]).toBe('Key 0');
    expect(keys[99]).toBe('Key 99');
  });

  it('parses its own shipped default', () => {
    expect(parseInstrumentAttributeKeys(INSTRUMENT_ATTRIBUTE_KEYS_DEFAULT).length).toBeGreaterThan(0);
  });
});
