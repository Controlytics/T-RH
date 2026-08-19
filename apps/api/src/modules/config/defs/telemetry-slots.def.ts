import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';
import {
  TELEMETRY_SLOT_ALIASES_DEFAULT,
  TELEMETRY_DECIMALS_KEYS_DEFAULT,
  TELEMETRY_DECIMALS_FALLBACK,
  TELEMETRY_DECIMALS_MAX,
  TELEMETRY_VALUED_KEYS_DEFAULT,
} from '@digilog/shared';

/**
 * Which telemetry key means "temperature", and which means "humidity".
 *
 * Ingest imposes no vocabulary — a device's payload keys are stored verbatim.
 * This install's devices send `temperature` / `humidity`; the e2e suite
 * exercises `temp` / `rh`; the next vendor will send something else. Without an
 * administered mapping, that vendor's instruments render blank cells on the
 * dashboard and nothing on screen explains why.
 *
 * Newline-separated and ORDERED: the first alias any reading matches wins, so a
 * device sending both `temperature` and `temp` resolves identically on every
 * request. Parsing lives in @digilog/shared so the API and the web app cannot
 * disagree about what a line means.
 *
 * DECIMAL PLACES are not a site-wide number. Precision belongs to the device —
 * a probe resolving to 0.1 °C and one reporting whole degrees appear in the same
 * table — so it is read from each instrument's own attributes
 * (`temp_decimals` / `humid_decimals`) and the settings below are the KEY MAPPING
 * plus the fallback for an instrument that declares neither. Resolution lives in
 * @digilog/shared/telemetry-decimals so the API, the web app and the alarm
 * evaluator cannot disagree about one instrument's precision.
 *
 * The refresh settings are here rather than hardcoded because "live" on this
 * dashboard is POLLING, not push — this repo has no browser-facing WebSocket or
 * SSE channel. A site with hundreds of instruments needs to be able to slow the
 * poll down without a code change.
 */
export const telemetrySlotsDef: ModuleConfigDefinition = {
  moduleKey: 'telemetry-slots',
  moduleName: 'Telemetry Keys',
  description: 'Which telemetry keys the dashboard reads as temperature and humidity, and how often it refreshes.',
  icon: 'activity',
  category: 'system',
  sortOrder: 16,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: false,
  settings: [
    {
      key: 'temperatureKeys',
      type: 'textarea',
      label: 'Temperature keys',
      description: 'One key per line, most preferred first. A reading matching the first line wins over one matching the second.',
      default: TELEMETRY_SLOT_ALIASES_DEFAULT.temperature,
      maxLength: 500,
      group: 'Key Mapping',
    },
    {
      key: 'humidityKeys',
      type: 'textarea',
      label: 'Humidity keys',
      description: 'One key per line, most preferred first.',
      default: TELEMETRY_SLOT_ALIASES_DEFAULT.humidity,
      maxLength: 500,
      group: 'Key Mapping',
    },
    {
      key: 'temperatureDecimalsKeys',
      type: 'textarea',
      label: 'Temperature decimals — attribute keys',
      description: 'One key per line, most preferred first. Set the value on the instrument: 0 for whole numbers, 1 for one decimal.',
      default: TELEMETRY_DECIMALS_KEYS_DEFAULT.temperature,
      maxLength: 500,
      group: 'Display',
    },
    {
      key: 'humidityDecimalsKeys',
      type: 'textarea',
      label: 'Humidity decimals — attribute keys',
      description: 'One key per line, most preferred first.',
      default: TELEMETRY_DECIMALS_KEYS_DEFAULT.humidity,
      maxLength: 500,
      group: 'Display',
    },
    {
      key: 'temperatureValuedKeys',
      type: 'textarea',
      label: 'Attribute keys holding a temperature',
      description: 'One per line. Their values are shown at the temperature precision above — limits, ranges, anything measured in degrees.',
      default: TELEMETRY_VALUED_KEYS_DEFAULT.temperature,
      maxLength: 2000,
      group: 'Display',
    },
    {
      key: 'humidityValuedKeys',
      type: 'textarea',
      label: 'Attribute keys holding a humidity',
      description: 'One per line.',
      default: TELEMETRY_VALUED_KEYS_DEFAULT.humidity,
      maxLength: 2000,
      group: 'Display',
    },
    {
      key: 'temperatureDecimals',
      type: 'number',
      label: 'Temperature decimals — default',
      description: 'Used only for an instrument with no decimals attribute. Does not change what is stored.',
      default: TELEMETRY_DECIMALS_FALLBACK,
      min: 0,
      max: TELEMETRY_DECIMALS_MAX,
      group: 'Display',
    },
    {
      key: 'humidityDecimals',
      type: 'number',
      label: 'Humidity decimals — default',
      description: 'Used only for an instrument with no decimals attribute.',
      default: TELEMETRY_DECIMALS_FALLBACK,
      min: 0,
      max: TELEMETRY_DECIMALS_MAX,
      group: 'Display',
    },
    {
      key: 'overviewRefreshSeconds',
      type: 'number',
      label: 'Dashboard refresh (seconds)',
      description: 'How often the table and floorplan re-poll for current readings. This is polling, not a live push — the browser asks on this interval.',
      default: 5,
      min: 2,
      max: 600,
      group: 'Refresh',
    },
    {
      key: 'chartRefreshSeconds',
      type: 'number',
      label: 'Chart refresh (seconds)',
      description: 'How often an open time-series chart re-polls.',
      default: 10,
      min: 2,
      max: 600,
      group: 'Refresh',
    },
  ],
};
