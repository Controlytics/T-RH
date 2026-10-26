import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

/**
 * How often the dashboard and an open chart re-poll ("Dashboard Refresh").
 *
 * This def was "Telemetry Keys" until 2026-10-26: it also held which telemetry
 * key is temperature and which humidity, the decimals attribute keys, the
 * fallback decimals and the "valued" attribute keys. Those are each instrument
 * PROFILE's now — one entry per measurement on Configuration → Instrument
 * Attributes (`instrument_profiles.measurements`, design
 * docs/superpowers/specs/2026-10-26-profile-measurements-design.md) — because
 * profiles are device types and one device type's keys are not another's. The
 * migration copied this install's values onto every profile; the stored JSON
 * keys are left in the row, unread.
 *
 * The refresh settings stay here rather than hardcoded because "live" on this
 * dashboard is POLLING, not push — this repo has no browser-facing WebSocket or
 * SSE channel. A site with hundreds of instruments needs to be able to slow the
 * poll down without a code change. Every role reads them through
 * `GET /api/config/telemetry-slots/refresh`; this def stays SUPER_ADMIN to edit.
 * The `moduleKey` keeps its old name so the stored row is not orphaned.
 */
export const telemetrySlotsDef: ModuleConfigDefinition = {
  moduleKey: 'telemetry-slots',
  moduleName: 'Dashboard Refresh',
  description: 'How often the dashboard and charts refresh. Which keys mean temperature and humidity is set per instrument profile.',
  icon: 'activity',
  category: 'system',
  sortOrder: 16,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: false,
  settings: [
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
