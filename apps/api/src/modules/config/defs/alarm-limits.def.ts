import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';
import { ALARM_LIMIT_KEYS_DEFAULT, ALARM_LIMIT_ENABLE_KEYS_DEFAULT, ALARM_STATUS_TEXT_DEFAULT } from '@digilog/shared';

/**
 * Which instrument attributes carry the four limits, and what the alarm status
 * column says.
 *
 * Attribute keys are operator-typed free text and have already drifted in this
 * install (`High Temperature` vs `High Temperature Limit` vs `Low Temperature`).
 * An ordered alias list per bound resolves both spellings without anyone
 * re-keying existing instruments; the first listed key that an instrument has
 * wins, deterministically.
 *
 * Room limits (floorplan_rooms.temp_min/…) are a SEPARATE thing and raise
 * nothing — they colour the dashboard. Do not wire them in here.
 *
 * Design: docs/superpowers/specs/2026-08-17-instrument-limit-alarms-design.md
 */
export const alarmLimitsDef: ModuleConfigDefinition = {
  moduleKey: 'alarm-limits',
  moduleName: 'Instrument Limit Alarms',
  description: 'Which instrument attributes hold the temperature and humidity limits, and the wording of each alarm status.',
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
      key: 'temperatureHighKeys',
      type: 'textarea',
      label: 'High temperature limit — attribute keys',
      description: 'One attribute key per line, most preferred first. The first key an instrument actually has wins.',
      default: ALARM_LIMIT_KEYS_DEFAULT.temperatureHigh,
      maxLength: 500,
      group: 'Attribute Keys',
    },
    {
      key: 'temperatureLowKeys',
      type: 'textarea',
      label: 'Low temperature limit — attribute keys',
      description: 'One attribute key per line, most preferred first.',
      default: ALARM_LIMIT_KEYS_DEFAULT.temperatureLow,
      maxLength: 500,
      group: 'Attribute Keys',
    },
    {
      key: 'humidityHighKeys',
      type: 'textarea',
      label: 'High humidity limit — attribute keys',
      description: 'One attribute key per line, most preferred first.',
      default: ALARM_LIMIT_KEYS_DEFAULT.humidityHigh,
      maxLength: 500,
      group: 'Attribute Keys',
    },
    {
      key: 'humidityLowKeys',
      type: 'textarea',
      label: 'Low humidity limit — attribute keys',
      description: 'One attribute key per line, most preferred first.',
      default: ALARM_LIMIT_KEYS_DEFAULT.humidityLow,
      maxLength: 500,
      group: 'Attribute Keys',
    },
    {
      key: 'temperatureHighEnableKeys',
      type: 'textarea',
      label: 'High temperature limit — enable attribute',
      description: 'The attribute that says whether this bound is in force. NMT = "not more than". Set to 0/false on an instrument and its high temperature limit stops raising alarms, whatever the limit value says — and any alarm already open on that bound is cleared. Absent or unreadable means ENABLED, so a typo can never silence a bound.',
      default: ALARM_LIMIT_ENABLE_KEYS_DEFAULT.temperatureHigh,
      maxLength: 500,
      group: 'Enable Attribute Keys',
    },
    {
      key: 'temperatureLowEnableKeys',
      type: 'textarea',
      label: 'Low temperature limit — enable attribute',
      description: 'NLT = "not less than". One attribute key per line, most preferred first.',
      default: ALARM_LIMIT_ENABLE_KEYS_DEFAULT.temperatureLow,
      maxLength: 500,
      group: 'Enable Attribute Keys',
    },
    {
      key: 'humidityHighEnableKeys',
      type: 'textarea',
      label: 'High humidity limit — enable attribute',
      description: 'One attribute key per line, most preferred first.',
      default: ALARM_LIMIT_ENABLE_KEYS_DEFAULT.humidityHigh,
      maxLength: 500,
      group: 'Enable Attribute Keys',
    },
    {
      key: 'humidityLowEnableKeys',
      type: 'textarea',
      label: 'Low humidity limit — enable attribute',
      description: 'One attribute key per line, most preferred first.',
      default: ALARM_LIMIT_ENABLE_KEYS_DEFAULT.humidityLow,
      maxLength: 500,
      group: 'Enable Attribute Keys',
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
