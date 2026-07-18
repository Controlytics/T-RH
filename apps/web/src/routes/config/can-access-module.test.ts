import { describe, it, expect } from 'vitest';
import { canAccessConfigModule } from './can-access-module.js';

describe('canAccessConfigModule (default-DENY, gap S1)', () => {
  const matrix = {
    'password-policy': ['ADMIN'],
    'datetime': ['ADMIN'],
    'backup': ['ADMIN'],
    'user-id': ['ADMIN'],
    'pagination': [], // entry exists but no roles → nobody but SUPER_ADMIN
  };

  it('SUPER_ADMIN always passes (even unconfigured modules)', () => {
    expect(canAccessConfigModule('brand-new-module', { isSuperAdmin: true, role: 'SUPER_ADMIN', accessMatrix: matrix })).toBe(true);
  });

  it('grants a role listed in the module entry', () => {
    expect(canAccessConfigModule('backup', { isSuperAdmin: false, role: 'ADMIN', accessMatrix: matrix })).toBe(true);
  });

  it('denies a role NOT listed in the module entry', () => {
    expect(canAccessConfigModule('backup', { isSuperAdmin: false, role: 'OPERATOR', accessMatrix: matrix })).toBe(false);
  });

  it('denies an empty-array module entry to everyone but SUPER_ADMIN', () => {
    expect(canAccessConfigModule('pagination', { isSuperAdmin: false, role: 'ADMIN', accessMatrix: matrix })).toBe(false);
  });

  it('DEFAULT-DENY: an UNCONFIGURED module (no entry) is hidden from non-superadmins', () => {
    // This is the S1 fix — previously this returned true (fail-open).
    expect(canAccessConfigModule('some-new-unconfigured-module', { isSuperAdmin: false, role: 'ADMIN', accessMatrix: matrix })).toBe(false);
  });

  it('preserves current ADMIN access to the 4 general cards (they have explicit entries)', () => {
    for (const k of ['password-policy', 'datetime', 'backup', 'user-id']) {
      expect(canAccessConfigModule(k, { isSuperAdmin: false, role: 'ADMIN', accessMatrix: matrix }), k).toBe(true);
    }
  });

  it('a card with no moduleKey passes (rendering fallback)', () => {
    expect(canAccessConfigModule(undefined, { isSuperAdmin: false, role: 'OPERATOR', accessMatrix: matrix })).toBe(true);
  });
});
