/**
 * Phase 5E — sidebar-privilege-map.ts is now DERIVED from PERMISSION_TREE.
 *
 * The hand-maintained SIDEBAR_PRIVILEGE_MAP array has been replaced by
 * deriveSidebarPrivilegeMap() in permission-tree.ts, which reads each
 * SidebarGroup's visibilityPrivilegeIds directly.
 *
 * The public API (exports) is unchanged — all consumers continue to import
 * { SIDEBAR_PRIVILEGE_MAP, getPrivilegesForSection } from this file with
 * exactly the same shapes and values.
 */

import { FEATURE_PRIVILEGES } from './feature-privileges.js';
import { deriveSidebarPrivilegeMap } from './permission-tree.js';
import type { FeaturePrivilege } from './feature-privileges.js';

export interface SidebarSection {
  sidebarId: string;
  label: string;
  icon: string;
  description: string;
  privilegeIds: string[];
}

export const SIDEBAR_PRIVILEGE_MAP: SidebarSection[] = deriveSidebarPrivilegeMap();

/** Look up FeaturePrivilege objects for a given sidebar section */
export function getPrivilegesForSection(sidebarId: string): FeaturePrivilege[] {
  const section = SIDEBAR_PRIVILEGE_MAP.find(s => s.sidebarId === sidebarId);
  if (!section) return [];
  return section.privilegeIds
    .map(id => FEATURE_PRIVILEGES.find(fp => fp.id === id))
    .filter((fp): fp is FeaturePrivilege => fp !== undefined);
}
