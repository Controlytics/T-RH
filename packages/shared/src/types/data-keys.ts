/**
 * Widget data keys (2026-10-28): the contract a widget uses to name ANY key an
 * instrument has — a TELEMETRY key it has sent, or an ATTRIBUTE key it carries —
 * and the shapes the server answers with. Spec:
 * docs/superpowers/specs/2026-10-28-widget-data-keys-design.md (§4, §5).
 *
 * Ingest stores every key a device sends, so a key nobody configured is already
 * on record; these types are how a widget asks for it. Two rules ride on the
 * response shapes and are decided ON THE SERVER, never here or in a browser:
 *
 * - A MEASURED key (one the instrument's profile maps to a measurement) carries
 *   the server's unit, precision and bounds — `decimals`, `unit`, `judged`.
 * - A RAW key carries `unit: null`, `decimals: null` (print the stored value as
 *   the device sent it) and `judged: null`: nothing checks it, so nothing may
 *   paint it in limit.
 */
import { z } from 'zod';

export const DATA_KEY_SOURCES = ['telemetry', 'attribute'] as const;
export type DataKeySource = (typeof DATA_KEY_SOURCES)[number];

/** Longest key a widget may name. Device keys are short; this bounds a request, not a device. */
export const DATA_KEY_MAX = 128;
/** Most instruments one catalogue / latest-values request may cover. */
export const DATA_KEYS_INSTRUMENTS_MAX = 200;
/** Most keys one request may name. */
export const DATA_KEYS_PER_REQUEST_MAX = 20;

/** A key exactly as stored, and which kind of key it is. */
export const dataKeyRefSchema = z.object({
  source: z.enum(DATA_KEY_SOURCES),
  key: z.string().trim().min(1, 'A key cannot be blank').max(DATA_KEY_MAX, `A key must be ${DATA_KEY_MAX} characters or fewer`),
});
export type DataKeyRef = z.infer<typeof dataKeyRefSchema>;

/** Body of `POST /api/instruments/latest-values`. */
export const latestValuesRequestSchema = z.object({
  // No minimum: a selection can hold nothing (an empty Area, a scope that
  // leaves nothing), and its answer is an empty list, never an error.
  instrumentIds: z.array(z.string().uuid('Not an instrument id'))
    .max(DATA_KEYS_INSTRUMENTS_MAX, `At most ${DATA_KEYS_INSTRUMENTS_MAX} instruments per request`),
  keys: z.array(dataKeyRefSchema)
    .min(1, 'Name at least one key')
    .max(DATA_KEYS_PER_REQUEST_MAX, `At most ${DATA_KEYS_PER_REQUEST_MAX} keys per request`),
});
export type LatestValuesRequest = z.infer<typeof latestValuesRequestSchema>;

/** The measurement a key carries on some instrument, from the `measurement_types` registry. */
export interface DataKeyMeasurement {
  code: string;
  name: string;
  unit: string;
}

/** One entry of `GET /api/instruments/data-keys` — a key the picker can offer. */
export interface DataKeyInfo {
  source: DataKeySource;
  key: string;
  /** The measurement's name, an attribute's administered display name, else the key. */
  label: string;
  /**
   * The latest reading of at least one instrument in the set is a number
   * (a QUOTED number counts). A HINT for the picker, never a gate.
   */
  numeric: boolean;
  /** How many instruments in the set carry this key. */
  instruments: number;
  /** ISO instant of the newest reading / attribute change, or null. */
  lastSeen: string | null;
  /** Non-null when any instrument in the set measures this key. */
  measurement: DataKeyMeasurement | null;
}

/** A measured key's bounds and fault flags — the overview's own answer, never re-resolved. */
export interface DataKeyJudged {
  limitMin: number | null;
  limitMax: number | null;
  /** The text a bound prints in place of its number (`60 (For Reference)`), or null. */
  limitMinText: string | null;
  limitMaxText: string | null;
  sensorError: boolean;
  rangeError: boolean;
}

/** One requested key on one instrument. */
export interface LatestKeyValue {
  source: DataKeySource;
  key: string;
  /** The stored JSON value exactly as received; null when the key has never arrived. */
  value: unknown;
  ts: string | null;
  unit: string | null;
  /** Measured: the instrument's precision. Raw: null — print as received. */
  decimals: number | null;
  /** An attribute's server-formatted display (a limit at its reading's precision), else null. */
  display: string | null;
  judged: DataKeyJudged | null;
}

/** One instrument of `POST /api/instruments/latest-values`. */
export interface LatestValuesRow {
  instrumentId: string;
  code: string;
  name: string;
  functionalLocationName: string | null;
  locationAttribute: string | null;
  reporting: boolean;
  lastSeenAt: string | null;
  /** In the REQUESTED key order. */
  values: LatestKeyValue[];
}
