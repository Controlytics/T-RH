import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';
import { TELEMETRY_SLOT_ALIASES_DEFAULT } from '@digilog/shared';

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
      key: 'temperatureDecimals',
      type: 'number',
      label: 'Temperature decimal places',
      description: 'How many decimals to show for temperature. Does not change what is stored.',
      default: 1,
      min: 0,
      max: 4,
      group: 'Display',
    },
    {
      key: 'humidityDecimals',
      type: 'number',
      label: 'Humidity decimal places',
      description: 'How many decimals to show for humidity. Does not change what is stored.',
      default: 1,
      min: 0,
      max: 4,
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
