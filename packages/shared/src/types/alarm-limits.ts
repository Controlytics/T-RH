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

/**
 * The attribute that says whether each bound is IN FORCE, most preferred first.
 *
 * **NMT / NLT is the plant's own vocabulary, not ours** — "not more than" is the
 * high bound, "not less than" the low one. These are the keys this installation's
 * instruments already carry, checked against `instrument_attributes` on
 * 2026-08-31 rather than guessed.
 *
 * Why a bound needs a switch separate from its value: an instrument here can
 * carry `High Humidity Limit = 0` while meaning "humidity is not judged", and a
 * 0 is a REAL bound to this system — every reading above 0 %RH breaches it. On
 * this database that was raising 17 CRITICAL alarms at 44-50 %RH against a limit
 * nobody intended to enforce. The flag is what distinguishes "the bound is zero"
 * from "there is no bound".
 */
export const ALARM_LIMIT_ENABLE_KEYS_DEFAULT: Record<LimitBound, string> = {
  temperatureHigh: 'Enable_Temp_NMT',
  temperatureLow: 'Enable_Temp_NLT',
  humidityHigh: 'Enable_Humid_NMT',
  humidityLow: 'Enable_Humid_NLT',
};

/**
 * Is this bound switched on?
 *
 * **An absent, blank or unreadable flag means ENABLED**, and that default is the
 * safety decision in this file. A monitoring system must fail toward alarming: a
 * typo in an attribute value must not be able to silence a bound, and one
 * instrument on this installation carries no flag at all. It also keeps the
 * behaviour of every instrument that predates the flags exactly as it was.
 *
 * Both vocabularies are accepted because live data holds both — 99 instruments
 * write `0`/`1` and one writes `True`.
 */
export function parseEnableFlag(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return true;
  const s = String(raw).trim().toLowerCase();
  if (!s) return true;
  if (['0', 'false', 'no', 'off', 'n', 'f', 'disabled'].includes(s)) return false;
  if (['1', 'true', 'yes', 'on', 'y', 't', 'enabled'].includes(s)) return true;
  // Unreadable. Alarm rather than go quiet — see above.
  return true;
}

/**
 * Whether each bound is in force, resolved from the instrument's attributes.
 *
 * Key precedence works exactly like `resolveLimit`: the first KEY any attribute
 * matches wins, so an instrument carrying two spellings resolves deterministically.
 * A bound whose flag key is absent entirely returns null, and every caller turns
 * that into ENABLED.
 */
export function resolveEnableFlag(
  keys: string[],
  attributes: { key: string; value: string }[],
): { key: string; enabled: boolean } | null {
  for (const k of keys) {
    const hit = attributes.find((a) => a.key.trim().toLowerCase() === k);
    if (!hit) continue;
    return { key: hit.key, enabled: parseEnableFlag(hit.value) };
  }
  return null;
}

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
