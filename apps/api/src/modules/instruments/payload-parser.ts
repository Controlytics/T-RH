/**
 * Payload parsing — PURE. No database, no imports.
 *
 * Two accepted shapes:
 *   flat  { "temp": 21.5, "rh": 45 }                          → one instrument
 *   batch { "devices": { "temp001": { "temp": 21.5 }, … } }   → many, by deviceKey
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
