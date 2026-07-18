import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

export const notificationSmsDef: ModuleConfigDefinition = {
  moduleKey: 'notification-sms',
  moduleName: 'SMS Settings',
  description: 'Configure SMS provider for notifications',
  icon: 'phone',
  category: 'notifications',
  sortOrder: 31,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: true,
  customPagePath: '/config/sms-settings',
  settings: [
    // P3 (2026-05-02): AWS SNS removed. Default is now http-gateway because it
    // covers MSG91 / Plivo / AfricasTalking / Kaleyra / custom backends with
    // a single configurable URL + body-template; operators don't need a
    // dedicated provider entry per service.
    { key: 'provider', type: 'select', label: 'Provider', default: 'http-gateway', group: 'Provider',
      options: [
        { value: 'http-gateway', label: 'HTTP Gateway (MSG91 / Plivo / custom)' },
        { value: 'twilio', label: 'Twilio' },
        { value: 'vonage', label: 'Vonage (Nexmo)' },
      ] },
    { key: 'enabled', type: 'boolean', label: 'Enable SMS', default: false, group: 'General' },
  ],
};
