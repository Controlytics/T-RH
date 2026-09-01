/**
 * Display logic for an alarm row, kept pure so the rules that actually matter are
 * testable without rendering.
 *
 * The rule that matters most: CLEARED and ACKNOWLEDGED are independent. An alarm whose
 * condition ended overnight but that nobody has answered for is still outstanding, and
 * the UI must not let "Cleared" read as "dealt with".
 */

import {
  ALARM_STATUS_TEXT_DEFAULT, formatDecimals, TELEMETRY_DECIMALS_FALLBACK,
  INACTIVITY_TYPE_LABEL, inactivityLimitText, INACTIVITY_TEXT_DEFAULT,
  RS485_TYPE_LABEL, RS485_LIMIT_TEXT, RS485_FAILURE_TEXT_DEFAULT,
  SENSOR_RANGE_TEXT_DEFAULT, rangeLimitText,
  ALARM_TYPE_KEYS, alarmTypeKeyFor, alarmTypeName,
  type InactivityColumnTexts, type AlarmTypeNames,
} from '@digilog/shared';

export interface AlarmRow {
  id: string;
  instrumentCode: string | null;
  instrumentId: string;
  instrumentName?: string | null;
  /** The instrument's FUNCTIONAL location — the authoritative grouping. */
  locationName?: string | null;
  metric: string;
  triggeredValue: number | null;
  state: string;
  raisedAt: string;
  clearedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgeReason: string | null;
  source?: string;
  limitKind?: string | null;
  clearedValue?: number | null;
  ruleSnapshot?: {
    name?: string; description?: string; limit?: number; metric?: string; limitKind?: string;
    thresholdLow?: number | null; thresholdHigh?: number | null; comparison?: string;
    /** The instrument's display precision AT RAISE TIME. Null on rows raised before
     *  the field existed. */
    decimals?: number | null;
    /** Present only on an INACTIVITY alarm — the grace it was raised against. */
    kind?: string;
    graceMinutes?: number;
    /** Present only on an RS485 alarm — the offending text the sensor sent,
     *  and the key it arrived on. The value is not on `triggeredValue`
     *  because that column is a number and this one, by definition, is not. */
    rawValue?: string;
    key?: string;
    /** Present only on a SENSOR_RANGE alarm — the reading, and the span it left.
     *  The reading is also on `triggeredValue`; it is declared here so a fixture
     *  or a caller cannot quietly diverge from the payload the API sends. */
    reading?: number;
    rangeLow?: number | null;
    rangeHigh?: number | null;
    /** The offending value's ingest-assigned type (`string`, `boolean`, `json`).
     *  Nothing on screen reads it — it is declared so a fixture or a caller
     *  cannot quietly diverge from the payload the API actually sends. */
    valueType?: string;
    /**
     * Written at CLEAR time, not at raise, and only by the inactivity pass: the
     * slot, key and precision of the reading that ended the outage. Everything
     * else on this snapshot describes why the alarm was RAISED and is frozen;
     * these three describe how it ended, which is a different fact and could not
     * have been known when the rest was written.
     */
    clearedSlot?: string;
    clearedKey?: string;
    clearedDecimals?: number;
  } | null;
}

/**
 * Every administered wording a row can need, in one object.
 *
 * One bag rather than a parameter per source: these helpers are called from four
 * surfaces (the table, the acknowledge dialog, the trend widget, the signed PDF)
 * and a new source would otherwise mean a new argument threaded through all four
 * again. Extends the inactivity wordings so existing callers still typecheck.
 */
export interface AlarmDisplayTexts extends Partial<InactivityColumnTexts> {
  /** The word shown for an RS485 sensor failure — `Error` unless administered. */
  sensorFailure?: string;
  /** The word shown for an out-of-range reading — `OL` unless administered. */
  outOfRange?: string;
  /** What each kind of alarm is CALLED, from Config → Alarm Type Names. */
  typeNames?: AlarmTypeNames;
}

export type AlarmTab = 'active' | 'history';

