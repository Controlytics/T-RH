import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';
import { SENSOR_OFFSETS_CONFIG_KEY } from '@digilog/shared';

/**
 * Sensor Offsets (2026-10-01) — the per-instrument temperature / humidity
 * correction applied to every reading AS IT ARRIVES. See
 * `@digilog/shared/sensor-offsets` for the rules and the operator's words.
 *
 * The VALUES are instrument attributes (one per instrument, SUPER_ADMIN only);
 * WHICH attribute keys hold them is each instrument PROFILE's since 2026-10-26
 * (Configuration → Instrument Attributes). This def switches the correction on
 * or off. Renders through the dynamic config page with a SUPER_ADMIN card.
 * Read by the ingest path through `modules/instruments/load-offsets.ts`.
 */
export const sensorOffsetsDef: ModuleConfigDefinition = {
  moduleKey: SENSOR_OFFSETS_CONFIG_KEY,
  moduleName: 'Sensor Offsets',
  description: 'Correct temperature and humidity readings by each instrument\'s own offset, as they arrive.',
  icon: 'adjustments',
  category: 'system',
  sortOrder: 26,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  // Re-auth on save is governed by the UPDATE_CONFIG_PAGE entry under Action
  // Re-authentication (audit 2026-10-12 #7): this SUPER_ADMIN def had no
  // action at all, so no policy could ever ask for the password here.
  reauthAction: 'UPDATE_CONFIG_PAGE',
  hasCustomPage: false,
  settings: [
    {
      key: 'enabled',
      type: 'boolean',
      label: 'Apply sensor offsets',
      description: 'When on, each arriving temperature and humidity reading has its instrument\'s offset added (+) or subtracted (-) before it is stored, so the corrected value is what every screen, report and alarm uses. Readings already stored are never changed — switching this off affects new readings only.',
      default: true,
      group: 'Sensor Offsets',
    },
  ],
};
