import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';
import { INACTIVITY_ALARMS_DEFAULT, INACTIVITY_GRACE_MAX, INACTIVITY_TEXT_DEFAULT, INACTIVITY_MINUTES_TOKEN } from '@digilog/shared';

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
 *
 * The three COLUMN wordings below are a different matter and do belong here: they
 * apply to inactivity rows only, and the cells they fill are empty on those rows
 * for a structural reason (no reading raised the alarm, and no reading cleared
 * it). Served to every authenticated user by
 * `GET /api/config/inactivity-alarms/display-texts` — this def itself stays
 * SUPER_ADMIN-only, because `enabled` and `graceMinutes` decide what fires as a
 * regulated alarm.
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
      key: 'textGeneratedValue',
      type: 'string',
      label: 'Generated Value column',
      description:
        'What the Generated Value cell says on an inactivity alarm. There is no reading to show — this alarm is raised by the ABSENCE of one — so the cell carries a word instead of an empty dash. Blank falls back to the shipped wording.',
      default: INACTIVITY_TEXT_DEFAULT.generatedValue,
      maxLength: 40,
      group: 'Column Wording',
    },
    {
      key: 'textLimit',
      type: 'string',
      label: 'Limit column',
      description:
        `What the Limit cell says. Must contain ${INACTIVITY_MINUTES_TOKEN}, which is replaced with the grace period THIS alarm was raised against — not the one set today, so lengthening the grace never rewrites a past outage. A wording without ${INACTIVITY_MINUTES_TOKEN} is ignored and the shipped wording is used: the threshold an alarm fired against is a regulated record and cannot be typed away.`,
      default: INACTIVITY_TEXT_DEFAULT.limit,
      maxLength: 40,
      group: 'Column Wording',
    },
    {
      key: 'textClearedValue',
      type: 'string',
      label: 'Cleared Value column',
      description:
        'What the Cleared Value cell says once the instrument reports again. The alarm clears because telemetry RETURNED, not because a reading came back inside a bound, so there is no number to show. Blank falls back to the shipped wording.',
      default: INACTIVITY_TEXT_DEFAULT.clearedValue,
      maxLength: 40,
      group: 'Column Wording',
    },
  ],
};