/** Does this alarm still need a human to answer for it? */
export function needsAcknowledgement(a: Pick<AlarmRow, 'acknowledgedAt'>): boolean {
  return !a.acknowledgedAt;
}

/**
 * Which tab an alarm belongs to. ACTIVE means the condition is still met — an alarm
 * that has cleared is history even if nobody has acknowledged it, because the tabs
 * describe the CONDITION and the acknowledgement column describes the paperwork.
 */
export function tabFor(a: Pick<AlarmRow, 'state'>): AlarmTab {
  return a.state === 'ACTIVE' ? 'active' : 'history';
}


/*
 * `severityTone` and `SeverityTone` stood here until 2026-09-01 and went with the
 * severity concept. Its last caller was the dashboard selection panel's badge —
 * the one place a user ever read a severity WORD — and `AlarmRow.severity` went
 * with it: the alarm list endpoint stopped sending the field, and a DTO property
 * the API never populates and nothing reads is a decoy, not a record.
 *
 * **The record itself is untouched.** `alarms.severity` is still NOT NULL in
 * Postgres and still carries the 148 rows raised before this date (105 MAJOR, 43
 * CRITICAL), the `AlarmSeverity` enum survives, and the acknowledge audit's
 * `afterValue.severity` still captures it. This file is a display DTO and a
 * display feed; none of it is the §11 evidence path.
 *
 * Do NOT reintroduce a tone helper keyed off severity here. `quadrantTone` is the
 * one that colours a row, and keying a pill off severity is a bug this page
 * already shipped once: on an installation where every alarm is CRITICAL it
 * painted every pill red.
 */

/**
 * What the condition column says. Prefers the rule as it was WHEN THE ALARM FIRED, not
 * the live rule — an inspector asking "why did this fire at 24.0 when the spec says 25?"
 * is answered from the snapshot. Falls back only when a row predates the snapshot.
 */
export function conditionText(a: AlarmRow): string {
  return a.ruleSnapshot?.description || a.ruleSnapshot?.name || `${a.metric.toLowerCase()} out of limit`;
}

/**
 * The precision this alarm's numbers are quoted at.
 *
 * From the FROZEN snapshot, never the instrument's live attribute: an alarm is a
 * §11 record, and editing `temp_decimals` today must not re-render a closed
 * excursion at a precision nobody saw when it fired. Rows raised before the field
 * existed fall back to the shipped default.
 */
export function alarmDecimals(a: Pick<AlarmRow, 'ruleSnapshot'>): number {
  const d = a.ruleSnapshot?.decimals;
  return typeof d === 'number' && Number.isFinite(d) ? d : TELEMETRY_DECIMALS_FALLBACK;
}

/**
 * The reading that tripped it. 0 is a real reading.
 *
 * An INACTIVITY alarm has no reading and never will — it is raised by the
 * ABSENCE of one, which is why the worker stores `triggeredValue: null` rather
 * than inventing a number. A bare dash there reads as a rendering fault on a §11
 * table, so the cell carries the administered wording instead.
 */
export function triggeredText(a: AlarmRow, texts?: AlarmDisplayTexts): string {
  if (a.source === 'INACTIVITY') return pickText(texts?.generatedValue, INACTIVITY_TEXT_DEFAULT.generatedValue);
  // An RS485 alarm shows the ADMINISTERED failure word (`Error` by default).
  //
  // It used to show the raw text the sensor sent, on the argument that evidence
  // beats a wording. That was wrong in practice: the raw text is almost always
  // `NA`, and `NA` is what the dashboard already shows for a slot with NO reading
  // — so the value column said the same thing for a dead probe and for an
  // instrument nobody had wired up. **The evidence is not lost**: the raw value
  // is still frozen on `ruleSnapshot.rawValue`, still named in the alarm's
  // condition, and still printed by the notification and the webhook.
  if (a.source === 'RS485_FAILURE') return pickText(texts?.sensorFailure, RS485_FAILURE_TEXT_DEFAULT);
  // An out-of-range alarm DOES carry a number, and it is deliberately not
  // shown: the whole finding is that the sensor cannot stand behind it. The
  // reading is on the snapshot and quoted in the condition.
  if (a.source === 'SENSOR_RANGE') return pickText(texts?.outOfRange, SENSOR_RANGE_TEXT_DEFAULT);
  return formatDecimals(a.triggeredValue, alarmDecimals(a)) ?? '—';
}

