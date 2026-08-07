import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';
import { INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN } from '@digilog/shared';

/**
 * When does an instrument count as ACTIVE?
 *
 * "Active means it is sending telemetry" needs a cut-off, and the cut-off is a
 * site decision: a cleanroom probe reporting every 30 seconds and a calibration
 * rig read once a shift are both healthy, and one fixed window would libel one
 * of them.
 *
 * This setting is the FALLBACK only. An instrument that declares an expected
 * interval is judged against its own contract instead — that is the honest
 * measure and needs no configuration.
 */
export const instrumentActivityDef: ModuleConfigDefinition = {
  moduleKey: 'instrument-activity',
  moduleName: 'Instrument Activity',
  description: 'How long an instrument may go without reporting before it is shown as Inactive.',
  icon: 'activity',
  category: 'system',
  sortOrder: 15,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: false,
  settings: [
    {
      key: 'activeWindowMinutes',
      type: 'number',
      label: 'Active window (minutes)',
      description: 'An instrument with NO expected interval reads Active while it has reported within this many minutes, and Inactive after. Instruments that declare an expected interval are judged against that instead.',
      default: INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN,
      min: 1,
      max: 525600,
      group: 'Instrument Activity',
    },
  ],
};
