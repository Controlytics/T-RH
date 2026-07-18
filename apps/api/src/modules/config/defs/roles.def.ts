import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

export const rolesDef: ModuleConfigDefinition = {
  moduleKey: 'roles',
  moduleName: 'Role Management',
  description: 'Create and manage user roles',
  icon: 'users',
  category: 'user',
  sortOrder: 21,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: true,
  customPagePath: '/config/roles',
  settings: [],
};
