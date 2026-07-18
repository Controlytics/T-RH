import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

export const guestCleaningRequestsDef: ModuleConfigDefinition = {
  moduleKey: 'guest-cleaning-requests',
  moduleName: 'Guest Cleaning Requests',
  description: 'Choose which roles receive a notification when a guest submits a filter cleaning request from the login page. Super Admin always receives them.',
  icon: 'bell',
  category: 'filter-management',
  sortOrder: 63,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: false,
  settings: [
    {
      key: 'recipientRoles',
      type: 'multiselect',
      label: 'Roles that receive guest cleaning requests',
      description: 'Users with any of these roles will see guest "Filter Cleaning Request" notifications in the Notifications center. Super Admin always receives them. Leave empty to restrict to Super Admin only.',
      group: 'Recipients',
      default: ['ADMIN'],
      dynamicOptionsSource: '/api/roles/active',
      options: [],
    },
  ],
};
