/**
 * How many decimal places a given instrument's readings are shown to.
 *
 * The precision belongs to the DEVICE, not to the site: a probe that resolves to
 * 0.1 °C and one that reports whole degrees sit in the same table, and one
 * site-wide number has to be wrong for one of them. So the value is read from
 * the instrument's own attributes — `temp_decimals` / `humid_decimals` — and the
 * config setting it replaces survives only as the fallback for an instrument
 * that does not declare one.
 *
 * Lives in @digilog/shared because BOTH sides need it: the API resolves it once
 * per instrument and returns it with each reading, the web app formats with it,
 * and the alarm evaluator freezes it onto a raised alarm. Two implementations
 * would drift, and the drift would show as a dashboard cell and its alarm row
 * quoting the same reading to different precision.
 *
 * Keys are an ORDERED ALIAS LIST, matching `alarm-limits.ts` beside it, for the
 * reason that file records: this install's attribute keys are operator-typed and
 * have already drifted once (`High Temperature` and `High Temperature Limit` are
 * both live right now). An unmatched key here is silent — the reading simply
 * renders at the site default — so the recovery has to be a config edit, not a
 * code change.
 */

import type { TelemetrySlot } from './telemetry-slots.js';

/** Newline-separated, most-preferred first — same wire format as every other key list. */
export const TELEMETRY_DECIMALS_KEYS_DEFAULT: Record<TelemetrySlot, string> = {
  temperature: 'temp_decimals',
  humidity: 'humid_decimals',
};

/**
 * Which attribute keys hold a TEMPERATURE, and which hold a HUMIDITY.
 *
 * A limit or a range is a reading like any other and has to be shown at the same
 * precision as the value it bounds — "27 breached > 25.0" reads as a bug in the
 * comparison. But an attribute is a free-text key/value pair, so nothing about
 * `High Temperature Range = 50` says it is degrees rather than a count.
 *
 * An administered list rather than matching on the word "temp": these keys are
 * operator-typed and already inconsistent in this install (`High Temperature` and
 * `High Temperature Limit` both live), a word rule would wrongly claim any future
 * key that happens to contain those letters, and a wrong guess here is fixed by
 * editing config instead of shipping code. Defaults cover every limit and range
 * key currently in use.
 *
 * Display only. Nothing here changes what is stored or what an alarm fires on.
 */
export const TELEMETRY_VALUED_KEYS_DEFAULT: Record<TelemetrySlot, string> = {
  temperature: [
    'High Temperature Limit', 'Low Temperature Limit',
    'High Temperature', 'Low Temperature',
    'High Temperature Range', 'Low Temperature Range',
    'Temp High', 'Temp Low',
  ].join('\n'),
  humidity: [
    'High Humidity Limit', 'Low Humidity Limit',
    'High Humidity', 'Low Humidity',
    'High Humidity Range', 'Low Humidity Range',
    'RH High', 'RH Low',
  ].join('\n'),
};

/**
 * Which slot an attribute key belongs to, or null for one that is not a reading.
 *
 * TEMPERATURE is tested first only to be deterministic; a key listed under both
 * is a configuration mistake, and silently picking by list order at least picks
 * the same one every time rather than depending on object key order.
 */
export function slotForAttributeKey(
  keys: Record<TelemetrySlot, string[]>,
  key: string,
): TelemetrySlot | null {
  const k = key.trim().toLowerCase();
  if (keys.temperature.includes(k)) return 'temperature';
  if (keys.humidity.includes(k)) return 'humidity';
  return null;
}

/** Shown when the instrument declares nothing and the config is unset. */
export const TELEMETRY_DECIMALS_FALLBACK = 1;

/**
 * The ceiling.
 *
 * Not a taste judgement — `Number.prototype.toFixed` THROWS a RangeError outside
 * 0…100, and that throw would happen inside the `.map()` that draws the
 * floorplan, blanking the whole dashboard because one attribute said `999`. 10
 * is past anything a sensor resolves to and well inside float64's ~15
 * significant digits.
 */
export const TELEMETRY_DECIMALS_MAX = 10;

/**
 * An attribute's raw string as a decimal count, or null when it does not name one.
 *
 * NOT `Number(raw)`, and not `parseLimitValue` either. Three cases have to come
 * apart, and only an explicit test separates them:
 *   - `"0"` → 0. This is the entire point of the feature; `Number("")` is also 0,
 *     so a blank attribute would otherwise silently force whole numbers.
 *   - `""` / whitespace / absent → null → the caller falls back.
 *   - `"2.5"`, `"two"`, `"1 dp"` → null. A decimal COUNT is an integer; rounding
 *     `2.5` to 2 or 3 would be this module inventing a precision nobody typed.
 *
 * A value above the ceiling is CLAMPED rather than rejected: `12` plainly means
 * "as many as you can", and falling back to 1 for it would read as the attribute
 * having been ignored.
 */
export function parseDecimalsValue(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.min(n, TELEMETRY_DECIMALS_MAX);
}

/**
 * The instrument's decimals for one slot, or `fallback` when it declares none.
 *
 * First KEY that any attribute matches wins — not first attribute matching any
 * key — for the precedence reason `resolveLimit` documents.
 *
 * A matched-but-unparseable value falls back rather than trying the next key: a
 * typo on the preferred key must read as "not configured", never be silently
 * answered by a different attribute's number.
 */
export function resolveDecimals(
  keys: string[],
  attributes: { key: string; value: string }[],
  fallback: number,
): number {
  const safeFallback = clampDecimals(fallback);
  for (const k of keys) {
    const hit = attributes.find((a) => a.key.trim().toLowerCase() === k);
    if (!hit) continue;
    const value = parseDecimalsValue(hit.value);
    return value === null ? safeFallback : value;
  }
  return safeFallback;
}

/**
 * The last line of defence before `toFixed`.
 *
 * Every value reaching a formatter goes through here, including one that came
 * off the wire as a config number or out of a years-old frozen alarm snapshot.
 * Neither is validated by this codebase at the point it is read, and either can
 * be the RangeError that blanks a page.
 */
export function clampDecimals(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return TELEMETRY_DECIMALS_FALLBACK;
  return Math.min(Math.max(Math.trunc(n), 0), TELEMETRY_DECIMALS_MAX);
}

/**
 * `toFixed` that cannot throw, for a value that may not be a number at all.
 *
 * `null` and `''` are rejected BEFORE the coercion, not by the finite check
 * after it: `Number(null)` and `Number('')` are both 0, so a missing reading
 * would render as a confident `0.0` — indistinguishable from a probe genuinely
 * reading zero. Returns null so the caller supplies its own em dash.
 */
export function formatDecimals(value: unknown, decimals: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(clampDecimals(decimals));
}
