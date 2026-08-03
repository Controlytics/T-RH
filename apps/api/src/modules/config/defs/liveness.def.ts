import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

// Instrument liveness — drives workers/liveness-sweep.worker.ts.
// Renders through the dynamic config page (hasCustomPage: false).
export const livenessDef: ModuleConfigDefinition = {
  moduleKey: 'liveness',
  moduleName: 'Instrument Liveness',
  description: 'Controls how long an instrument may go silent before it is marked offline.',
  icon: 'wifi-off',
  category: 'advanced',
  sortOrder: 62,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: null,
  requiresReauth: true,
  // No dedicated reauth action for this surface; UPDATE_CONFIG_PAGE is the
  // umbrella action reserved for exactly this case (see reauth-actions.ts).
  reauthAction: 'UPDATE_CONFIG_PAGE',
  hasCustomPage: false,
  settings: [
    {
      key: 'gracePeriodMultiplier', type: 'number', label: 'Grace Period Multiplier', default: 2,
      min: 1, max: 10,
      helpText: 'An instrument is considered offline once its silence exceeds its expected '
        + 'reporting interval multiplied by this value. 2 means a single late message does not '
        + 'raise an alarm.',
      group: 'Liveness',
    },
  ],
};
