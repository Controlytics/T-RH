/**
 * RS485 sensor-failure alarms — raised when a sensor reports something that is
 * not a number, cleared when it reports a number again.
 *
 * A FOURTH alarm source beside RULE, INSTRUMENT_LIMIT and INACTIVITY, and it
 * exists because none of the other three can see this fault. When an RS485 probe
 * or its bus fails, the logger keeps talking — it just sends `NA` (or `ERR`, or
 * nothing meaningful) where the reading should be. So:
 *
 *   - INACTIVITY never fires: the payload arrived and stamped `lastSeenAt`. The
 *     device is alive; it is the SENSOR that is dead.
 *   - INSTRUMENT_LIMIT never fires: `toSlot()` discards a non-numeric value, so
 *     the evaluator sees `null`, and a null is deliberately not a breach.
 *   - The dashboard shows an empty cell, which is indistinguishable from an
 *     instrument that has never reported.
 *
 * The result before this source existed: a dead probe looked exactly like a
 * healthy plant with a gap in it, and nothing in the system said otherwise.
 *
 * Lives in @digilog/shared because the API decides and freezes, and the browser
 * renders from that frozen snapshot. Two copies would drift.
 */

/** The two slots a failure can be named for. There is no third: `AlarmMetric` is
 *  TEMPERATURE | HUMIDITY | OFFLINE, so a text value on any other key raises
 *  nothing — there would be no metric to record it under. */
export type Rs485Metric = 'TEMPERATURE' | 'HUMIDITY';

export interface Rs485AlarmConfig {
  enabled: boolean;
  /** The ONE word shown wherever a failed sensor's value would go. */
  failureText: string;
}

/**
 * The shipped word for a failed sensor's value, used wherever the administered
 * one has not loaded yet.
 *
 * Declared HERE rather than as a literal in a component on purpose: a fallback
 * baked into the browser is a second opinion about a value the server
 * administers, and the two drift the moment somebody edits the setting. Every
 * surface either has the configured text or falls back to this one constant.
 */
export const RS485_FAILURE_TEXT_DEFAULT = 'Error';

/** How long a failure text may be. It lands in a table cell, an email and a
 *  webhook body; a sentence typed here would wreck all three. */
export const RS485_FAILURE_TEXT_MAX = 24;

/**
 * The failure text to show: the administered one, or the shipped default when it
 * is blank, absent, or still loading.
 *
 * Same rule as every other configurable wording in this system — an admin
 * clearing the field must not be able to make a value cell empty, which would
 * read as "nothing is wrong".
 */
export function failureText(configured?: string | null): string {
  const t = typeof configured === 'string' ? configured.trim() : '';
  return t || RS485_FAILURE_TEXT_DEFAULT;
}

export const RS485_ALARMS_DEFAULT: Rs485AlarmConfig = {
  /**
   * **ON, unlike `inactivity-alarms` which ships OFF.** That is a deliberate
   * departure from the newer precedent and the reason is measured, not stylistic:
   * inactivity ships off because switching it on would have raised an alarm for
   * every instrument already quiet — 101 on the installation it was written for,
   * each with a notification and a webhook fire. This one was checked the same
   * way and the number is ZERO: every one of the 226,570 retained readings on a
   * temperature or humidity slot key is numeric, and no instrument currently
   * holds a non-numeric latest value on either slot. There is no alarm storm to
   * protect against, and a fault detector that ships switched off detects
   * nothing.
   *
   * **That count is from the LOCAL development database (`compliance_core_db`),
   * which is the only one that was probed.** The AWS install is a separate
   * database and may not be zero. Re-derive there BEFORE the first deploy — this
   * is the query, and it is cheap:
   *   SELECT count(*) FROM instrument_telemetry_latest
   *   WHERE key = ANY(<slot aliases>) AND value_type NOT IN ('int','float');
   */
  enabled: true,
  /**
   * `Error`, and NOT `NA`, which is what a slot with no reading already shows
   * (`NOT_AVAILABLE` in the dashboard's `set-point.ts`).
   *
   * That distinction is the entire reason this text exists. A broken probe and an
   * instrument nobody has wired up yet are different faults with different
   * remedies, and until this setting they rendered identically — which is also
   * why the raw `NA` a sensor sends is NOT what gets displayed: it reads as "no
   * data" to everyone who has not read the design note.
   */
  failureText: RS485_FAILURE_TEXT_DEFAULT,
};

/** What the Alarms page's Type column calls one of these. */
export const RS485_TYPE_LABEL: Record<Rs485Metric, string> = {
  TEMPERATURE: 'RS485 Temperature Failure',
  HUMIDITY: 'RS485 Humidity Failure',
};

