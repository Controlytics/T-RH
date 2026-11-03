import { describe, it, expect } from 'vitest';
import { hasEffectivePermission, PERMISSIONS } from '../permissions.js';
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
