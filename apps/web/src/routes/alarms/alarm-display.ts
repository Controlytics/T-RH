/**
 * Display logic for an alarm row, kept pure so the rules that actually matter are
 * testable without rendering.
 *
 * The rule that matters most: CLEARED and ACKNOWLEDGED are independent. An alarm whose
 * condition ended overnight but that nobody has answered for is still outstanding, and
 * the UI must not let "Cleared" read as "dealt with".
 */

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
  ruleSnapshot?: { name?: string; description?: string } | null;
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
