/**
 * Display logic for an alarm row, kept pure so the rules that actually matter are
 * testable without rendering.
 *
 * The rule that matters most: CLEARED and ACKNOWLEDGED are independent. An alarm whose
 * condition ended overnight but that nobody has answered for is still outstanding, and
 * the UI must not let "Cleared" read as "dealt with".
 */

import { ALARM_STATUS_TEXT_DEFAULT, formatDecimals, TELEMETRY_DECIMALS_FALLBACK } from '@digilog/shared';

export interface AlarmRow {
  id: string;
  instrumentCode: string | null;
  instrumentId: string;
  metric: string;
  triggeredValue: number | null;
  severity: string;
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
  } | null;
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

export function filterByTab(rows: AlarmRow[], tab: AlarmTab, unacknowledgedOnly = false): AlarmRow[] {
  return rows.filter((a) => tabFor(a) === tab && (!unacknowledgedOnly || needsAcknowledgement(a)));
}

/**
 * Alarm severity as one of the product's five status tones.
 *
 * This used to return Tailwind classes directly, which meant alarm severity was
 * painted from a palette only this file knew about — so the most important
 * status in a monitoring application was the one status that did not look like
 * the others. Returning a tone hands the rendering to `StatusBadge`, which also
 * supplies the DOT: severity now carries colour, a shape and a word, instead of
 * colour and a word.
 *
 * CRITICAL must not be mistakable for MINOR at a glance — that constraint is
 * why the mapping is explicit rather than alphabetical, and it survives the
 * change: danger and info are the furthest-apart pair in the tone set.
 */
export type SeverityTone = 'danger' | 'warn' | 'info' | 'idle';

export function severityTone(severity: string): SeverityTone {
  switch (severity) {
    case 'CRITICAL': return 'danger';
    case 'MAJOR': return 'warn';
    case 'MINOR': return 'info';
    default: return 'idle';
  }
}

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

/** The reading that tripped it. OFFLINE has no value, and 0 is a real reading. */
export function triggeredText(a: AlarmRow): string {
  return formatDecimals(a.triggeredValue, alarmDecimals(a)) ?? '—';
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

/** `High Temperature` for a limit alarm; the rule's name for a rule alarm. */
export function alarmTypeText(a: AlarmRow): string {
  if (a.source === 'INSTRUMENT_LIMIT' && a.limitKind) {
    const kind = a.limitKind === 'HIGH' ? 'High' : 'Low';
    return `${kind} ${METRIC_WORD[a.metric] ?? a.metric}`;
  }
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
export function limitText(a: AlarmRow): string {
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

/** The reading that brought it back in limit. 0 is a real reading. */
export function clearedText(a: AlarmRow): string {
  return formatDecimals(a.clearedValue, alarmDecimals(a)) ?? '—';
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

/** `null` means no box is chosen, which shows EVERYTHING — not nothing. */
export function filterByQuadrant(rows: AlarmRow[], q: AlarmQuadrant | null): AlarmRow[] {
  if (!q) return rows;
  return rows.filter((a) => quadrantFor(a) === q);
}

export function quadrantCounts(rows: AlarmRow[]): Record<AlarmQuadrant, number> {
  const out: Record<AlarmQuadrant, number> = {
    'active-ack': 0, 'active-unack': 0, 'cleared-ack': 0, 'cleared-unack': 0,
  };
  for (const a of rows) out[quadrantFor(a)] += 1;
  return out;
}

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
 * comparison that matters when you are ranking excursions by severity of
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
