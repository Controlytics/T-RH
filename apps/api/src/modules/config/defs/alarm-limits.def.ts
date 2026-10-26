import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';
import { ALARM_STATUS_TEXT_DEFAULT, LIMIT_DISABLED_TEXT_DEFAULT } from '@digilog/shared';

/**
 * The instrument-limit alarm switch, and what the alarm status column says.
 *
 * WHICH attributes carry the limits — the ordered alias list per bound, the
 * per-instrument enable attribute (NMT / NLT), and the profile's own NMT / NLT
 * on/off — moved to each instrument PROFILE on 2026-10-26 (operator: "limits
 * keys assigning configurations … should be updated instrument profiles wise";
 * Configuration → Instrument Attributes, `instrument_profiles.measurements`).
 * The migration copied this install's lists onto every profile; the stored
 * JSON keys are left in this row, unread.
 *
 * Room limits (floorplan_rooms.temp_min/…) are a SEPARATE thing and raise
 * nothing — they colour the dashboard. Do not wire them in here.
 *
 * Design: docs/superpowers/specs/2026-08-17-instrument-limit-alarms-design.md,
 * docs/superpowers/specs/2026-10-26-profile-measurements-design.md
 */
export const alarmLimitsDef: ModuleConfigDefinition = {
  moduleKey: 'alarm-limits',
  moduleName: 'Instrument Limit Alarms',
  description: 'Switch limit alarms on or off, and word each alarm status. Which attributes hold the limits is set per instrument profile.',
  icon: 'bell',
  category: 'system',
  sortOrder: 17,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: false,
  settings: [
    {
      key: 'enabled',
      type: 'boolean',
      label: 'Raise alarms from instrument limits',
      description: 'When off, no limit alarms are raised. Alarm rules are unaffected. Alarms already raised are left exactly as they are — they are regulated records.',
      default: true,
      group: 'Limit Alarms',
    },
    {
      key: 'disabledLimitText',
      label: 'Wording for a switched-off limit',
      type: 'string',
      /**
       * Printed in the Alarm Report's High Limit / Low Limit column when THAT
       * bound is switched off for the instrument (`Enable_Temp_NMT` and friends).
       *
       * Deliberately NOT used for a bound that was simply never administered, nor
       * for an alarm that fired against no bound at all — those stay `N/A`. The
       * operator asked to word the switched-off case specifically, and collapsing
       * the two would lose the distinction the setting exists to draw.
       */
      description: 'Shown in the report where a High/Low limit is switched off for the instrument. Blank falls back to NA.',
      default: LIMIT_DISABLED_TEXT_DEFAULT,
      maxLength: 20,
      group: 'Status Wording',
    },
    {
      key: 'statusActiveUnack',
      type: 'string',
      label: 'Status — still breaching, not acknowledged',
      description: 'Shown while the condition is still met and nobody has signed for it.',
      default: ALARM_STATUS_TEXT_DEFAULT.activeUnack,
      maxLength: 60,
      group: 'Status Wording',
    },
    {
      key: 'statusActiveAck',
      type: 'string',
      label: 'Status — still breaching, acknowledged',
      description: 'The condition is still met, but someone has signed for it.',
      default: ALARM_STATUS_TEXT_DEFAULT.activeAck,
      maxLength: 60,
      group: 'Status Wording',
    },
    {
      key: 'statusClearedUnack',
      type: 'string',
      label: 'Status — cleared, not acknowledged',
      description: 'The condition ended but nobody has signed for it. Keep this distinct from the cleared wording: it is the overnight excursion still owed an answer.',
      default: ALARM_STATUS_TEXT_DEFAULT.clearedUnack,
      maxLength: 60,
      group: 'Status Wording',
    },
    {
      key: 'statusClearedAck',
      type: 'string',
      label: 'Status — cleared and acknowledged',
      description: 'The condition ended and it has been signed for. Finished.',
      default: ALARM_STATUS_TEXT_DEFAULT.clearedAck,
      maxLength: 60,
      group: 'Status Wording',
    },
  ],
};