/**
 * A configured wording, or the shipped one when it is blank or absent.
 *
 * The same rule `statusText()` applies to the four status wordings: an admin
 * clearing a field must not be able to put an empty cell back on the page.
 */
function pickText(configured: string | undefined, fallback: string): string {
  return configured && configured.trim() ? configured.trim() : fallback;
}

export function instrumentLabel(a: AlarmRow): string {
  return a.instrumentCode || a.instrumentId;
}

/** Minimum reason length the acknowledge endpoint enforces — mirrored so the dialog says so. */
export const MIN_ACK_REASON = 5;
export const MAX_ACK_REASON = 500;

export function ackReasonError(reason: string): string | null {
  const n = reason.trim().length;
  if (n < MIN_ACK_REASON) return `Enter at least ${MIN_ACK_REASON} characters — this is signed into the audit trail.`;
  if (n > MAX_ACK_REASON) return `Keep it under ${MAX_ACK_REASON} characters.`;
  return null;
}

export interface AlarmStatusTexts {
  activeUnack: string;
  activeAck: string;
  clearedUnack: string;
  clearedAck: string;
}

/** The shape `GET /api/config/alarm-limits/status-texts` actually returns —
 * `status*`-prefixed keys mirroring the stored config keys in
 * `alarm-limits.def.ts` on the API side. Kept separate from
 * {@link AlarmStatusTexts} on purpose: that interface is the display
 * contract `statusText()` reads, and the two vocabularies are not meant to
 * converge. */
export interface AlarmStatusTextsResponse {
  statusActiveUnack: string;
  statusActiveAck: string;
  statusClearedUnack: string;
  statusClearedAck: string;
}

/**
 * Maps the API's `status*`-prefixed payload onto the `AlarmStatusTexts`
 * display contract. This is the ONE place the two vocabularies meet — a key
 * dropped or renamed on either side shows up here as a test failure instead
 * of as `statusText()` silently falling back to the shipped default forever
 * (see the `mapStatusTextsResponse` describe block in
 * `__tests__/alarm-display.test.ts`).
 */
export function mapStatusTextsResponse(res: AlarmStatusTextsResponse): AlarmStatusTexts {
  return {
    activeUnack: res.statusActiveUnack,
    activeAck: res.statusActiveAck,
    clearedUnack: res.statusClearedUnack,
    clearedAck: res.statusClearedAck,
  };
}

/**
 * The status cell.
 *
 * Two INDEPENDENT axes: the condition (still breaching / ended) and the signature
 * (signed / not). Four combinations, each separately worded, because
 * "Cleared — Unacknowledged" must never collapse into "Cleared" — that is the
 * overnight excursion nobody answered for, and it is not finished.
 *
 * A blank configured text falls back to the default rather than rendering an empty
 * cell: an admin clearing a field must not be able to make a status invisible.
 */
export function statusText(
  a: Pick<AlarmRow, 'state' | 'acknowledgedAt'>,
  texts?: Partial<AlarmStatusTexts>,
): string {
  const pick = (configured: string | undefined, fallback: string) =>
    configured && configured.trim() ? configured.trim() : fallback;

  const acked = Boolean(a.acknowledgedAt);
  if (a.state === 'ACTIVE') {
    return acked
      ? pick(texts?.activeAck, ALARM_STATUS_TEXT_DEFAULT.activeAck)
      : pick(texts?.activeUnack, ALARM_STATUS_TEXT_DEFAULT.activeUnack);
  }
  return acked
    ? pick(texts?.clearedAck, ALARM_STATUS_TEXT_DEFAULT.clearedAck)
    : pick(texts?.clearedUnack, ALARM_STATUS_TEXT_DEFAULT.clearedUnack);
}

