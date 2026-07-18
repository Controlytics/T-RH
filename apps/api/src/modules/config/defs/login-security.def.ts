import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

export const loginSecurityDef: ModuleConfigDefinition = {
  moduleKey: 'login-security',
  moduleName: 'Login Security',
  description: 'Configure account lockout behavior',
  icon: 'lock',
  category: 'security',
  sortOrder: 3,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: null,
  requiresReauth: true,
  hasCustomPage: true,
  customPagePath: '/config/login-security',
  settings: [
    { key: 'lockoutType', type: 'select', label: 'Lockout Type', default: 'TEMPORARY', group: 'Lockout',
      options: [
        { value: 'TEMPORARY', label: 'Temporary' },
        { value: 'PERMANENT', label: 'Permanent' },
      ] },
    { key: 'lockoutDurationMinutes', type: 'number', label: 'Lockout Duration (minutes)', min: 15, max: 1440, default: 30, group: 'Lockout' },
  ],
};
