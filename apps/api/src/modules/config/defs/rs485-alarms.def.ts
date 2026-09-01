import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';
import { RS485_ALARMS_DEFAULT, RS485_FAILURE_TEXT_MAX } from '@digilog/shared';

/**
 * RS485 sensor-failure alarms — raised when a sensor reports a non-numeric value
 * on a temperature or humidity slot key, cleared when it reports a number again.
 *
 * A FOURTH alarm source, and the only one that can see this fault. When an RS485
 * probe fails, the logger keeps talking and sends `NA` where the reading should
 * be — so the device is never "offline" (INACTIVITY cannot see it), the reading
 * is discarded before any comparison (INSTRUMENT_LIMIT cannot see it), and the
 * dashboard renders an empty cell that looks exactly like an instrument which has
 * never reported.
 *
 * **It ships ON**, unlike `inactivity-alarms`. See RS485_ALARMS_DEFAULT for the
 * measurement behind that: nothing on this installation would alarm on the first
 * pass, so there is no storm to protect against.
 *
 * ONE wording setting, `failureText`, and it is used EVERYWHERE a failed
 * sensor's value would otherwise appear — the Alarms page, the dashboard cells
 * and tiles, the trend page's raw table, the notification body and the webhook
 * payload. One field, one word, every surface (operator, 2026-08-31).
 *
 * **This replaced showing the raw text the sensor sent.** That was the original
 * design — evidence over an administered phrase — and it was wrong in practice
 * for one reason: the raw text is usually `NA`, and `NA` is already what the
 * dashboard shows for a slot with NO reading at all. A dead probe and an
 * instrument nobody has wired up rendered identically, which is the exact
 * confusion this alarm exists to remove. **No evidence was lost**: the raw value
 * is still frozen on `ruleSnapshot.rawValue` and still named in the alarm's
 * condition line, which is what the notification and the webhook print beside
 * the value.
 *
 * The Limit cell stays the constant `RS485_LIMIT_TEXT` — there is nothing to
 * administer about "a sensor should send a number".
 */
export const rs485AlarmsDef: ModuleConfigDefinition = {
  moduleKey: 'rs485-alarms',
  moduleName: 'RS485 Sensor Failure Alarms',
  description: 'Raise an alarm when a sensor reports a non-numeric value such as NA, and clear it when a number returns.',
  icon: 'bell',
  category: 'system',
  sortOrder: 19,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: false,
  settings: [
    {
      key: 'enabled',
      type: 'boolean',
      label: 'Raise an alarm when a sensor reports a non-numeric value',
      description:
        'Ships ON. A temperature or humidity reading that is not a number — NA, ERR, or even a quoted "23.5" — means the RS485 probe or its bus has failed while the logger keeps reporting. Temperature and humidity are judged separately, so a logger with both probes failed raises two alarms. Alarms already raised are never touched by this switch; they are regulated records.',
      default: RS485_ALARMS_DEFAULT.enabled,
      group: 'RS485 Sensor Failure Alarms',
    },
    {
      key: 'failureText',
      type: 'string',
      label: 'Show this instead of the value',
      description:
        'The word shown wherever a failed sensor\'s reading would appear: the Alarms page, the dashboard, the trend table, and the value field of every alarm notification and webhook. Defaults to "Error", deliberately NOT "NA" — a slot with no reading at all already shows NA, and a broken probe is a different fault from one nobody has wired up yet. The raw value the sensor sent is still recorded on the alarm and named in its condition. Blank falls back to "Error"; an empty value cell would read as nothing being wrong.',
      default: RS485_ALARMS_DEFAULT.failureText,
      maxLength: RS485_FAILURE_TEXT_MAX,
      group: 'RS485 Sensor Failure Alarms',
    },
  ],
};
