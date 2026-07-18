import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

/**
 * PM Schedule Settings — controls how scheduled preventive maintenance is
 * surfaced to operators in the "My Tasks" page.
 *
 * - `defaultToleranceDays` is the fallback when a CSV row leaves the
 *   `tolerance_days` column blank.
 * - `taskVisibility` controls who sees a due task. For v1 only `GLOBAL` is
 *   wired up; `PER_USER` and `ROLE_GATED` are schema slots that return a
 *   501 NOT_IMPLEMENTED from /due until we wire them.
 * - `showOverdueSeparately` splits tasks whose window has closed without
 *   completion into their own "Overdue" section on My Tasks.
 */
export const pmScheduleSettingsDef: ModuleConfigDefinition = {
  moduleKey: 'pm-schedule-settings',
  moduleName: 'PM Schedule Settings',
  description: 'Tolerance defaults and visibility rules for the My Tasks page',
  icon: 'calendar-clock',
  category: 'filter-management',
  sortOrder: 70,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: false,
  settings: [
    {
      key: 'enabled',
      type: 'boolean',
      label: 'Enable PM Scheduling',
      description: 'Turn the preventive maintenance scheduling module on or off globally. When disabled, all PM endpoints return 404 PM_DISABLED.',
      group: 'General',
      default: false,
    },
    {
      key: 'defaultToleranceDays',
      type: 'number',
      label: 'Default Tolerance (days)',
      description: 'Used when a CSV row leaves the tolerance_days column blank. Applied symmetrically — the task is due from (plannedDate − N) through (plannedDate + N).',
      group: 'Defaults',
      default: 3,
      min: 0,
      max: 365,
    },
    {
      key: 'taskVisibility',
      type: 'select',
      label: 'Task Visibility',
      description: 'Who sees a due task in My Tasks. Per-user and role-gated modes are not yet implemented — selecting them will cause the /due endpoint to return 501.',
      group: 'Visibility',
      default: 'GLOBAL',
      options: [
        { value: 'GLOBAL', label: 'Everyone with PM access' },
        { value: 'PER_USER', label: 'Per-user assignment (not yet implemented)' },
        { value: 'ROLE_GATED', label: 'Role-gated (not yet implemented)' },
      ],
    },
    {
      key: 'showOverdueSeparately',
      type: 'boolean',
      label: 'Show Overdue Separately',
      description: 'Render tasks whose window has closed without completion in their own section below the due list, with rose styling. Turn off to hide them entirely.',
      group: 'Visibility',
      default: true,
    },
    {
      // Consumed by the overdue-deviation sweep (pm-deviations.ts → readNotifyRoles).
      // Both the overdue and completion notifications are sent to forRole = each
      // role in this list. Empty → defaults to ADMIN.
      key: 'overdueNotificationRoles',
      type: 'multiselect',
      label: 'Overdue Notification Roles',
      description: 'Which role(s) receive overdue + completion notifications when AHU filter cleaning tasks pass their tolerance window. Defaults to ADMIN.',
      group: 'Notifications',
      default: ['ADMIN'],
      dynamicOptionsSource: '/api/roles/active',
    },
  ],
};
