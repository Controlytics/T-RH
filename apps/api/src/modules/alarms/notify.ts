/**
 * Turns an alarm raise/clear into a `notification` queue payload.
 *
 * Pure, so the variable set can be tested against what the rules UI advertises. That
 * matters more than it looks: an event type is described in FIVE places (the Prisma
 * enum, EVENT_TYPE_META in notification-rules/routes.ts, and EVENT_LABELS / EVENT_FIELDS
 * / the default templates in notification-dispatcher.ts). A variable produced here but
 * absent there renders as an empty table cell in the email an inspector reads.
 *
 * Notifications are ENQUEUED rather than dispatched inline because the evaluator runs
 * every minute: a slow SMTP send inside the loop would delay detecting the next
 * excursion, which is the one thing the evaluator exists to do promptly.
 */

export type AlarmNotificationKind = 'raised' | 'cleared';

export interface AlarmNotificationInput {
  alarmId: string;
  instrumentId: string;
  instrumentCode: string | null;
  instrumentName?: string | null;
  metric: string;
  severity: string;
  ruleName: string;
  condition: string;
  triggeredValue: number | null;
  raisedAt: Date;
  clearedAt?: Date | null;
}

export interface AlarmNotificationJob {
  eventType: 'ALARM_RAISED' | 'ALARM_CLEARED';
  /** Matched against NotificationRule.conditions, e.g. {"severity":["CRITICAL"]}. */
  context: Record<string, unknown>;
  variables: Record<string, string>;
}

/** Whole minutes, floored, so "0 min" honestly means under a minute rather than none. */
export function durationMinutes(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60000));
}

export function formatDuration(from: Date, to: Date): string {
  const mins = durationMinutes(from, to);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function alarmNotificationJob(
  kind: AlarmNotificationKind,
  a: AlarmNotificationInput,
): AlarmNotificationJob {
  const instrument = a.instrumentCode || a.instrumentId;
  // A reading of 0 is real; only a genuinely absent value (OFFLINE has none) is '—'.
  const value = typeof a.triggeredValue === 'number' && Number.isFinite(a.triggeredValue)
    ? String(a.triggeredValue)
    : '—';

  const base = {
    alarmId: a.alarmId,
    instrument,
    instrumentName: a.instrumentName || instrument,
    metric: a.metric,
    severity: a.severity,
    ruleName: a.ruleName,
    condition: a.condition,
  };

  // The context is what a rule's conditions filter on — severity and metric are the two
  // an operator actually wants to narrow by ("page me for CRITICAL only").
  const context = { severity: a.severity, metric: a.metric, instrumentId: a.instrumentId };

  if (kind === 'raised') {
    return {
      eventType: 'ALARM_RAISED',
      context,
      variables: { ...base, value, timestamp: a.raisedAt.toISOString() },
    };
  }

  const clearedAt = a.clearedAt ?? a.raisedAt;
  return {
    eventType: 'ALARM_CLEARED',
    context,
    variables: {
      ...base,
      value,
      raisedAt: a.raisedAt.toISOString(),
      duration: formatDuration(a.raisedAt, clearedAt),
      timestamp: clearedAt.toISOString(),
    },
  };
}

/**
 * The variables each event type promises. Exported so a test can hold this against
 * EVENT_TYPE_META rather than trusting that two hand-written lists agree.
 */
export const ALARM_EVENT_VARIABLES = {
  ALARM_RAISED: ['instrument', 'metric', 'value', 'condition', 'severity', 'ruleName', 'timestamp'],
  ALARM_CLEARED: ['instrument', 'metric', 'condition', 'severity', 'ruleName', 'raisedAt', 'duration', 'timestamp'],
} as const;
