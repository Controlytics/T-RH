/**
 * Payload parsing — PURE. No database, no imports.
 *
 * Three accepted shapes:
 *   flat     { "temp": 21.5, "rh": 45 }                          → one instrument
 *   envelope { "values": { "t": "25.7", "h": "46.3" } }          → one instrument
 *   batch    { "devices": { "temp001": { "temp": 21.5 }, … } }   → many, by deviceKey
 *
 * Values keep an explicit type. Storing everything as text and guessing on read
 * is how "0" becomes 0 becomes false — unacceptable in a system whose purpose is
 * faithful records.
 */

export type ValueType = 'boolean' | 'int' | 'float' | 'string' | 'json';

export interface Reading {
  key: string;
  value: unknown;
  valueType: ValueType;
  ts: Date;
  quality?: string;
}

export interface ParsedPayload {
  ok: boolean;
  reason?: string;
  /** Present for a batch payload; null for a flat one. */
  devices: Record<string, Record<string, unknown>> | null;
  /** Present for a flat payload; empty for a batch. */
  values: Record<string, unknown>;
  /** Device-supplied timestamp, if it sent a valid one. */
  ts: Date | null;
}

/** Reserved top-level keys that carry metadata, not readings. */
const META_KEYS = new Set(['ts', 'timestamp', 'quality', 'devices']);

/**
 * Some loggers wrap their readings in an envelope — `{"values": {...}}` — instead
 * of sending them flat. Added 2026-09-03 for a device on this installation that
 * changed format in the field and could not be changed back.
 *
 * Hardcoded rather than administered like `telemetry-slots`, DELIBERATELY: this
 * module is PURE (see the header — no database, no imports), and threading a
 * config value in to satisfy one vendor would cost that property, which is what
 * makes the parser cheap to test and impossible to break from a config screen.
 * If a second envelope name ever turns up, make it a config THEN.
 */
const ENVELOPE_KEY = 'values';

export function classifyValue(v: unknown): ValueType {
  if (typeof v === 'boolean') return 'boolean';
  // NOTE: JSON has no int/float distinction — 21.0 parses to 21 and is
  // classified 'int'. A sensor reporting 21.0 then 21.5 therefore labels the
  // same key 'int' then 'float'. Harmless here because value is stored as Json
  // in one column rather than column-per-type, but do not build logic that
  // assumes valueType is stable for a given key.
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'string') return 'string';
  return 'json';
}

export function parsePayload(buf: Buffer): ParsedPayload {
  const empty: ParsedPayload = { ok: false, devices: null, values: {}, ts: null };

  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return { ...empty, reason: `Invalid JSON: ${(e as Error).message}` };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...empty, reason: 'Payload must be a JSON object' };
  }

  const obj = raw as Record<string, unknown>;

  // A device-supplied timestamp is used when valid and ignored when not — a bad
  // clock should not discard an otherwise good reading.
  let ts: Date | null = null;
  const rawTs = obj.ts ?? obj.timestamp;
  if (typeof rawTs === 'string' || typeof rawTs === 'number') {
    const d = new Date(rawTs);
    if (!Number.isNaN(d.getTime())) ts = d;
  }

  if (obj.devices && typeof obj.devices === 'object' && !Array.isArray(obj.devices)) {
    return {
      ok: true, devices: obj.devices as Record<string, Record<string, unknown>>,
      values: {}, ts,
    };
  }

  // ENVELOPE. Unwrapped ONLY when `values` holds an object and the payload
  // carries no other reading keys.
  //
  // That guard is the whole safety of this branch: `{"values":{"t":1},"t":25}` is
  // ambiguous, so it is NOT unwrapped and both are stored — unwrapping there would
  // silently DISCARD the outer reading, which is the one failure mode a §11 ingest
  // path must not have. A `values` that is a number, a string or an array is a
  // perfectly ordinary reading and is left alone.
  //
  // The envelope's contents are readings VERBATIM — `ts`/`quality` are defined at
  // the TOP level only, so an inner `ts` is stored as a reading rather than being
  // silently dropped or silently honoured. The outer `ts` rule above is unchanged.
  //
  // An empty envelope yields zero readings, exactly as a bare `{}` already does.
  const envelope = obj[ENVELOPE_KEY];
  if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
    const otherReadingKeys = Object.keys(obj).filter(
      (k) => k !== ENVELOPE_KEY && !META_KEYS.has(k),
    );
    if (otherReadingKeys.length === 0) {
      return { ok: true, devices: null, values: { ...(envelope as Record<string, unknown>) }, ts };
    }
  }

  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!META_KEYS.has(k)) values[k] = v;
  }
  return { ok: true, devices: null, values, ts };
}

export function toReadings(values: Record<string, unknown>, ts: Date): Reading[] {
  const out: Reading[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue;
    out.push({ key, value, valueType: classifyValue(value), ts });
  }
  return out;
}
