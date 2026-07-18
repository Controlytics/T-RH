import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

export const backupDef: ModuleConfigDefinition = {
  moduleKey: 'backup',
  moduleName: 'Backup & Restore',
  description: 'Export or restore the entire database',
  icon: 'database',
  category: 'advanced',
  sortOrder: 50,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: null,
  requiresReauth: false,
  hasCustomPage: true,
  customPagePath: '/config/backup',
  settings: [],
};
