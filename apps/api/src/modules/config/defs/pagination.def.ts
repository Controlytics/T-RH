import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

export const paginationDef: ModuleConfigDefinition = {
  moduleKey: 'pagination',
  moduleName: 'Pagination Settings',
  description: 'Configure records per page options for all list views',
  icon: 'list',
  category: 'display',
  sortOrder: 12,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: true,
  customPagePath: '/config/pagination',
  settings: [
    { key: 'limit', type: 'number', label: 'Maximum Page Size', default: 100, group: 'Options' },
    { key: 'count', type: 'number', label: 'Number of Options', default: 3, group: 'Options' },
    { key: 'options', type: 'json', label: 'Page Size Options', default: [10, 25, 50], group: 'Options' },
  ],
};