/**
 * What the Limit column says for one of these.
 *
 * A CONSTANT, deliberately not a config setting. The three inactivity column
 * wordings are administered because those cells have no answer at all; this one
 * has a real and unchanging answer — the sensor was expected to send a number
 * and did not. A second set of "what does the Limit cell say" settings, for a
 * second source, on one table, is a configuration surface that invites two
 * different answers to one question. Make it a setting if and when someone asks.
 */
export const RS485_LIMIT_TEXT = 'numeric';

/**
 * The snapshot frozen onto an RS485 alarm when it is raised.
 *
 * `rawValue` is the whole point of the record: it is the evidence, and it is why
 * the Generated Value column shows the offending text rather than an
 * administered wording. `triggeredValue` on the alarm row stays NULL — that
 * column is a Float and the value that tripped this alarm is, by definition, not
 * one.
 */
export interface Rs485Snapshot {
  kind: 'RS485';
  metric: Rs485Metric;
  /** The telemetry key the value arrived on — which alias resolved the slot. */
  key: string;
  /** The offending value, rendered for display. `NA`, `ERR`, `"23.5"`, `true`. */
  rawValue: string;
  /** Its ingest-assigned type: `string`, `boolean` or `json`. Never int/float. */
  valueType: string;
  /** When that value was received. */
  readingAt: string | null;
  /**
   * The instrument's display precision AT RAISE TIME, frozen for the same reason
   * every other alarm freezes it: editing `temp_decimals` today must not
   * re-render a closed record at a precision nobody saw. It quotes the CLEARED
   * value — the reading that ended the fault, which unlike the one that started
   * it really is a number.
   */
  decimals: number;
  description: string;
  snapshotAt: string;
}

/**
 * How the offending value is written into the record.
 *
 * A JSON string renders bare (`NA`, not `"NA"`) because the quotes are transport
 * syntax, not something the sensor said. Everything else is JSON-encoded so an
 * object or a boolean is still legible. Truncated, because this ends up in an
 * audit column, a notification body and a webhook payload, and a device that
 * ships a kilobyte of diagnostic text must not be able to fill any of them.
 */
export const RS485_RAW_VALUE_MAX = 120;

export function renderRawValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.length > RS485_RAW_VALUE_MAX ? `${text.slice(0, RS485_RAW_VALUE_MAX - 1)}…` : text;
}

/** "temperature reported NA instead of a number" — one wording, server and browser. */
export function describeRs485(metric: Rs485Metric, rawValue: string): string {
  return `${metric === 'TEMPERATURE' ? 'temperature' : 'humidity'} reported ${rawValue} instead of a number`;
}

/**
 * A stored telemetry value as a READING, or null when it is not one.
 *
 * **A QUOTED number is a number** (operator, 2026-08-31): a device that sends
 * `"23.5"` has reported 23.5, and JSON quoting is a transport artefact of the
 * firmware, not a fault in the probe. This reverses the original rule that
 * judged purely by type.
 *
 * That reversal is only safe because this is the ONE definition every consumer
 * uses — the dashboard, the limit evaluator, the range check, the charts and the
 * SQL summaries. Accepting a quoted number here while the dashboard still
 * refused it would be far worse than either rule on its own: the value would
 * render blank AND raise no alarm, which is precisely the silent hole the RS485
 * source exists to close. If you change what counts as a reading, change it
 * here and follow the callers.
 *
 * Deliberately strict about what a numeric string is:
 *   - an EMPTY string is NOT 0. `Number("")` is 0, and that bug would turn a
 *     blank into a real reading at absolute zero.
 *   - `"NA"`, `"ERR"`, `"25 C"` are not readings.
 *   - no exponent form, matching `parseLimitValue` — sensors here do not send
 *     `1e3`, and accepting it would widen the surface for no gain.
 */
const NUMERIC_STRING = /^[+-]?(\d+\.?\d*|\.\d+)$/;

export function coerceReading(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s || !NUMERIC_STRING.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Is this stored telemetry value a sensor failure?
 *
 * Anything {@link coerceReading} cannot read as a number — `NA`, `ERR`, a
 * boolean, an object, an empty string. A quoted number is NOT a failure.
 *
 * A missing key is NOT a failure either — that is silence, which is the
 * INACTIVITY source's question. This one only ever judges a value that arrived.
 */
export function isSensorFailureValue(value: unknown): boolean {
  return coerceReading(value) === null;
}
