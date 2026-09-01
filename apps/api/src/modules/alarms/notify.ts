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

import { formatDecimals, TELEMETRY_DECIMALS_FALLBACK } from '@digilog/shared';

export type AlarmNotificationKind = 'raised' | 'cleared';

export interface AlarmNotificationInput {
  alarmId: string;
  instrumentId: string;
  instrumentCode: string | null;
  instrumentName?: string | null;
  metric: string;
  ruleName: string;
  condition: string;
  triggeredValue: number | null;
  /**
   * A word to print INSTEAD of the numeric value, for an alarm whose value is not
   * a number — today, an RS485 sensor failure, where the reading was `NA`.
   *
   * Set from the administered `rs485-alarms.failureText`, so the email, the
   * hooter payload, the Alarms table and the dashboard cell all use the operator's
   * one word. Absent for every other alarm source, which formats the number.
   *
   * The RAW value the sensor sent is not lost by this: it is named in `condition`
   * ("temperature reported NA instead of a number"), which every template prints
   * beside the value, and it is frozen on the alarm's own snapshot.
   */
  valueText?: string | null;
  /**
   * The instrument's display precision, so an email quotes the reading exactly as
   * the dashboard does. Optional: an absent one falls back to the site default
   * rather than blocking the notification, since a message that never sends is a
   * worse failure than one showing a decimal too many.
   */
  decimals?: number | null;
  raisedAt: Date;
  clearedAt?: Date | null;
}

export interface AlarmNotificationJob {
  eventType: 'ALARM_RAISED' | 'ALARM_CLEARED';
  /** Matched against NotificationRule.conditions, e.g. {"metric":["TEMPERATURE"]}. */
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
  // `valueText` wins when set: an RS485 failure has no number to format, and
  // printing '—' there says "no reading" for a sensor that reported loudly and
  // wrongly.
  // Formatted to the instrument's own precision so the email, the alarm row and the
  // dashboard cell all quote one excursion the same way.
  const value = a.valueText?.trim()
    || formatDecimals(a.triggeredValue, a.decimals ?? TELEMETRY_DECIMALS_FALLBACK)
    || '—';

  const base = {
    alarmId: a.alarmId,
    instrument,
    instrumentName: a.instrumentName || instrument,
    metric: a.metric,
    ruleName: a.ruleName,
    condition: a.condition,
  };

  // The context is what a rule's conditions filter on. `severity` used to be here
  // and was removed with the severity concept on 2026-09-01; verified first that no
  // `notification_rules` row filtered on it (0 rules existed at all). A rule whose
  // conditions name a key absent from the context is the matcher's problem, not
  // this function's — but if severity conditions ever appear in a customer
  // database, they will match nothing rather than everything.
  const context = { metric: a.metric, instrumentId: a.instrumentId };

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
  ALARM_RAISED: ['instrument', 'metric', 'value', 'condition', 'ruleName', 'timestamp'],
  ALARM_CLEARED: ['instrument', 'metric', 'condition', 'ruleName', 'raisedAt', 'duration', 'timestamp'],
} as const;
