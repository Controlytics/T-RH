import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

/**
 * AHU Filter Set Configuration — per-AHU knob controlling which subset of
 * filters counts toward PM completion in My Tasks.
 *
 * This module has a custom frontend page because the data is per-AHU
 * (dynamic rows), not a single settings form.
 *
 * Modes, stored in AssetInstance.customAttributes.pmFilterSetMode:
 *   BOTH     — all Set A + Set B + unclassified filters count (default)
 *   SET_A    — only filterSet='SET_A' filters count
 *   SET_B    — only filterSet='SET_B' filters count
 *   DISABLED — AHU is hidden from My Tasks entirely
 */
export const ahuFilterSetConfigDef: ModuleConfigDefinition = {
  moduleKey: 'ahu-filter-set-config',
  moduleName: 'AHU Filter Set Configuration',
  description: 'Per-AHU control over which filter set counts toward PM cleaning completion',
  icon: 'layers',
  category: 'filter-management',
  sortOrder: 80,
  permissions: { read: 'PM_READ', write: 'PM_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: true,
  customPagePath: '/config/ahu-filter-set-config',
  settings: [],
};
