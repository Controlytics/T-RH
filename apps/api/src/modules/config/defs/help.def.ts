import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

export const helpDef: ModuleConfigDefinition = {
  moduleKey: 'help',
  moduleName: 'Help Articles',
  description: 'Manage contextual help content and documentation',
  icon: 'help-circle',
  category: 'advanced',
  sortOrder: 52,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: true,
  customPagePath: '/config/help',
  settings: [],
};
