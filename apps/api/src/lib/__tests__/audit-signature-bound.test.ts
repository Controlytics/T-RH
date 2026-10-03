import { describe, it, expect } from 'vitest';
import { clampSignatureMeaning, SIGNATURE_MEANING_MAX } from '../audit.js';

/**
 * Audit 2026-10-03, API-4: `audit_trail.signature_meaning` is VARCHAR(255)
 * behind a raw insert, and a longer meaning was a 22001 AFTER the caller's
 * mutation had committed. The bound lives in `auditLog` now, before the
 * meaning is hashed or stored, so every caller is covered.
 */
describe('clampSignatureMeaning', () => {
  it('passes a meaning within the column through unchanged', () => {
    expect(clampSignatureMeaning('Instrument renamed')).toBe('Instrument renamed');
    expect(clampSignatureMeaning('x'.repeat(SIGNATURE_MEANING_MAX))).toHaveLength(SIGNATURE_MEANING_MAX);
  });

  it('cuts a longer meaning to the column with an ellipsis', () => {
    const out = clampSignatureMeaning('y'.repeat(SIGNATURE_MEANING_MAX + 40))!;
    expect(out).toHaveLength(SIGNATURE_MEANING_MAX);
    expect(out.endsWith('…')).toBe(true);
  });

  it('keeps an absent meaning absent', () => {
    expect(clampSignatureMeaning(undefined)).toBeUndefined();
    expect(clampSignatureMeaning(null)).toBeUndefined();
  });
});