const METRIC_WORD: Record<string, string> = { TEMPERATURE: 'Temperature', HUMIDITY: 'Humidity' };

/** `Inactivity` for an inactivity alarm; `High Temperature` for a limit alarm;
 *  the rule's name for a rule alarm. */
export function alarmTypeText(a: AlarmRow, texts?: AlarmDisplayTexts): string {
  // `alarmTypeKeyFor` in @digilog/shared is the ONE place source + metric +
  // limitKind become a type. It checks INACTIVITY, RS485 and SENSOR_RANGE BEFORE
  // the limit branch, because all three carry metric TEMPERATURE or HUMIDITY —
  // the same values a limit alarm carries — so metric alone cannot identify them
  // and a dead probe would otherwise read "High Temperature", naming a breach
  // that never happened.
  const key = alarmTypeKeyFor(a.source, a.metric, a.limitKind);
  // Null only for a RULE alarm, which is named by its own rule. Falling back to
  // the generic "Rule alarms" here would replace every operator-authored rule
  // name on the page.
  if (key) return alarmTypeName(texts?.typeNames, key);
  return a.ruleSnapshot?.name || conditionText(a);
}

/**
 * The limit this alarm fired against, from the FROZEN snapshot.
 *
 * Never the live attribute: changing an instrument's limit today must not rewrite
 * what a historical alarm says it breached.
 *
 * Two snapshot shapes feed this: an INSTRUMENT_LIMIT alarm's snapshot carries a single
 * `limit` + `limitKind`; a RULE alarm's snapshot (see `apps/api/src/modules/alarms/
 * decide.ts` `ruleSnapshot()`) never has `limit` — it carries `comparison` +
 * `thresholdLow`/`thresholdHigh` instead. Both must render a bound here.
 */
export function limitText(a: AlarmRow, texts?: AlarmDisplayTexts): string {
  // An inactivity alarm has no numeric bound — the threshold it breached is a
  // DURATION of silence. From the frozen snapshot, so lengthening the grace today
  // does not rewrite what a past outage says it breached. The wording around that
  // number is administered; the NUMBER is not, and `inactivityLimitText` refuses a
  // template with nowhere to put it.
  if (a.source === 'INACTIVITY') {
    const g = a.ruleSnapshot?.graceMinutes;
    return typeof g === 'number' && Number.isFinite(g) ? inactivityLimitText(g, texts?.limit) : '—';
  }

  // An RS485 alarm has no bound either: what it breached is the expectation that
  // a sensor sends a NUMBER. A CONSTANT, not a config setting — a second set of
  // "what does the Limit column say" wordings, for a second source, on one
  // table, invites two different answers to one question.
  if (a.source === 'RS485_FAILURE') return RS485_LIMIT_TEXT;

  // A range alarm HAS a bound, and it is the useful thing to show: the span
  // the probe declared. From the frozen snapshot, so re-specifying the sensor
  // tomorrow does not rewrite what a past fault says it exceeded.
  if (a.source === 'SENSOR_RANGE') {
    return rangeLimitText(a.ruleSnapshot?.rangeLow ?? null, a.ruleSnapshot?.rangeHigh ?? null);
  }

  // The bound is quoted at the same precision as the reading it was compared
  // against — "24.0 breached > 24" reads as a bug in the comparison.
  const dp = alarmDecimals(a);
  const f = (n: number) => formatDecimals(n, dp) ?? String(n);

  const limit = a.ruleSnapshot?.limit;
  if (typeof limit === 'number' && Number.isFinite(limit)) {
    const kind = a.limitKind ?? a.ruleSnapshot?.limitKind;
    return `${kind === 'LOW' ? '<' : '>'} ${f(limit)}`;
  }

  const { comparison, thresholdLow, thresholdHigh } = a.ruleSnapshot ?? {};
  const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  if (comparison === 'ABOVE' && isNum(thresholdHigh)) return `> ${f(thresholdHigh)}`;
  if (comparison === 'BELOW' && isNum(thresholdLow)) return `< ${f(thresholdLow)}`;
  if (comparison === 'OUTSIDE_RANGE' && isNum(thresholdLow) && isNum(thresholdHigh)) {
    return `${f(thresholdLow)} – ${f(thresholdHigh)}`;
  }
  return '—';
}

