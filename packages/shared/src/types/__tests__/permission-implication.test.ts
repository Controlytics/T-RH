import { describe, it, expect } from 'vitest';
import { hasEffectivePermission, PERMISSIONS, PERMISSION_IMPLIED_BY } from '../permissions.js';
import { resolveNodeGate } from '../permission-tree.js';

/**
 * Edit Settings is attributes ONLY (2026-10-30). The whole fix rests on one
 * asymmetry: the broad permission implies the narrow one, never the reverse.
 */
describe('INSTRUMENT_ATTRIBUTE_UPDATE', () => {
  it('is a permission of its own', () => {
    expect(PERMISSIONS.INSTRUMENT_ATTRIBUTE_UPDATE).toBe('INSTRUMENT_ATTRIBUTE_UPDATE');
  });

  it('is implied by INSTRUMENT_UPDATE — Edit Instruments keeps attribute editing', () => {
    expect(hasEffectivePermission(['INSTRUMENT_UPDATE'], 'INSTRUMENT_ATTRIBUTE_UPDATE')).toBe(true);
  });

  it('does NOT imply INSTRUMENT_UPDATE — Edit Settings never reaches the instrument', () => {
    expect(hasEffectivePermission(['INSTRUMENT_ATTRIBUTE_UPDATE'], 'INSTRUMENT_UPDATE')).toBe(false);
  });

  it('is not granted by reading instruments', () => {
    expect(hasEffectivePermission(['INSTRUMENT_READ'], 'INSTRUMENT_ATTRIBUTE_UPDATE')).toBe(false);
  });

  it('gates the Settings Edit toggle; the instrument edit toggle stays on INSTRUMENT_UPDATE', () => {
    expect(resolveNodeGate('settings.edit')).toEqual(['INSTRUMENT_ATTRIBUTE_UPDATE']);
    expect(resolveNodeGate('instruments.edit')).toEqual(['INSTRUMENT_UPDATE']);
  });
});

/**
 * Rule chains (2026-11-03, spec §9): authoring a chain implies reading chains.
 * Explicit in `PERMISSION_IMPLIED_BY` although the `_READ <- _MANAGE` suffix
 * rule already grants it, so the policy is readable in one table.
 */
describe('RULE_CHAIN_READ / RULE_CHAIN_MANAGE', () => {
  it('are permissions of their own', () => {
    expect(PERMISSIONS.RULE_CHAIN_READ).toBe('RULE_CHAIN_READ');
    expect(PERMISSIONS.RULE_CHAIN_MANAGE).toBe('RULE_CHAIN_MANAGE');
  });

  it('MANAGE implies READ, through the one implication table', () => {
    expect(PERMISSION_IMPLIED_BY.RULE_CHAIN_READ).toEqual(['RULE_CHAIN_MANAGE']);
    expect(hasEffectivePermission(['RULE_CHAIN_MANAGE'], 'RULE_CHAIN_READ')).toBe(true);
  });

  it('READ does NOT imply MANAGE — reading a chain never edits one', () => {
    expect(hasEffectivePermission(['RULE_CHAIN_READ'], 'RULE_CHAIN_MANAGE')).toBe(false);
  });

  it('no other permission reaches them', () => {
    for (const p of ['CONFIG_UPDATE', 'CONFIG_READ', 'ALARM_RULE_MANAGE', 'INSTRUMENT_UPDATE']) {
      expect(hasEffectivePermission([p], 'RULE_CHAIN_READ'), p).toBe(false);
      expect(hasEffectivePermission([p], 'RULE_CHAIN_MANAGE'), p).toBe(false);
    }
  });
});
