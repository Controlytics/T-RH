/**
 * Widget data keys (2026-10-28): which keys a set of instruments has, and — in
 * `buildLatestValues` — what each one currently reads. Spec:
 * docs/superpowers/specs/2026-10-28-widget-data-keys-design.md (§4, §5).
 *
 * Ingest stores every key a device sends, so a key nobody configured is already
 * on record; this is how a widget's picker finds it. Nothing here decides a
 * key's unit, precision or bounds on its own: a MEASURED key takes them from the
 * profile's measurements (through `profile-measurements.ts`, the one resolver)
 * and, for values, from `buildTelemetryOverview()`; a RAW key gets none.
 *
 * The callers pass instrument ids ALREADY reduced to what the viewer may see.
 */
import {
  attributeLabel, coerceAttributeLabels, ATTRIBUTE_LABELS_CONFIG_KEY,
  type DataKeyInfo, type DataKeyMeasurement, type InstrumentSlotConfig, type MeasurementType, type TelemetrySlot,
} from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';
import { getAttributeKeyCatalogue, getKeyCatalogue } from './telemetry.repository.js';
import { loadMeasurementTypes, slotConfigLookup } from './profile-measurements.js';
import { offsetKeyTest } from './load-offsets.js';

/** The measurement-type code each phase-1 slot carries (`measurement_types.code`). */
const SLOT_MEASUREMENT: Record<TelemetrySlot, string> = { temperature: 'TEMPERATURE', humidity: 'HUMIDITY' };

/**
 * Which slot this telemetry key carries for one profile, or null for a raw key.
 *
 * Case-FOLDED against the profile's device keys, exactly as `resolveSlot` and
 * the telemetry route's `slotFor` match them — a device sending `T` to a profile
 * listing `t` is still sending its temperature. A slot the profile does not
 * measure carries nothing.
 */
export function measuredSlotFor(cfg: InstrumentSlotConfig, key: string): TelemetrySlot | null {
  const k = key.trim().toLowerCase();
  for (const slot of ['temperature', 'humidity'] as const) {
    if (cfg.measured[slot] && cfg.aliases[slot].includes(k)) return slot;
  }
  return null;
}

/** The registry entry for a slot; a registry missing it still names the code. */
export function measurementFor(slot: TelemetrySlot, types: MeasurementType[]): DataKeyMeasurement {
  const code = SLOT_MEASUREMENT[slot];
  const t = types.find((x) => x.code === code);
  return { code, name: t?.name ?? code, unit: t?.unit ?? '' };
}

/**
 * The key catalogue for `GET /api/instruments/data-keys`: telemetry keys first
 * (newest activity first), then attribute keys by label.
 *
 * A telemetry key is MEASURED when any instrument's profile in the set maps it;
 * it is then labelled by the measurement's name so the picker reads
 * "Temperature", not `t`. Offset attributes are SUPER_ADMIN-only — absent, not
 * masked — the attributes route's rule.
 */
export async function buildKeyCatalogue(opts: {
  instruments: { id: string; profileId: string }[];
  isSuperAdmin: boolean;
}): Promise<DataKeyInfo[]> {
  const ids = opts.instruments.map((i) => i.id);
  if (ids.length === 0) return [];
  const [telemetry, attributes, slotOf, types, labelsRow, isOffset] = await Promise.all([
    getKeyCatalogue(ids),
    getAttributeKeyCatalogue(ids),
    slotConfigLookup(),
    loadMeasurementTypes(),
    prisma.systemConfig.findUnique({ where: { configKey: ATTRIBUTE_LABELS_CONFIG_KEY } }),
    offsetKeyTest(),
  ]);
  const configs = [...new Set(opts.instruments.map((i) => i.profileId))].map((p) => slotOf(p));
  const labels = coerceAttributeLabels(labelsRow?.configValue);

  const fromTelemetry: DataKeyInfo[] = telemetry.map((row) => {
    const slot = configs.map((c) => measuredSlotFor(c, row.key)).find((x) => x !== null) ?? null;
    const measurement = slot ? measurementFor(slot, types) : null;
    return {
      source: 'telemetry',
      key: row.key,
      label: measurement?.name ?? row.key,
      numeric: row.numeric,
      instruments: row.instruments,
      lastSeen: row.lastSeen.toISOString(),
      measurement,
    };
  });

  const fromAttributes: DataKeyInfo[] = attributes
    .filter((row) => opts.isSuperAdmin || !isOffset(row.key))
    .map((row): DataKeyInfo => ({
      source: 'attribute',
      key: row.key,
      label: attributeLabel(labels, row.key),
      numeric: false,
      instruments: row.instruments,
      lastSeen: row.lastSeen.toISOString(),
      measurement: null,
    }))
    .sort((x, y) => x.label.localeCompare(y.label));

  return [...fromTelemetry, ...fromAttributes];
}
