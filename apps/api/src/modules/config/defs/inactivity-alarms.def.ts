import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';
import { INACTIVITY_ALARMS_DEFAULT, INACTIVITY_GRACE_MAX } from '@digilog/shared';

/**
 * Inactivity alarms — raised when an instrument stops reporting, cleared when it
 * starts again.
 *
 * A THIRD alarm source beside rules and instrument limits. `AlarmRule` can
 * already do `metric: 'OFFLINE'`, but it needs a rule authored per instrument or
 * per location, and a location-targeted rule cannot reach an instrument with no
 * functional location — a normal state for a freshly commissioned device. This
 * source covers every instrument with nothing to author.
 *
 * **It ships OFF.** See INACTIVITY_ALARMS_DEFAULT for why: switching it on raises
 * one alarm for every instrument already quiet, and each raise also fires a
 * notification and every matching webhook.
 *
 * The four status wordings are NOT repeated here — they are read from
 * `alarm-limits` and are the display contract for all four alarm states. A second
 * copy would let the same status read two different ways on one table.
 */
export const inactivityAlarmsDef: ModuleConfigDefinition = {
  moduleKey: 'inactivity-alarms',
  moduleName: 'Inactivity Alarms',
  description: 'Raise an alarm when an instrument stops reporting, and clear it when telemetry returns.',
  icon: 'bell',
  category: 'system',
  sortOrder: 18,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: false,
  settings: [
    {
      key: 'enabled',
      type: 'boolean',
      label: 'Raise an alarm when an instrument stops reporting',
      description:
        'Ships OFF. Turning it on raises one alarm for every instrument that is ALREADY quiet, on the next evaluation pass — each with its own notification, webhook fire and e-signature. Turn it on once the plant is reporting. Alarms already raised are never touched by this switch; they are regulated records.',
      default: INACTIVITY_ALARMS_DEFAULT.enabled,
      group: 'Inactivity Alarms',
    },
    {
      key: 'graceMinutes',
      type: 'number',
      label: 'Grace period before raising (minutes)',
      description:
        'How long an instrument must be quiet before an alarm is raised. This DELAYS RAISING ONLY — an instrument that comes back clears on the next pass regardless. The alarm needs BOTH conditions, so the effective threshold is the LATER of this and the window on Instrument Activity: setting a grace SHORTER than that window changes nothing, because nothing counts as offline yet.',
      default: INACTIVITY_ALARMS_DEFAULT.graceMinutes,
      min: 0,
      max: INACTIVITY_GRACE_MAX,
      group: 'Inactivity Alarms',
    },
    {
      key: 'severity',
      type: 'select',
      label: 'Severity',
      description:
        'Defaults to Major rather than Critical: losing sight of an instrument means the record has a hole in it, which is not the same as knowing the product went out of specification. Ranking the two the same makes the ranking useless.',
      default: INACTIVITY_ALARMS_DEFAULT.severity,
      options: [
        { value: 'CRITICAL', label: 'Critical' },
        { value: 'MAJOR', label: 'Major' },
        { value: 'MINOR', label: 'Minor' },
      ],
      group: 'Inactivity Alarms',
    },
  ],
};
