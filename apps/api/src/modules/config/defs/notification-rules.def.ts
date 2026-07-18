import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

export const notificationRulesDef: ModuleConfigDefinition = {
  moduleKey: 'notification-rules',
  moduleName: 'Notification Rules',
  description: 'Configure event-based alerts & recipients',
  icon: 'bell',
  category: 'notifications',
  sortOrder: 32,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: true,
  customPagePath: '/config/notification-rules',
  settings: [],
};
