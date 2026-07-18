/**
 * Phase 5E — feature-privileges.ts is now DERIVED from PERMISSION_TREE.
 *
 * The hand-maintained FEATURE_PRIVILEGES array and FEATURE_TO_PERMISSION_MAP
 * object have been replaced by derive functions in permission-tree.ts, keyed by
 * the `configurable: true` flag on each PermissionNode.
 *
 * The public API (exports) is unchanged — all consumers continue to import
 * { FEATURE_PRIVILEGES, FEATURE_PRIVILEGE_CATEGORIES, FEATURE_TO_PERMISSION_MAP }
 * from this file with exactly the same shapes and values.
 */

export interface FeaturePrivilege {
  id: string;
  label: string;
  category: string;
  icon: string;
}

import { deriveFeaturePrivileges, deriveFeatureToPermissionMap } from './permission-tree.js';

export const FEATURE_PRIVILEGES: FeaturePrivilege[] = deriveFeaturePrivileges();

export const FEATURE_PRIVILEGE_CATEGORIES: Record<string, FeaturePrivilege[]> = FEATURE_PRIVILEGES.reduce((acc, feature) => {
  if (!acc[feature.category]) acc[feature.category] = [];
  acc[feature.category].push(feature);
  return acc;
}, {} as Record<string, FeaturePrivilege[]>);

export const FEATURE_TO_PERMISSION_MAP: Record<string, string[]> = deriveFeatureToPermissionMap();
