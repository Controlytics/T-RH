import { PERMISSION_TREE, resolveNodePermissions } from '@digilog/shared';

/**
 * Whether a sidebar item is visible to a user holding `userPerms`, resolved from the
 * PERMISSION_TREE group's `visibilityPrivilegeIds` (Phase 5B).
 *
 * Replaces the previous `SIDEBAR_PRIVILEGE_MAP` + `FEATURE_TO_PERMISSION_MAP` lookup in
 * sidebar.tsx. Behavior is identical by construction — Phase 1 parity tests prove
 * `group.visibilityPrivilegeIds` === `SIDEBAR_PRIVILEGE_MAP[id].privilegeIds` and
 * `resolveNodePermissions(privId)` === `FEATURE_TO_PERMISSION_MAP[privId]`. The companion
 * `sidebar-visibility.test.ts` asserts new===old across all items so 5E can delete the
 * standalone maps safely.
 *
 * Rules (unchanged): empty `userPerms` → false; an item with no tree group OR an empty
 * `visibilityPrivilegeIds` → visible (e.g. dashboard, system-health, report-reviews);
 * otherwise visible iff the user holds at least one permission of at least one visibility
 * privilege. SUPER_ADMIN bypass, the `config.sidebarItems` override, and the qnn server
 * flag are handled by the caller (sidebar.tsx), not here.
 */
export function isSidebarItemVisible(itemId: string, userPerms: string[]): boolean {
  if (userPerms.length === 0) return false;
  const group = PERMISSION_TREE.find(g => g.sidebarId === itemId);
  if (!group || group.visibilityPrivilegeIds.length === 0) return true;
  return group.visibilityPrivilegeIds.some(privId => {
    const required = resolveNodePermissions(privId);
    return required.length > 0 && required.some(p => userPerms.includes(p));
  });
}
