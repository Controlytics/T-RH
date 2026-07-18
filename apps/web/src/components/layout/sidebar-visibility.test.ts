import { describe, it, expect } from 'vitest';
import { SIDEBAR_PRIVILEGE_MAP, FEATURE_TO_PERMISSION_MAP } from '@digilog/shared';
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
  viewerish: ['AUDIT_READ', 'ASSET_VIEW', 'ASSET_READ', 'DASHBOARD_VIEW'],
  operatorish: ['ASSET_VIEW', 'ASSET_READ', 'FILTER_OPERATE', 'CHECKLIST_SUBMIT', 'CYCLE_READ', 'PM_READ', 'EVENT_READ'],
  adminish: ['USER_READ', 'CONFIG_READ', 'CONFIG_UPDATE', 'ROLE_MANAGE', 'ASSET_VIEW', 'ASSET_READ', 'AUDIT_READ', 'NOTIFICATION_VIEW', 'PM_READ', 'CYCLE_READ', 'FILTER_OPERATE'],
  onlyUserRead: ['USER_READ'],
  unrelated: ['SOME_FAKE_PERM'],
};

// All sidebar ids that exist in the privilege map + a couple known NOT in it
// (must default to visible in both old and new — e.g. report-reviews, system-health).
const ALL_ITEM_IDS = [
  ...SIDEBAR_PRIVILEGE_MAP.map(s => s.sidebarId),
  'report-reviews', // intentionally absent from the privilege map
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

  it('an item with no tree group / no visibility privileges is visible (e.g. report-reviews)', () => {
    expect(isSidebarItemVisible('report-reviews', ['ASSET_READ'])).toBe(true);
  });
});
