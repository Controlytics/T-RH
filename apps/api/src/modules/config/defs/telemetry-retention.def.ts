import { z } from 'zod';
import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

/**
 * Telemetry Retention (2026-10-05; audit 2026-10-03, DATA-9 / DATA-2).
 *
 * `instrument_telemetry_history` is RANGE-partitioned by month. The worker
 * `telemetry-partition.worker.ts` creates the coming months' partitions ahead
 * of time (a reading whose month has no partition is REFUSED by Postgres) and,
 * when switched on, drops months that are entirely older than the retention
 * window. It read a `telemetry-retention` row for these three numbers since
 * 2026-08-04 — and this def, which that worker's comment cited, did not exist:
 * nothing seeded the row, no page edited it, and the one way to switch
 * dropping on was an UPDATE on `system_config` with no CONFIG_CHANGED record.
 *
 * SUPER_ADMIN only; renders through the dynamic config page with a card in
 * `superAdminCards` (apps/web/src/routes/config/index.tsx). Every change is a
 * CONFIG_CHANGED audit row through the generic dynamic PUT, and every
 * partition the worker drops is a RETENTION_EXECUTED row.
 *
 * Ships with dropping OFF — readings ARE the §11 record, and a retention
 * window that defaults to deleting is the wrong failure mode. `monthsAhead`
 * is clamped by the worker to at least 2 (one missed run must not stop
 * ingest); the zod below refuses less at the edit.
 */
export interface TelemetryRetentionSettings {
  /** Months of partitions to keep created AHEAD of the current month. */
  monthsAhead: number;
  /** Whether months older than the window are dropped at all. */
  dropEnabled: boolean;
  /** A month is dropped once it is ENTIRELY older than this many months. */
  retentionMonths: number;
}

export const TELEMETRY_RETENTION_CONFIG_KEY = 'telemetry-retention';

/** ONE definition of the defaults — the worker imports these. */
export const TELEMETRY_RETENTION_DEFAULTS: TelemetryRetentionSettings = {
  monthsAhead: 3,
  dropEnabled: false,
  retentionMonths: 12,
};

export const MONTHS_AHEAD_MIN = 2;
export const MONTHS_AHEAD_MAX = 24;
export const RETENTION_MONTHS_MIN = 1;
export const RETENTION_MONTHS_MAX = 240;

export const telemetryRetentionDef: ModuleConfigDefinition = {
  moduleKey: TELEMETRY_RETENTION_CONFIG_KEY,
  moduleName: 'Telemetry Retention',
  description: 'How many months of instrument readings are kept, and how far ahead their monthly storage is prepared.',
  icon: 'database',
  category: 'system',
  sortOrder: 27,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: false,
  settings: [
    {
      key: 'monthsAhead',
      type: 'number',
      label: 'Months prepared ahead',
      description: 'Monthly storage is created this many months in advance, on the 1st and 15th and at every start of the service. A reading can only be stored in a month whose storage exists, so this must stay at 2 or more — one missed run must never stop readings being accepted.',
      default: TELEMETRY_RETENTION_DEFAULTS.monthsAhead,
      min: MONTHS_AHEAD_MIN,
      max: MONTHS_AHEAD_MAX,
      group: 'Storage',
    },
    {
      key: 'dropEnabled',
      type: 'boolean',
      label: 'Drop readings older than the retention window',
      description: 'When on, each month of readings that is ENTIRELY older than the retention window is deleted by the scheduled maintenance task. Deletion is permanent, and every month dropped is recorded in the audit trail as RETENTION_EXECUTED with the number of readings it held. Off by default: readings are the record.',
      default: TELEMETRY_RETENTION_DEFAULTS.dropEnabled,
      group: 'Retention',
    },
    {
      key: 'retentionMonths',
      type: 'number',
      label: 'Retention window (months)',
      description: 'A month of readings is kept until the whole of it is older than this many months. The current month can never be dropped, whatever the value.',
      default: TELEMETRY_RETENTION_DEFAULTS.retentionMonths,
      min: RETENTION_MONTHS_MIN,
      max: RETENTION_MONTHS_MAX,
      group: 'Retention',
      visibleWhen: { field: 'dropEnabled', value: true },
    },
  ],
  zodSchema: z.object({
    monthsAhead: z.number().int().min(MONTHS_AHEAD_MIN, `Months prepared ahead must be at least ${MONTHS_AHEAD_MIN}`).max(MONTHS_AHEAD_MAX, `Months prepared ahead must be ${MONTHS_AHEAD_MAX} or fewer`),
    dropEnabled: z.boolean(),
    retentionMonths: z.number().int().min(RETENTION_MONTHS_MIN, `The retention window must be at least ${RETENTION_MONTHS_MIN} month`).max(RETENTION_MONTHS_MAX, `The retention window must be ${RETENTION_MONTHS_MAX} months or fewer`),
  }),
};
