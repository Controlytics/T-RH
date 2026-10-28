import { DATA_KEY_MAX, DATA_KEYS_PER_REQUEST_MAX } from '@digilog/shared';

/**
 * The `keys` query parameter of `/:id/telemetry` and `/telemetry-history`
 * (widget data keys, 2026-10-28): a comma list of telemetry keys, exactly as
 * stored — case is kept, because `T` and `t` are two keys on the wire.
 *
 * Absent or blank → `{ keys: null }`, meaning NO filter (every key), never "no
 * keys". Over the shared caps → `{ error }`, which the route returns as a 400
 * rather than silently charting a subset. A key containing a comma cannot be
 * named here; no device in this plant sends one.
 */
export function parseKeysParam(raw: string | undefined): { keys: string[] | null } | { error: string } {
  if (raw === undefined) return { keys: null };
  const keys = [...new Set(raw.split(',').map((k) => k.trim()).filter(Boolean))];
  if (keys.length === 0) return { keys: null };
  if (keys.length > DATA_KEYS_PER_REQUEST_MAX) {
    return { error: `At most ${DATA_KEYS_PER_REQUEST_MAX} keys per request.` };
  }
  const long = keys.find((k) => k.length > DATA_KEY_MAX);
  if (long) return { error: `A key must be ${DATA_KEY_MAX} characters or fewer.` };
  return { keys };
}
