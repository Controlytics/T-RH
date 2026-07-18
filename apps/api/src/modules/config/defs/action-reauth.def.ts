import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

export const actionReauthDef: ModuleConfigDefinition = {
  moduleKey: 'action-reauth',
  moduleName: 'Action Re-authentication',
  description: 'Require password verification for sensitive actions per role',
  icon: 'fingerprint',
  category: 'security',
  sortOrder: 4,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: true,
  customPagePath: '/config/action-reauth',
  settings: [],
};
