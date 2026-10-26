/**
 * SENSOR OFFSETS (2026-10-01) — a per-instrument calibration correction added
 * to every temperature / humidity reading AS IT ARRIVES.
 *
 * Operator: "for instruments profiles Add 2 attributes Temp Off set, Humid Off
 * set, those should be visible only for superadmin … values should be integer
 * or decimal … whenever temperature is received and temp off set value is 2
 * then 2 will be added to temperature value and that value should show every
 * where … same like humidity also … give configuration also", then "there
 * should be + or - option if + it should add, if - value should be decrease".
 * Decisions put to them: applied AT INGEST (the corrected value is what is
 * stored, so an offset change affects only new readings and history stays as
 * it was shown and alarmed on); negative allowed; the names as written; the
 * device's original value is NOT shown anywhere.
 *
 * Offsets are instrument ATTRIBUTES, so setting one is the existing audited
 * attribute change with a remark. WHICH attribute is a measurement's offset is
 * the instrument PROFILE's since 2026-10-26 (`offsetKeys` on each profile
 * measurement — @digilog/shared/profile-measurements); the config row
 * (Configuration → Sensor Offsets) keeps only the master switch.
 *
 * **SUPER_ADMIN only.** Every other role neither sees the attributes (the
 * server strips them from every response) nor can write them. That is
 * `isOffsetAttributeKey` — the ONE test of "is this key an offset", over the
 * key set the server resolves.
 */
import type { TelemetrySlot } from './telemetry-slots.js';
import { coerceReading } from './rs485-alarms.js';

export const SENSOR_OFFSETS_CONFIG_KEY = 'sensor-offsets';

/**
 * Newline-separated, most-preferred first — the same wire format as every key
 * list. The keys a NEVER-CUSTOMISED profile uses (`DEFAULT_PROFILE_MEASUREMENTS`).
 */
export const SENSOR_OFFSET_KEYS_DEFAULT: Record<TelemetrySlot, string> = {
  temperature: 'Temp Off set',
  humidity: 'Humid Off set',
};

export interface SensorOffsetConfig {
  /** Master switch. Absent = ON: an offset only does anything once a super
   *  admin has typed one onto an instrument. */
  enabled: boolean;
}

export function coerceSensorOffsetConfig(value: unknown): SensorOffsetConfig {
  const o = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return { enabled: o.enabled !== false };
}

/**
 * Is this attribute key an offset? Case- and space-folded, against a set of
 * already-folded offset keys (the server's: one profile's, or every profile's
 * where no instrument is in hand).
 */
export function isOffsetAttributeKey(offsetKeys: ReadonlySet<string>, key: string): boolean {
  return offsetKeys.has(key.trim().toLowerCase());
}

/**
 * An offset attribute's value → a number, or null when it is not one.
 *
 * An integer or a decimal with an optional SIGN: `2`, `+2`, `-2`, `1.0`,
 * `-0.5`, `.5`. A leading `+` ADDS, a leading `-` SUBTRACTS (the operator's
 * "+ or - option"); no sign adds. Anything else — `2 C`, `two`, `1,5`, blank —
 * is null: refused on write, and never applied to a reading.
 */
export function parseOffsetValue(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** What a write is told when the value is not a number. */
export const SENSOR_OFFSET_VALUE_MESSAGE =
  'An offset must be a number, optionally signed: + adds it to the reading, - subtracts it (e.g. +2, -1.5, 0.5).';

/**
 * The stored form of an offset: the sign always written, so `+` and `-` read
 * back as chosen. `2` → `+2`, `-1.50` → `-1.5`.
 */
export function formatOffsetValue(n: number): string {
  const s = String(Number(n.toFixed(10)));
  return n < 0 ? s : `+${s}`;
}

/**
 * The corrected reading. Rounded to 10 decimals so `23.4 + 2` stores 25.4, not
 * 25.400000000000002 — the precision a reading is SHOWN at is the instrument's
 * own decimals, applied later; this only removes binary-float noise.
 */
export function applyOffset(value: number, offset: number): number {
  return Number((value + offset).toFixed(10));
}

/**
 * Correct one instrument's readings. A reading is corrected when its KEY is one
 * of that slot's device keys (the instrument PROFILE's — the same list that
 * decides what the dashboard calls temperature) AND its value is a
 * reading (`coerceReading`, so `"23.5"` counts and `NA` does not — a sensor
 * failure word is left exactly as sent, or RS485 detection would never see it).
 * The corrected value is stored as a NUMBER; `rawValue` keeps what the device
 * sent. Pure: the API resolves the aliases and the instrument's offsets.
 *
 * `classify` names the corrected number's `valueType`, in the INGEST
 * VOCABULARY the caller owns (`classifyValue` in the API's payload parser:
 * `int` | `float`). This file wrote the literal `'number'` until audit
 * 2026-10-03 INGEST-11 — a word outside that vocabulary, which the documented
 * RS485 probe query (`value_type NOT IN ('int','float')`) would have read as a
 * failed probe on every corrected reading. The vocabulary is not restated
 * here: a second copy in a second package is how the two drift.
 */
export function offsetReadings<R extends { key: string; value: unknown; valueType: string }>(
  readings: R[],
  slotAliases: Record<TelemetrySlot, string[]>,
  offsets: Partial<Record<TelemetrySlot, number>>,
  classify: (corrected: number) => R['valueType'],
): (R & { rawValue?: unknown })[] {
  return readings.map((r) => {
    const k = r.key.trim().toLowerCase();
    const slot: TelemetrySlot | null = slotAliases.temperature.includes(k) ? 'temperature'
      : slotAliases.humidity.includes(k) ? 'humidity' : null;
    const offset = slot ? offsets[slot] : undefined;
    if (slot === null || offset === undefined || offset === 0) return r;
    const n = coerceReading(r.value);
    if (n === null) return r;
    const corrected = applyOffset(n, offset);
    return { ...r, value: corrected, valueType: classify(corrected), rawValue: r.value };
  });
}
