import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

export const sessionDef: ModuleConfigDefinition = {
  moduleKey: 'session',
  moduleName: 'Session Settings',
  description: 'Configure session duration and idle timeout',
  icon: 'clock',
  category: 'security',
  sortOrder: 2,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: null,
  requiresReauth: true,
  hasCustomPage: true,
  customPagePath: '/config/password-policy',
  settings: [
    { key: 'sessionDurationHours', type: 'number', label: 'Session Duration (hours)', min: 1, max: 24, default: 8, group: 'Session' },
    { key: 'autoLogoutEnabled', type: 'boolean', label: 'Auto Logout', default: true, group: 'Idle' },
    // 15 min idle is the 21 CFR Part 11 industry default for shared workstations.
    // Allowed range capped at 60 min — anything longer would weaken the
    // unattended-session-attack guarantee that's audited during pharma
    // installations. Admins can lower per-deployment via /config/password-policy.
    { key: 'idleTimeoutMinutes', type: 'number', label: 'Idle Timeout (minutes)', min: 5, max: 60, default: 15, group: 'Idle' },
  ],
};
