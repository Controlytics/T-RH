/**
 * Display logic for an alarm row, kept pure so the rules that actually matter are
 * testable without rendering.
 *
 * The rule that matters most: CLEARED and ACKNOWLEDGED are independent. An alarm whose
 * condition ended overnight but that nobody has answered for is still outstanding, and
 * the UI must not let "Cleared" read as "dealt with".
 */

import { ALARM_STATUS_TEXT_DEFAULT } from '@digilog/shared';

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

/** Tailwind classes per severity. CRITICAL must not be mistakable for MINOR at a glance. */
export function severityTone(severity: string): string {
  switch (severity) {
    case 'CRITICAL': return 'bg-red-100 text-red-800 border-red-300';
    case 'MAJOR': return 'bg-amber-100 text-amber-900 border-amber-300';
    case 'MINOR': return 'bg-sky-100 text-sky-800 border-sky-300';
    default: return 'bg-slate-100 text-slate-700 border-slate-300';
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

/** The reading that tripped it. OFFLINE has no value, and 0 is a real reading. */
export function triggeredText(a: AlarmRow): string {
  return typeof a.triggeredValue === 'number' && Number.isFinite(a.triggeredValue)
    ? String(a.triggeredValue)
    : '—';
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
 * (see alarm-limits-status-texts-mapping.test.ts).
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
  const limit = a.ruleSnapshot?.limit;
  if (typeof limit === 'number' && Number.isFinite(limit)) {
    const kind = a.limitKind ?? a.ruleSnapshot?.limitKind;
    return `${kind === 'LOW' ? '<' : '>'} ${limit}`;
  }

  const { comparison, thresholdLow, thresholdHigh } = a.ruleSnapshot ?? {};
  const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  if (comparison === 'ABOVE' && isNum(thresholdHigh)) return `> ${thresholdHigh}`;
  if (comparison === 'BELOW' && isNum(thresholdLow)) return `< ${thresholdLow}`;
  if (comparison === 'OUTSIDE_RANGE' && isNum(thresholdLow) && isNum(thresholdHigh)) {
    return `${thresholdLow} – ${thresholdHigh}`;
  }
  return '—';
}

/** The reading that brought it back in spec. 0 is a real reading. */
export function clearedText(a: AlarmRow): string {
  return typeof a.clearedValue === 'number' && Number.isFinite(a.clearedValue)
    ? String(a.clearedValue)
    : '—';
}
