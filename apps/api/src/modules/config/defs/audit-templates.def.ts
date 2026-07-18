import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

export const auditTemplatesDef: ModuleConfigDefinition = {
  moduleKey: 'audit-templates',
  moduleName: 'Audit Text Templates',
  description: 'Customize audit trail description text per action',
  icon: 'file-text',
  category: 'display',
  sortOrder: 13,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: true,
  customPagePath: '/config/audit-templates',
  settings: [],
};
