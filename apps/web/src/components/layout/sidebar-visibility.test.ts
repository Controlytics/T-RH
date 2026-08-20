import { describe, it, expect } from 'vitest';
import { SIDEBAR_PRIVILEGE_MAP, FEATURE_TO_PERMISSION_MAP, SIDEBAR_ITEMS } from '@digilog/shared';
import { isSidebarItemVisible } from './sidebar-visibility';

// The exact legacy logic from sidebar.tsx's hasPermissionForItem (pre-5B), reproduced
// here as the oracle. 5B must match it for every (item, perms) pair.
function legacyVisible(itemId: string, userPerms: string[]): boolean {
  if (userPerms.length === 0) return false;
  const section = SIDEBAR_PRIVILEGE_MAP.find(s => s.sidebarId === itemId);
  if (!section || section.privilegeIds.length === 0) return true;
  return section.privilegeIds.some(privId => {
    const requiredPerms = FEATURE_TO_PERMISSION_MAP[privId];
    if (!requiredPerms) return false;
    return requiredPerms.some(p => userPerms.includes(p));
  });
}

// Representative permission sets covering the meaningful branches.
const PERM_SETS: Record<string, string[]> = {
  empty: [],
  viewerish: ['AUDIT_READ', 'INSTRUMENT_READ', 'DASHBOARD_VIEW'],
  operatorish: ['INSTRUMENT_READ', 'INSTRUMENT_UPDATE', 'ALARM_READ', 'ALARM_ACKNOWLEDGE'],
  adminish: ['USER_READ', 'CONFIG_READ', 'CONFIG_UPDATE', 'ROLE_MANAGE', 'INSTRUMENT_READ', 'AUDIT_READ', 'NOTIFICATION_VIEW', 'ALARM_READ', 'FUNCTIONAL_LOCATION_READ'],
  onlyUserRead: ['USER_READ'],
  unrelated: ['SOME_FAKE_PERM'],
};

// All sidebar ids that exist in the privilege map, plus the one real item known
// NOT to be in it (must default to visible in both old and new).
const ALL_ITEM_IDS = [
  ...SIDEBAR_PRIVILEGE_MAP.map(s => s.sidebarId),
  'home', // a real SIDEBAR_ITEMS entry with no PERMISSION_TREE group
];

describe('5B sidebar visibility — tree-based matches legacy SIDEBAR_PRIVILEGE_MAP exactly', () => {
  for (const itemId of ALL_ITEM_IDS) {
    for (const [setName, perms] of Object.entries(PERM_SETS)) {
      it(`item="${itemId}" perms="${setName}" → new === legacy`, () => {
        expect(isSidebarItemVisible(itemId, perms)).toBe(legacyVisible(itemId, perms));
      });
    }
  }

  it('empty perms always hides (both)', () => {
    expect(isSidebarItemVisible('users', [])).toBe(false);
  });

  it('an item with no tree group / no visibility privileges is visible (e.g. home)', () => {
    // Assert the premise before the property: a test pinned to an item that has
    // been deleted passes vacuously, because an unknown id has no group either.
    expect(SIDEBAR_ITEMS.map((i) => i.id)).toContain('home');
    expect(SIDEBAR_PRIVILEGE_MAP.map((s) => s.sidebarId)).not.toContain('home');
    expect(isSidebarItemVisible('home', ['AUDIT_READ'])).toBe(true);
  });
});
