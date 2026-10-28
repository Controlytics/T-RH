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
  type DataKeyInfo, type DataKeyJudged, type DataKeyMeasurement, type DataKeyRef, type InstrumentSlotConfig,
  type LatestKeyValue, type LatestValuesRow, type MeasurementType, type TelemetrySlot,
} from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';
import { getAttributeKeyCatalogue, getKeyCatalogue, getLatestFor } from './telemetry.repository.js';
import { loadMeasurementTypes, slotConfigLookup } from './profile-measurements.js';
import { offsetKeyTest } from './load-offsets.js';
import { buildTelemetryOverview, type OverviewRow } from './telemetry-overview.js';
import { annotateAttribute } from './decimals.js';

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

/** A measured key's bounds and fault flags, read off the overview row for its slot. */
function judgedFor(row: OverviewRow, slot: TelemetrySlot): DataKeyJudged {
  const t = slot === 'temperature';
  return {
    limitMin: (t ? row.limits?.tempMin : row.limits?.rhMin) ?? null,
    limitMax: (t ? row.limits?.tempMax : row.limits?.rhMax) ?? null,
    limitMinText: t ? row.limitText.tempMin : row.limitText.rhMin,
    limitMaxText: t ? row.limitText.tempMax : row.limitText.rhMax,
    sensorError: row.sensorError[slot],
    rangeError: row.rangeError[slot],
  };
}

const fold = (k: string) => k.trim().toLowerCase();

/**
 * What each named key currently reads on each instrument, for
 * `POST /api/instruments/latest-values` — rows in the overview's order, values in
 * the REQUESTED key order.
 *
 * The rows ARE `buildTelemetryOverview()`'s, narrowed to these instruments and
 * ANDed with the caller's visibility, so a measured key's precision, bounds and
 * fault flags are the overview's own answer — the one the dashboard table and
 * the alarm evaluator use — and nothing here resolves a limit a second time.
 *
 * A telemetry key is MEASURED on an instrument when its profile maps it to a
 * slot AND it is the key that slot resolved to (or the slot has no reading
 * yet). An instrument sending two device keys of one slot has ONE temperature,
 * the first in the profile's order; the other key is shown raw, not judged
 * twice. A raw key carries no unit, no precision (print as received) and no
 * judgement. Offset attributes are SUPER_ADMIN-only: absent otherwise.
 */
export async function buildLatestValues(opts: {
  instrumentIds: string[];
  keys: DataKeyRef[];
  isSuperAdmin: boolean;
  visibilityWhere?: object;
}): Promise<LatestValuesRow[]> {
  const rows = await buildTelemetryOverview({ instrumentIds: opts.instrumentIds, visibilityWhere: opts.visibilityWhere });
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.instrumentId);
  const telemetryKeys = [...new Set(opts.keys.filter((k) => k.source === 'telemetry').map((k) => k.key))];
  const wantsAttributes = opts.keys.some((k) => k.source === 'attribute');

  const [slotOf, types, readings, attributes, seen, isOffset] = await Promise.all([
    slotConfigLookup(),
    loadMeasurementTypes(),
    getLatestFor(ids, telemetryKeys),
    wantsAttributes
      ? prisma.instrumentAttribute.findMany({
          where: { instrumentId: { in: ids } },
          select: { instrumentId: true, key: true, value: true, updatedAt: true },
          // Ordered, so an instrument carrying both `Room` and `room` answers the
          // same one on every request.
          orderBy: { key: 'asc' },
        })
      : Promise.resolve([] as { instrumentId: string; key: string; value: string; updatedAt: Date }[]),
    prisma.instrument.findMany({ where: { id: { in: ids } }, select: { id: true, lastSeenAt: true } }),
    offsetKeyTest(),
  ]);

  const readingOf = new Map(readings.map((r) => [`${r.instrumentId}|${r.key}`, r]));
  const attributesOf = new Map<string, typeof attributes>();
  for (const a of attributes) {
    const list = attributesOf.get(a.instrumentId);
    if (list) list.push(a);
    else attributesOf.set(a.instrumentId, [a]);
  }
  const lastSeenOf = new Map(seen.map((i) => [i.id, i.lastSeenAt]));

  return rows.map((row) => {
    const cfg = slotOf(row.profileId);
    const values = opts.keys.map((ref): LatestKeyValue => {
      if (ref.source === 'telemetry') {
        const r = readingOf.get(`${row.instrumentId}|${ref.key}`);
        const slot = measuredSlotFor(cfg, ref.key);
        const resolved = slot ? row.rawSlots[slot]?.key ?? null : null;
        const measured = slot !== null && (resolved === null || resolved === ref.key);
        return {
          source: 'telemetry',
          key: ref.key,
          value: r?.value ?? null,
          ts: r ? r.ts.toISOString() : null,
          unit: measured ? measurementFor(slot, types).unit : null,
          decimals: measured ? row.decimals[slot] : null,
          display: null,
          judged: measured ? judgedFor(row, slot) : null,
        };
      }
      const hit = (attributesOf.get(row.instrumentId) ?? [])
        .find((a) => fold(a.key) === fold(ref.key) && a.value.trim() !== '');
      const hidden = !opts.isSuperAdmin && (isOffset(ref.key) || (hit !== undefined && isOffset(hit.key)));
      const attr = hidden ? undefined : hit;
      return {
        source: 'attribute',
        key: ref.key,
        value: attr?.value ?? null,
        ts: attr ? attr.updatedAt.toISOString() : null,
        unit: null,
        decimals: null,
        display: attr ? annotateAttribute(cfg.decimals, row.decimals, attr).display : null,
        judged: null,
      };
    });
    return {
      instrumentId: row.instrumentId,
      code: row.code,
      name: row.name,
      functionalLocationName: row.functionalLocationName,
      locationAttribute: row.locationAttribute,
      reporting: row.reporting,
      lastSeenAt: lastSeenOf.get(row.instrumentId)?.toISOString() ?? null,
      values,
    };
  });
}
