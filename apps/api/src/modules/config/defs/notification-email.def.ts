import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

export const notificationEmailDef: ModuleConfigDefinition = {
  moduleKey: 'notification-email',
  moduleName: 'Email Settings',
  description: 'Configure SMTP for email notifications',
  icon: 'mail',
  category: 'notifications',
  sortOrder: 30,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: true,
  customPagePath: '/config/email-settings',
  settings: [
    { key: 'provider', type: 'select', label: 'Provider', default: 'smtp', group: 'Provider',
      options: [{ value: 'smtp', label: 'SMTP' }, { value: 'oauth2', label: 'OAuth2' }] },
    { key: 'host', type: 'string', label: 'SMTP Host', group: 'SMTP', visibleWhen: { field: 'provider', value: 'smtp' } },
    { key: 'port', type: 'number', label: 'SMTP Port', default: 587, group: 'SMTP', visibleWhen: { field: 'provider', value: 'smtp' } },
    { key: 'username', type: 'string', label: 'Username', group: 'Auth' },
    { key: 'password', type: 'secret', label: 'Password', maskedInApi: true, group: 'Auth' },
    { key: 'fromAddress', type: 'email', label: 'From Address', group: 'Sender' },
    { key: 'enabled', type: 'boolean', label: 'Enable Email', default: false, group: 'General' },
  ],
};
