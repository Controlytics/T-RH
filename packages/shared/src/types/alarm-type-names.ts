import { INACTIVITY_TYPE_LABEL } from './inactivity-alarms.js';
import { RS485_TYPE_LABEL } from './rs485-alarms.js';
import { SENSOR_RANGE_TYPE_LABEL } from './sensor-range.js';

/**
 * What each kind of alarm is CALLED — one administered name per type, used
 * everywhere a type is shown.
 *
 * Before this existed the same alarm was named in four places that could drift:
 * the Alarms page's Type column, the type filter's dropdown, the signed PDF, and
 * the `ruleName` in every notification and webhook body. The last one did not
 * even match the others — a high-temperature breach printed `TEMPERATURE HIGH
 * limit` in an email while the table beside it said `High Temperature`. Renaming
 * a type had to be done in code, four times, or the surfaces disagreed.
 *
 * **Read live, not frozen onto the alarm.** A type name is a label, not a
 * measurement: renaming one re-labels history too, which is the point — the
 * operator asked for a rename to apply everywhere. The numbers a §11 record turns
 * on (the limit, the span, the reading, the precision) stay frozen as they were.
 */
export type AlarmTypeKey =
  | 'limitTemperatureHigh'
  | 'limitTemperatureLow'
  | 'limitHumidityHigh'
  | 'limitHumidityLow'
  | 'inactivity'
  | 'rs485Temperature'
  | 'rs485Humidity'
  | 'rangeTemperature'
  | 'rangeHumidity';

/** Every key, in the order the config page lists them. */
export const ALARM_TYPE_KEYS: readonly AlarmTypeKey[] = [
  'limitTemperatureHigh', 'limitTemperatureLow', 'limitHumidityHigh', 'limitHumidityLow',
  'rangeTemperature', 'rangeHumidity',
  'rs485Temperature', 'rs485Humidity',
  'inactivity',
] as const;

export type AlarmTypeNames = Partial<Record<AlarmTypeKey, string>>;

/**
 * The shipped names.
 *
 * Taken FROM the existing per-source constants rather than restated, so this file
 * cannot drift from the labels those sources already use in their own comments
 * and tests.
 */
export const ALARM_TYPE_NAME_DEFAULT: Record<AlarmTypeKey, string> = {
  limitTemperatureHigh: 'High Temperature',
  limitTemperatureLow: 'Low Temperature',
  limitHumidityHigh: 'High Humidity',
  limitHumidityLow: 'Low Humidity',
  inactivity: INACTIVITY_TYPE_LABEL,
  rs485Temperature: RS485_TYPE_LABEL.TEMPERATURE,
  rs485Humidity: RS485_TYPE_LABEL.HUMIDITY,
  rangeTemperature: SENSOR_RANGE_TYPE_LABEL.TEMPERATURE,
  rangeHumidity: SENSOR_RANGE_TYPE_LABEL.HUMIDITY,
};

/** How long a type name may be. It sits in a table column, a dropdown, an email
 *  subject and a webhook body; a sentence would wreck all four. */
export const ALARM_TYPE_NAME_MAX = 40;

/**
 * Which name an alarm uses, from the three columns that identify it.
 *
 * **The ONE place this mapping lives.** The browser labels the row with it and
 * the worker labels the notification with it, so an alarm cannot be called one
 * thing on the page and another in the email about it.
 *
 * Returns null for a RULE alarm: those are named by their own rule, and falling
 * back to a generic word would replace an operator's chosen rule name with
 * "Rule alarms" on every row.
 */
export function alarmTypeKeyFor(
  source: string | undefined,
  metric: string,
  limitKind?: string | null,
): AlarmTypeKey | null {
  const isTemp = metric === 'TEMPERATURE';
  // Checked before the limit branch, exactly as the display helper does: these
  // sources carry metric TEMPERATURE or HUMIDITY too, so metric alone cannot
  // identify them.
  if (source === 'INACTIVITY') return 'inactivity';
  if (source === 'RS485_FAILURE') return isTemp ? 'rs485Temperature' : 'rs485Humidity';
  if (source === 'SENSOR_RANGE') return isTemp ? 'rangeTemperature' : 'rangeHumidity';
  if (source === 'INSTRUMENT_LIMIT' && limitKind) {
    const high = limitKind === 'HIGH';
    if (isTemp) return high ? 'limitTemperatureHigh' : 'limitTemperatureLow';
    return high ? 'limitHumidityHigh' : 'limitHumidityLow';
  }
  return null;
}

/**
 * The administered name, or the shipped one when it is blank, absent or still
 * loading.
 *
 * Same rule as every other configurable wording here: an admin clearing the field
 * must not be able to leave a blank where the type should be.
 */
export function alarmTypeName(names: AlarmTypeNames | undefined, key: AlarmTypeKey): string {
  const v = names?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : ALARM_TYPE_NAME_DEFAULT[key];
}
