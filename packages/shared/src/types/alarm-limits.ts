/**
 * Turning an instrument's free-text attributes into the four limits the alarm
 * evaluator checks.
 *
 * Lives in @digilog/shared because BOTH sides need it: the API evaluates limits,
 * the web app labels alarms with them. Two implementations would drift, and the
 * drift would show as an alarm whose stated limit contradicts the one that fired it.
 *
 * Keys are an ORDERED ALIAS LIST rather than one fixed name because the live
 * database already holds `High Temperature`, `Low Temperature` and
 * `Low Temperature Limit` as three separate operator-typed keys. An unmatched key
 * means no alarm and no warning, which is the worst failure this feature can have.
 *
 * Design: docs/superpowers/specs/2026-08-17-instrument-limit-alarms-design.md
 */

export type LimitBound = 'temperatureHigh' | 'temperatureLow' | 'humidityHigh' | 'humidityLow';

export const LIMIT_BOUNDS: readonly LimitBound[] = [
  'temperatureHigh', 'temperatureLow', 'humidityHigh', 'humidityLow',
] as const;

/** Newline-separated, most-preferred first — same wire format as telemetry aliases. */
export const ALARM_LIMIT_KEYS_DEFAULT: Record<LimitBound, string> = {
  temperatureHigh: 'High Temperature Limit\nHigh Temperature\nTemp High',
  temperatureLow: 'Low Temperature Limit\nLow Temperature\nTemp Low',
  humidityHigh: 'High Humidity Limit\nHigh Humidity\nRH High',
  humidityLow: 'Low Humidity Limit\nLow Humidity\nRH Low',
};

export const ALARM_STATUS_TEXT_DEFAULT = {
  activeUnack: 'Still pending Unacknowledged',
  activeAck: 'Active — Acknowledged',
  clearedUnack: 'Cleared — Unacknowledged',
  clearedAck: 'Cleared',
} as const;

/** Trim, lowercase, drop blanks, de-duplicate keeping FIRST (order is precedence). */
export function parseLimitKeys(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const v = line.trim().toLowerCase();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * A limit value, or null when there is not one.
 *
 * NOT `Number(raw)`: `Number("")` is 0, so a blank attribute would become a 0 °C
 * limit that breaches on every reading forever. An explicit numeric-string test
 * also rejects `"25 C"`, which a bare parseFloat would happily read as 25.
 */
export function parseLimitValue(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * First KEY that any attribute matches wins — not first attribute matching any key.
 * Only the key order can make precedence deterministic when an instrument carries
 * both spellings, which live data shows it does.
 *
 * A matched-but-unparseable value resolves to null rather than falling through to
 * the next key: a typo on the preferred key must read as "no limit", never be
 * silently replaced by a different attribute's number.
 */
export function resolveLimit(
  keys: string[],
  attributes: { key: string; value: string }[],
): { key: string; value: number } | null {
  for (const k of keys) {
    const hit = attributes.find((a) => a.key.trim().toLowerCase() === k);
    if (!hit) continue;
    const value = parseLimitValue(hit.value);
    return value === null ? null : { key: hit.key, value };
  }
  return null;
}
