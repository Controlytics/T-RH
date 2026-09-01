import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';
import { ALARM_TYPE_NAME_DEFAULT, ALARM_TYPE_NAME_MAX } from '@digilog/shared';

/**
 * What each kind of alarm is CALLED — one name per type, one place to change it.
 *
 * A rename here applies EVERYWHERE a type is shown: the Alarms page's Type
 * column, the Type filter's dropdown, the trend page's alarms widget, the signed
 * PDF, and the value of `${ruleName}` in every notification and webhook body.
 * Those were four separate hardcoded lists before, and the last one did not even
 * agree with the others — an email said `TEMPERATURE HIGH limit` while the table
 * beside it said `High Temperature`.
 *
 * **Names are read live, not frozen onto the alarm.** Renaming a type re-labels
 * history too, which is what "apply everywhere" means. Nothing a §11 record turns
 * on moves with it: the limit, the span, the reading and the precision stay
 * frozen exactly as they were at raise time.
 *
 * Not here on purpose: the name of an individual RULE alarm, which comes from the
 * rule you authored on Configuration → Alarm Rules. Only the filter's collective
 * wording is configurable, or a rename here would silently replace every rule's
 * own name on the page.
 */
export const alarmTypeNamesDef: ModuleConfigDefinition = {
  moduleKey: 'alarm-type-names',
  moduleName: 'Alarm Type Names',
  description: 'What each kind of alarm is called, everywhere it is shown.',
  icon: 'bell',
  category: 'system',
  sortOrder: 21,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: false,
  settings: [
    {
      key: 'limitTemperatureHigh',
      type: 'string',
      label: 'High temperature limit',
      description: "Shown when a reading breaches the instrument's High Temperature Limit.",
      default: ALARM_TYPE_NAME_DEFAULT.limitTemperatureHigh,
      maxLength: ALARM_TYPE_NAME_MAX,
      group: 'Alarm Type Names',
    },
    {
      key: 'limitTemperatureLow',
      type: 'string',
      label: 'Low temperature limit',
      description: 'Shown when a reading breaches the Low Temperature Limit.',
      default: ALARM_TYPE_NAME_DEFAULT.limitTemperatureLow,
      maxLength: ALARM_TYPE_NAME_MAX,
      group: 'Alarm Type Names',
    },
    {
      key: 'limitHumidityHigh',
      type: 'string',
      label: 'High humidity limit',
      description: 'Shown when a reading breaches the High Humidity Limit.',
      default: ALARM_TYPE_NAME_DEFAULT.limitHumidityHigh,
      maxLength: ALARM_TYPE_NAME_MAX,
      group: 'Alarm Type Names',
    },
    {
      key: 'limitHumidityLow',
      type: 'string',
      label: 'Low humidity limit',
      description: 'Shown when a reading breaches the Low Humidity Limit.',
      default: ALARM_TYPE_NAME_DEFAULT.limitHumidityLow,
      maxLength: ALARM_TYPE_NAME_MAX,
      group: 'Alarm Type Names',
    },
    {
      key: 'rangeTemperature',
      type: 'string',
      label: 'Temperature out of sensor range',
      description: 'Shown when a temperature reading falls outside what the probe can measure — the alarm that displays OL.',
      default: ALARM_TYPE_NAME_DEFAULT.rangeTemperature,
      maxLength: ALARM_TYPE_NAME_MAX,
      group: 'Alarm Type Names',
    },
    {
      key: 'rangeHumidity',
      type: 'string',
      label: 'Humidity out of sensor range',
      description: 'Shown when a humidity reading falls outside what the probe can measure.',
      default: ALARM_TYPE_NAME_DEFAULT.rangeHumidity,
      maxLength: ALARM_TYPE_NAME_MAX,
      group: 'Alarm Type Names',
    },
    {
      key: 'rs485Temperature',
      type: 'string',
      label: 'Temperature sensor sent no number',
      description: 'Shown when the temperature slot reports NA or any non-numeric value.',
      default: ALARM_TYPE_NAME_DEFAULT.rs485Temperature,
      maxLength: ALARM_TYPE_NAME_MAX,
      group: 'Alarm Type Names',
    },
    {
      key: 'rs485Humidity',
      type: 'string',
      label: 'Humidity sensor sent no number',
      description: 'Shown when the humidity slot reports NA or any non-numeric value.',
      default: ALARM_TYPE_NAME_DEFAULT.rs485Humidity,
      maxLength: ALARM_TYPE_NAME_MAX,
      group: 'Alarm Type Names',
    },
    {
      key: 'inactivity',
      type: 'string',
      label: 'Instrument stopped reporting',
      description: 'Shown when an instrument goes quiet.',
      default: ALARM_TYPE_NAME_DEFAULT.inactivity,
      maxLength: ALARM_TYPE_NAME_MAX,
      group: 'Alarm Type Names',
    },
  ],
};
