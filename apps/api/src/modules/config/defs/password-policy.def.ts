import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

export const passwordPolicyDef: ModuleConfigDefinition = {
  moduleKey: 'password-policy',
  moduleName: 'General & Password Settings',
  description: 'Configure password policy, login security, and session timeout',
  icon: 'shield',
  category: 'security',
  sortOrder: 1,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: null,
  requiresReauth: true,
  reauthAction: 'UPDATE_PASSWORD_POLICY',
  hasCustomPage: true,
  customPagePath: '/config/password-policy',
  settings: [
    { key: 'minLength', type: 'number', label: 'Minimum Length', min: 8, max: 32, default: 8, group: 'Length' },
    { key: 'maxLength', type: 'number', label: 'Maximum Length', min: 32, max: 128, default: 128, group: 'Length' },
    { key: 'requireUppercase', type: 'boolean', label: 'Require Uppercase', default: true, group: 'Characters' },
    { key: 'requireLowercase', type: 'boolean', label: 'Require Lowercase', default: true, group: 'Characters' },
    { key: 'requireNumbers', type: 'boolean', label: 'Require Numbers', default: true, group: 'Characters' },
    { key: 'requireSpecialChars', type: 'boolean', label: 'Require Special Characters', default: true, group: 'Characters' },
    { key: 'preventReuseCount', type: 'number', label: 'Prevent Reuse Count', min: 1, max: 24, default: 5, group: 'Reuse' },
    { key: 'maxFailedAttempts', type: 'number', label: 'Max Failed Attempts', min: 3, max: 10, default: 5, group: 'Lockout' },
    { key: 'passwordExpiryDays', type: 'number', label: 'Password Expiry (days)', min: 0, max: 365, default: 90, group: 'Expiry' },
    { key: 'expiryNotificationDays', type: 'number', label: 'Password Expiry Notification (days)', min: 0, max: 90, default: 0, group: 'Expiry' },
  ],
};
