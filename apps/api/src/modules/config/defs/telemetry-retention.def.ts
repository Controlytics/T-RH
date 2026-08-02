import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

// Telemetry partition maintenance — drives workers/telemetry-partition.worker.ts.
// Renders through the dynamic config page (hasCustomPage: false).
export const telemetryRetentionDef: ModuleConfigDefinition = {
  moduleKey: 'telemetry-retention',
  moduleName: 'Telemetry Retention',
  description: 'Controls how far ahead telemetry partitions are created, and whether old ones are dropped.',
  icon: 'database',
  category: 'advanced',
  sortOrder: 61,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: null,
  requiresReauth: true,
  // No dedicated reauth action for this surface; UPDATE_CONFIG_PAGE is the
  // umbrella action reserved for exactly this case (see reauth-actions.ts).
  reauthAction: 'UPDATE_CONFIG_PAGE',
  hasCustomPage: false,
  settings: [
    {
      key: 'monthsAhead', type: 'number', label: 'Months Of Partitions To Pre-Create', default: 3,
      helpText: 'Telemetry history is stored in monthly partitions. A reading whose timestamp '
        + 'falls outside every partition is REJECTED outright — ingestion does not slow down, it '
        + 'stops. Keeping several months ahead means one missed maintenance run cannot break '
        + 'inserts. Do not set below 2.',
      group: 'Partitions',
    },
    {
      key: 'dropEnabled', type: 'boolean', label: 'Drop Partitions Older Than Retention', default: false,
      helpText: 'OFF by default, and dropping is permanent. When enabled, whole monthly partitions '
        + 'older than the retention window below are DROPPED — the readings in them are destroyed '
        + 'and cannot be recovered from the application. Leave off unless a retention policy '
        + 'requires deletion and backups are known to be in place.',
      group: 'Retention',
    },
    {
      key: 'retentionMonths', type: 'number', label: 'Retention (Months)', default: 12,
      helpText: 'Only applies when dropping is enabled. A partition is removed only when its ENTIRE '
        + 'month falls outside this window; the current month is never touched.',
      group: 'Retention',
    },
  ],
};
