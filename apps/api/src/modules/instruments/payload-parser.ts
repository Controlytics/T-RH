/**
 * Payload parsing — PURE. No database, no imports.
 *
 * Three accepted shapes:
 *   flat     { "temp": 21.5, "rh": 45 }                          → one instrument
 *   envelope { "values": { "t": "25.7", "h": "46.3" } }          → one instrument
 *   batch    { "devices": { "temp001": { "temp": 21.5 }, … } }   → many, by deviceKey
 *   batch    { "devices": [ { "devN": "temp001", "temp": 21.5 }, … ] }  → many, by `devN` (2026-09-05)
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
  /** What the device sent, when a sensor offset corrected `value` (2026-10-01).
   *  Stored in history's `raw_value`; never shown. */
  rawValue?: unknown;
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

/**
 * A device's own timestamp, or null when it sent none it can be read.
 *
 * ISO strings and epoch NUMBERS always worked. An epoch sent as a STRING did
 * not: `new Date("1788599495138")` is Invalid Date, so the reading was silently
 * stamped with its ARRIVAL time instead — found live on 2026-09-05, where the
 * plant gateway's `"ts":"1788599495138"` put every reading ~43 s late, which on
 * a §11 record is a wrong measurement time with nothing to say so. All-digit
 * strings are epochs: 13 digits milliseconds, 10 digits seconds (the two
 * widths firmware actually emits); anything else goes to `Date` as before.
 */
export function parseDeviceTs(raw: unknown, now = new Date()): Date | null {
  let d: Date | null = null;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    // All digits is an epoch or nothing: `new Date("12345")` would happily
    // read year 12345, which is not a time any device measured.
    if (raw.length !== 10 && raw.length !== 13) return null;
    const n = Number(raw);
    d = new Date(raw.length === 10 ? n * 1000 : n);
  } else if (typeof raw === 'number') {
    // The same width rule for a NUMBER (audit 2026-10-03, INGEST-5): the
    // firmware that sends `"ts":"1788599495"` sends `"ts":1788599495` when it
    // does not quote, and `new Date(1788599495)` is 1970-01-21 — outside every
    // partition, so the whole batch was refused.
    d = new Date(raw < 1e11 ? raw * 1000 : raw);
  } else if (typeof raw === 'string') {
    d = new Date(raw);
  }
  if (!d || Number.isNaN(d.getTime())) return null;
  // A sane window (INGEST-6): a timestamp ahead of the server by more than
  // DEVICE_TS_MAX_AHEAD_MS pinned `instrument_telemetry_latest` (every later
  // correct reading is "older" and ignored) for as long as it was ahead; one
  // before 2000 is a dead RTC. Both fall back to arrival time, which the
  // callers apply for a null.
  if (d.getTime() > now.getTime() + DEVICE_TS_MAX_AHEAD_MS) return null;
  if (d.getTime() < DEVICE_TS_MIN.getTime()) return null;
  return d;
}

/** How far ahead of the server a device clock may run before its stamp is replaced by arrival time. */
export const DEVICE_TS_MAX_AHEAD_MS = 10 * 60 * 1000;
/** No instrument here measured anything before this; an earlier stamp is a dead RTC. */
export const DEVICE_TS_MIN = new Date('2000-01-01T00:00:00Z');

/**
 * The keys whose value is JSON `null` (audit 2026-10-03, INGEST-8).
 * `toReadings` skips them — a null cannot be stored as a number and must not
 * become a string — but silently: `{"t":null,"h":45}` left yesterday's
 * temperature as the current reading with every alarm source seeing a healthy
 * probe. The callers dead-letter these by name so the failure is on record.
 */
export function nullReadingKeys(values: Record<string, unknown>): string[] {
  return Object.entries(values).filter(([, v]) => v === null).map(([k]) => k);
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
  const ts = parseDeviceTs(obj.ts ?? obj.timestamp);

  if (obj.devices && typeof obj.devices === 'object' && !Array.isArray(obj.devices)) {
    return {
      ok: true, devices: obj.devices as Record<string, Record<string, unknown>>,
      values: {}, ts,
    };
  }
  // The LIST form (operator, 2026-09-05): `"devices": [ {"devN": "<code>", …}, … ]`.
  // Each block names its own instrument under `devN`; the position is only a
  // slot, so the list is folded onto `dev1`, `dev2`, … for the fan-out — which
  // is also the name a rejection reports when a block carries no usable `devN`.
  if (Array.isArray(obj.devices)) {
    const devices: Record<string, Record<string, unknown>> = {};
    obj.devices.forEach((block, i) => { devices[`dev${i + 1}`] = block as Record<string, unknown>; });
    return { ok: true, devices, values: {}, ts };
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