/**
 * The reading that brought it back in limit. 0 is a real reading.
 *
 * An INACTIVITY alarm clears because telemetry RETURNED, not because a reading
 * came back inside a bound, so there is no number to show and the cell carries
 * the administered wording instead.
 *
 * **Gated on `clearedAt`.** While the alarm is still ACTIVE the instrument has
 * NOT come back, and printing "Data resumed" on an open outage would state the
 * opposite of what the row means.
 */
export function clearedText(a: AlarmRow, texts?: AlarmDisplayTexts): string {
  if (a.source === 'INACTIVITY') {
    // Still open: the instrument has NOT come back, and either a number or the
    // "resumed" wording would state the opposite of what the row means.
    if (!a.clearedAt) return '—';
    /**
     * THE NUMBER WINS OVER THE WORDING (operator, 2026-09-01).
     *
     * The worker now records the reading that ended the outage, so this column
     * says what the instrument came back READING rather than merely that it came
     * back. The wording survives as the fallback for the case that still has no
     * number — an alarm cleared on presence alone, and every inactivity alarm
     * cleared before this change, whose value cannot be invented after the fact
     * on a §11 record.
     *
     * Precision comes from the slot the resuming reading actually belongs to
     * (frozen onto the snapshot as `clearedDecimals` at clear time), NOT from
     * `alarmDecimals`, which carries the temperature precision this alarm was
     * raised with. A humidity resume printed at temperature precision would be a
     * real number stated to the wrong resolution.
     */
    const d = a.ruleSnapshot?.clearedDecimals;
    const decimals = typeof d === 'number' && Number.isFinite(d) ? d : alarmDecimals(a);
    return formatDecimals(a.clearedValue, decimals)
      ?? pickText(texts?.clearedValue, INACTIVITY_TEXT_DEFAULT.clearedValue);
  }
  return formatDecimals(a.clearedValue, alarmDecimals(a)) ?? '—';
}

/**
 * The shape `GET /api/config/inactivity-alarms/display-texts` returns —
 * `text*`-prefixed keys mirroring the stored config keys in
 * `inactivity-alarms.def.ts`. Kept separate from {@link InactivityColumnTexts}
 * for the same reason {@link AlarmStatusTextsResponse} is kept separate from
 * {@link AlarmStatusTexts}: one is the wire vocabulary, the other the display
 * contract, and they are not meant to converge.
 */
export interface InactivityTextsResponse {
  textGeneratedValue: string;
  textLimit: string;
  textClearedValue: string;
}

/**
 * Maps that payload onto the display contract. The ONE place the two
 * vocabularies meet, so a key renamed on either side fails a test here instead
 * of silently leaving every inactivity row on the shipped wording forever.
 */
export function mapInactivityTextsResponse(res: InactivityTextsResponse): InactivityColumnTexts {
  return {
    generatedValue: res.textGeneratedValue,
    limit: res.textLimit,
    clearedValue: res.textClearedValue,
  };
}

/**
 * The four states an alarm can be in, as the operator's filter boxes name them
 * (2026-08-29). This is the SAME two axes the page has always had — condition
 * (still breaching / ended) and paperwork (signed / not) — presented as one
 * four-way choice rather than a tab plus a checkbox.
 *
 * The axes stay separate in the model on purpose: a CLEARED-but-UNACKNOWLEDGED
 * alarm, the overnight excursion nobody saw, is precisely the one that must not
 * look finished, and collapsing the two would lose it.
 */
export type AlarmQuadrant = 'active-ack' | 'active-unack' | 'cleared-ack' | 'cleared-unack';

export const ALARM_QUADRANTS: readonly { id: AlarmQuadrant; label: string }[] = [
  { id: 'active-ack', label: 'Active Acknowledged' },
  { id: 'active-unack', label: 'Active Unacknowledged' },
  { id: 'cleared-ack', label: 'Cleared Acknowledged' },
  { id: 'cleared-unack', label: 'Cleared Unacknowledged' },
];

