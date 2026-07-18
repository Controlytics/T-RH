import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

export const fieldIdsDef: ModuleConfigDefinition = {
  moduleKey: 'field-ids',
  moduleName: 'Field ID Names',
  description: 'Configure field display names globally',
  icon: 'tag',
  category: 'display',
  sortOrder: 16,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: true,
  customPagePath: '/config/field-ids',
  settings: [],
};
