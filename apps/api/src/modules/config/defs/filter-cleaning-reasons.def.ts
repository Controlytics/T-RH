import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

export const filterCleaningReasonsDef: ModuleConfigDefinition = {
  moduleKey: 'filter-cleaning-reasons',
  moduleName: 'Filter Cleaning Reasons',
  description: 'Configure cleaning reason codes for filter cleaning cycles',
  icon: 'list-checks',
  category: 'filter-management',
  sortOrder: 50,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  // Audit 2026-05-04 fix #5 (web-routes review H — lower-blast config
  // surfaces). Cleaning-reason vocabulary edits cascade across every
  // CleaningCycle that picks one — challenge it. Routed through the
  // shared UPDATE_CONFIG_PAGE umbrella action; dynamic-routes.ts PUT
  // handler reads `reauthAction` to gate.
  requiresReauth: true,
  reauthAction: 'UPDATE_CONFIG_PAGE',
  hasCustomPage: false,
  customPagePath: '/config/filter-cleaning-reasons',
  settings: [],
};