export function quadrantFor(a: Pick<AlarmRow, 'state' | 'acknowledgedAt'>): AlarmQuadrant {
  const active = tabFor(a) === 'active';
  const acked = !needsAcknowledgement(a);
  if (active) return acked ? 'active-ack' : 'active-unack';
  return acked ? 'cleared-ack' : 'cleared-unack';
}

/**
 * **There is deliberately no `filterByQuadrant()` or `quadrantCounts()` here.**
 *
 * Both existed until 2026-08-31 and both filtered and counted the rows already in
 * the browser — which the list endpoint capped at 500. The four count boxes
 * therefore described the newest 500 alarms while reading as plant-wide totals,
 * and a filter could never reach an alarm outside that window. `status`, `search`,
 * `from`/`to`, `type`, sorting and paging are all query parameters now
 * (`apps/api/src/modules/alarms/list-query.ts`), and the counts come back in the
 * same response as the rows, so a box and the table under it answer the same
 * question. Do not reintroduce a client-side count; it will be wrong again the
 * moment this installation passes one page of alarms.
 */

/**
 * How long the alarm lasted: raised -> cleared, as `HH:MM` with a unit letter.
 *
 * `00:01M` for one minute, `01:22H` for an hour and twenty-two. The pair is
 * ALWAYS hours:minutes; the letter says which unit the reader should think in —
 * M while it is under an hour, H once it is not.
 *
 * **DAYS ARE DELIBERATELY NOT USED** (operator, 2026-08-29). A three-day
 * excursion reads `72:00H`, not `3d`. An hour count that keeps growing is
 * directly comparable between rows; a mixed `3d 04:00` is not, and it is the
 * comparison that matters when you are ranking excursions by length of
 * exposure.
 *
 * An alarm that has NOT cleared has no duration to state — the operator asked
 * for the span between generated and cleared time, and there is no end yet.
 * Returning a running total here would put a number that keeps moving into a
 * column of settled ones, and a §11 table should not imply a closed figure that
 * is still open.
 */
