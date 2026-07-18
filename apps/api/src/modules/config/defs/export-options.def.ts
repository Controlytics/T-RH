import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

export const exportOptionsDef: ModuleConfigDefinition = {
  moduleKey: 'export-options',
  moduleName: 'Export Options',
  description: 'Choose which export formats (PDF / Excel) each role can use on each page',
  icon: 'download',
  category: 'access',
  sortOrder: 6,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: true,
  customPagePath: '/config/export-options',
  settings: [],
};
