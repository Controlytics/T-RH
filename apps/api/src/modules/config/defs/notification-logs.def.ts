import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

export const notificationLogsDef: ModuleConfigDefinition = {
  moduleKey: 'notification-logs',
  moduleName: 'Notification Logs',
  description: 'View notification delivery history',
  icon: 'scroll',
  category: 'notifications',
  sortOrder: 33,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: true,
  customPagePath: '/config/notification-logs',
  settings: [],
};