export function alarmDurationText(a: Pick<AlarmRow, 'raisedAt' | 'clearedAt'>): string {
  if (!a.clearedAt) return '—';
  const from = Date.parse(a.raisedAt);
  const to = Date.parse(a.clearedAt);
  // Unparseable or reversed timestamps: say nothing rather than render a
  // negative or NaN duration as though it were measured.
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return '—';

  const totalMinutes = Math.floor((to - from) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}${hours >= 1 ? 'H' : 'M'}`;
}

/**
 * Where the alarm happened: the instrument's FUNCTIONAL location, which is the
 * authoritative logical grouping (see the root CLAUDE.md note on the three
 * grouping concepts).
 *
 * **The drawn ROOM is deliberately not shown** (operator, 2026-08-31). It is
 * geometry, not a grouping, and in this installation every room is coded with
 * the instrument's own code — so a room line under the location repeated the
 * Instrument ID column and said nothing. `roomLabel` was dropped from the API
 * response with it; put it back only if rooms are ever named independently of
 * the instruments in them.
 */
export function locationText(a: Pick<AlarmRow, 'locationName'>): string {
  // Not an empty cell: an instrument with no functional location is a real and
  // normal state, and a blank reads as a rendering fault.
  return a.locationName?.trim() || 'Unassigned';
}

/**
 * **There is deliberately no `alarmUnit()` here.** The °C / %RH legend lives in
 * the column HEADERS, and each row's metric is already named in the Type column,
 * so a per-cell unit says the same thing twice and widens the widest columns on
 * the page. This is the operator's call, made on 2026-08-29 and made again on
 * 2026-08-31 after a per-cell version was reintroduced from a mockup. A helper
 * for it has now been deleted twice; if you are about to add a third, add the
 * unit to the header instead.
 */

/**
 * Which way the reading broke.
 *
 * Colours the value alone — warm for a high breach, cold for a low one — so the
 * direction is readable without parsing the Limit column. It comes from
 * `limitKind` (or the snapshot's comparison for a rule alarm), NEVER from
 * comparing the value to the limit here: re-deriving a decision the server
 * already made is how the two drift apart.
 */
export type BreachDirection = 'high' | 'low' | 'none';

export function breachDirection(a: AlarmRow): BreachDirection {
  const kind = a.limitKind ?? a.ruleSnapshot?.limitKind;
  if (kind === 'HIGH') return 'high';
  if (kind === 'LOW') return 'low';
  const cmp = a.ruleSnapshot?.comparison;
  if (cmp === 'ABOVE') return 'high';
  if (cmp === 'BELOW') return 'low';
  return 'none';
}

/**
 * The tone each of the four states is painted in, everywhere it appears — the
 * count box, the row's edge marker and the status pill all read this, so a state
 * cannot be one colour at the top of the page and another in the table.
 *
 * **Cleared-Unacknowledged is AMBER, not a neutral or informational colour.** It
 * is the overnight excursion that ended before anyone saw it, and it is the one
 * row on this page that most needs not to look finished. Active-Acknowledged
 * takes the calm colour instead: the condition is live, but somebody has signed
 * for it and is working it.
 */
export type QuadrantTone = 'danger' | 'info' | 'warn' | 'ok';

export const QUADRANT_TONE: Record<AlarmQuadrant, QuadrantTone> = {
  'active-unack': 'danger',
  'active-ack': 'info',
  'cleared-unack': 'warn',
  'cleared-ack': 'ok',
};

export function quadrantTone(a: Pick<AlarmRow, 'state' | 'acknowledgedAt'>): QuadrantTone {
  return QUADRANT_TONE[quadrantFor(a)];
}

/**
 * The Type dropdown's vocabulary. These tokens are the API's — `list-query.ts`
 * maps each one onto the enum columns that define it — so the filter cannot
 * offer a type the server does not recognise.
 */
/**
 * The Type dropdown, labelled from the administered names.
 *
 * A FUNCTION rather than a constant, because the labels are now configuration:
 * a module-level array would be built once at import and never pick up a rename.
 * The token values stay hardcoded — they are the API's vocabulary
 * (`ALARM_TYPE_TOKENS` in `modules/alarms/list-query.ts`) and are not the
 * operator's to rename; only what the option SAYS is.
 */
export function alarmTypeOptions(names?: AlarmTypeNames): { value: string; label: string }[] {
  const n = (k: Parameters<typeof alarmTypeName>[1]) => alarmTypeName(names, k);
  return [
    { value: 'TEMP_HIGH', label: n('limitTemperatureHigh') },
    { value: 'TEMP_LOW', label: n('limitTemperatureLow') },
    { value: 'RH_HIGH', label: n('limitHumidityHigh') },
    { value: 'RH_LOW', label: n('limitHumidityLow') },
    { value: 'OFFLINE', label: n('inactivity') },
    { value: 'RS485', label: `${n('rs485Temperature')} / ${n('rs485Humidity')}` },
    { value: 'RANGE', label: `${n('rangeTemperature')} / ${n('rangeHumidity')}` },
  ];
}

/** The shipped labelling, for callers with no config in hand. Kept so the token
 *  list has one place to be checked against the server's. */
export const ALARM_TYPE_OPTIONS: readonly { value: string; label: string }[] = alarmTypeOptions();

/** Columns the server can sort on, paired with what the header says. */
export const ALARM_SORT_KEYS = ['raisedAt', 'clearedAt', 'instrumentCode', 'type', 'status'] as const;
export type AlarmSortKey = (typeof ALARM_SORT_KEYS)[number];

/**
 * A `datetime-local` value as an instant.
 *
 * The input gives back wall-clock text with no zone (`2026-08-27T00:00`). Sending
 * that raw would leave the server to guess a timezone, and it would guess its
 * own — so a range typed at a plant in one zone would select a different window
 * once the API moved to a server in another. Resolved here, where the operator's
 * clock is.
 */
export function localInputToIso(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
