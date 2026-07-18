import { describe, it, expect } from 'vitest';
import {
  FEATURE_TO_PERMISSION_MAP,
  deriveFeatureToPermissionMap,
  PERMISSIONS,
} from '@digilog/shared';
import { defaultRoles } from '../../prisma/default-roles.js';

// Expand a set of enforced permission strings through a feature->permission map.
function expandViaMap(perms: string[], map: Record<string, string[]>): Set<string> {
  // Roles already store enforced PERMISSIONS strings directly; the map is only
  // consulted by the admin UI when toggling. The invariant we assert is that the
  // two maps expand identically, so a role's UI-toggled grants are unchanged.
  const out = new Set(perms);
  for (const list of Object.values(map)) for (const p of list) {
    if (perms.includes(p)) for (const q of list) out.add(q);
  }
  return out;
}

describe('CFR invariant: tree-derived map equals legacy map for every role', () => {
  const derived = deriveFeatureToPermissionMap();
  for (const role of defaultRoles) {
    it(`role ${role.name}: identical expansion via legacy vs tree map`, () => {
      const legacy = expandViaMap(role.permissions as unknown as string[], FEATURE_TO_PERMISSION_MAP);
      const viaTree = expandViaMap(role.permissions as unknown as string[], derived);
      expect([...viaTree].sort()).toEqual([...legacy].sort());
    });
  }

  it('every role permission string is a real PERMISSIONS constant', () => {
    const valid = new Set(Object.values(PERMISSIONS));
    for (const role of defaultRoles) {
      for (const p of role.permissions) {
        expect(valid.has(p as any), `${role.name} → ${p}`).toBe(true);
      }
    }
  });
});
