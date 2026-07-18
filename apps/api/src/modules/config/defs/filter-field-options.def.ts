import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

export const filterFieldOptionsDef: ModuleConfigDefinition = {
  moduleKey: 'filter-field-options',
  moduleName: 'Filter Field Options',
  description: 'Configure dropdown values for AHU Type, Filter Type, and Micron Size on the single-filter add/edit screens (Filter Size is free text)',
  icon: 'list',
  category: 'filter-management',
  sortOrder: 55, // immediately after filter-cleaning-reasons (sortOrder 50)
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  // Matches filter-cleaning-reasons: dynamic-routes.ts PUT handler reads
  // reauthAction off the def, so save calls go through the umbrella
  // UPDATE_CONFIG_PAGE reauth gate.
  requiresReauth: true,
  reauthAction: 'UPDATE_CONFIG_PAGE',
  hasCustomPage: false,
  customPagePath: '/config/filter-field-options',
  settings: [],
};
