import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';
import { SENSOR_RANGE_KEYS_DEFAULT, SENSOR_RANGE_TEXT_DEFAULT, SENSOR_RANGE_TEXT_MAX } from '@digilog/shared';

/**
 * Sensor RANGE failures — a reading outside what the probe can physically
 * measure.
 *
 * **Range is not a limit.** Every instrument here carries both, and they answer
 * different questions: `High Temperature Limit` = 25 is the SPEC (breaching it is
 * a product excursion), `High Temperature Range` = 50 is the PROBE's span
 * (leaving it means the number is not a measurement at all). A reading outside
 * the range is therefore treated as NO READING — it raises this alarm, and it is
 * excluded from limit evaluation rather than reported as an excursion nobody can
 * trust. Operator decision, 2026-08-31.
 *
 * Its own def rather than more settings on `alarm-limits`: this is a separate
 * alarm source with its own switch, the same way
 * `inactivity-alarms` and `rs485-alarms` are, and burying its master switch
 * inside the limits page would make it very hard to find.
 */
export const sensorRangeAlarmsDef: ModuleConfigDefinition = {
  moduleKey: 'sensor-range-alarms',
  moduleName: 'Sensor Range Alarms',
  description: 'Raise an alarm when a reading falls outside the sensor\'s measurable range, and show OL instead of the value.',
  icon: 'bell',
  category: 'system',
  sortOrder: 20,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: false,
  settings: [
    {
      key: 'enabled',
      type: 'boolean',
      label: 'Raise an alarm when a reading is outside the sensor range',
      description:
        'Ships ON. A reading above the High Range or below the Low Range attribute means the probe is saturated or faulty, not that the room is hot. Temperature and humidity are judged separately, so a logger failing on both raises two alarms. While a reading is out of range it is treated as NO READING: it raises no limit alarm and cannot clear one, because a number the sensor cannot stand behind proves nothing either way.',
      default: true,
      group: 'Sensor Range Alarms',
    },
    {
      key: 'rangeText',
      type: 'string',
      label: 'Show this instead of the value',
      description:
        'Shown wherever an out-of-range reading would appear: the dashboard, the Alarms page, the trend table, and the value field of every notification and webhook. Defaults to "OL", the abbreviation a physical instrument displays for an over-range input. Kept separate from the RS485 failure word on purpose — "the sensor sent nonsense" and "the sensor sent a number it cannot stand behind" call for different checks.',
      default: SENSOR_RANGE_TEXT_DEFAULT,
      maxLength: SENSOR_RANGE_TEXT_MAX,
      group: 'Sensor Range Alarms',
    },
    {
      key: 'temperatureHighKeys',
      type: 'textarea',
      label: 'High temperature range — attribute keys',
      description: 'One attribute key per line, most preferred first. The first key an instrument actually has wins. These are the keys your instruments already carry.',
      default: SENSOR_RANGE_KEYS_DEFAULT.temperatureHigh,
      maxLength: 500,
      group: 'Range Attribute Keys',
    },
    {
      key: 'temperatureLowKeys',
      type: 'textarea',
      label: 'Low temperature range — attribute keys',
      description: 'One attribute key per line, most preferred first.',
      default: SENSOR_RANGE_KEYS_DEFAULT.temperatureLow,
      maxLength: 500,
      group: 'Range Attribute Keys',
    },
    {
      key: 'humidityHighKeys',
      type: 'textarea',
      label: 'High humidity range — attribute keys',
      description: 'One attribute key per line, most preferred first.',
      default: SENSOR_RANGE_KEYS_DEFAULT.humidityHigh,
      maxLength: 500,
      group: 'Range Attribute Keys',
    },
    {
      key: 'humidityLowKeys',
      type: 'textarea',
      label: 'Low humidity range — attribute keys',
      description: 'One attribute key per line, most preferred first.',
      default: SENSOR_RANGE_KEYS_DEFAULT.humidityLow,
      maxLength: 500,
      group: 'Range Attribute Keys',
    },
  ],
};
