/**
 * The alarm-webhook (hooter) contract shared by the API and the config page.
 *
 * Design: docs/superpowers/specs/2026-08-27-alarm-webhook-annunciator-design.md
 *
 * ONE source for the variable list. The config page renders its placeholder picker
 * FROM this constant and the worker builds its variables against it, so the UI
 * cannot advertise a placeholder the renderer does not produce — the failure mode
 * `alarms/notify.ts` documents for notification templates.
 */

export const ALARM_WEBHOOK_EVENTS = ['RAISED', 'CLEARED', 'ACKNOWLEDGED', 'TEST'] as const;
export type AlarmWebhookEvent = (typeof ALARM_WEBHOOK_EVENTS)[number];

/** GET is offered because some cheap hooters only accept a query-string trigger. */
export const ALARM_WEBHOOK_METHODS = ['POST', 'PUT', 'GET'] as const;
export type AlarmWebhookMethod = (typeof ALARM_WEBHOOK_METHODS)[number];

export const ALARM_WEBHOOK_DELIVERY_STATUSES = ['SENT', 'FAILED'] as const;
export type AlarmWebhookDeliveryStatus = (typeof ALARM_WEBHOOK_DELIVERY_STATUSES)[number];

const COMMON = [
  'event',
  'alarmId',
  'instrument',
  'instrumentName',
  'instrumentId',
  'metric',
  'value',
  'condition',
  'ruleName',
  'timestamp',
  // The same instant as `timestamp`, printed in the ADMINISTERED timezone and
  // date/time format (Config → Date/Time) — for a display panel a person reads.
  // `timestamp` stays ISO-8601 UTC for anything that parses it (2026-10-12).
  'timestampLocal',
] as const;

export const ALARM_WEBHOOK_VARIABLES: Record<AlarmWebhookEvent, readonly string[]> = {
  RAISED: COMMON,
  CLEARED: [...COMMON, 'raisedAt', 'raisedAtLocal', 'duration'],
  ACKNOWLEDGED: [...COMMON, 'raisedAt', 'raisedAtLocal', 'acknowledgedBy', 'acknowledgeReason'],
  TEST: COMMON,
};

/**
 * Shipped on a new target. Kept to variables RAISED promises, so a target created and
 * never edited renders a complete body. Whitespace inside a JSON string literal is
 * insignificant, so the line breaks here are safe.
 */
export const DEFAULT_WEBHOOK_BODY_TEMPLATE = `{"event":"\${event}","instrument":"\${instrument}","metric":"\${metric}","value":"\${value}","condition":"\${condition}","alarmId":"\${alarmId}","timestamp":"\${timestamp}"}`;

/** Both lists empty means the target matches NOTHING. Never "all". */
export interface AlarmWebhookScope {
  scopeLocationIds: string[];
  scopeInstrumentIds: string[];
}

/**
 * The subset of a target the pure matcher needs. Structural on purpose so
 * `target-scope.ts` can be unit-tested without a Prisma client or a database.
 */
export interface AlarmWebhookTargetShape extends AlarmWebhookScope {
  id: string;
  isActive: boolean;
  fireOnRaised: boolean;
  fireOnCleared: boolean;
  fireOnAcknowledged: boolean;
}
