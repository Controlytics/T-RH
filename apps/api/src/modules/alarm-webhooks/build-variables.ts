/**
 * Builds the placeholder values for a webhook body.
 *
 * Mirrors alarms/notify.ts's formatting decisions — notably formatDecimals against the
 * INSTRUMENT's own precision — so the hooter payload, the email and the dashboard all
 * quote one excursion identically.
 */

import { formatDecimals, TELEMETRY_DECIMALS_FALLBACK, type AlarmWebhookEvent } from '@digilog/shared';
import { formatDuration } from '../alarms/notify.js';
import { describeLimit } from '../alarms/limit-decide.js';

export interface WebhookAlarmInput {
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

  decimals?: number | null;
  raisedAt: Date;
  clearedAt?: Date | null;
  acknowledgedBy?: string | null;
  acknowledgeReason?: string | null;
}

export function buildWebhookVariables(
  event: AlarmWebhookEvent,
  a: WebhookAlarmInput,
): Record<string, string> {
  const instrument = a.instrumentCode || a.instrumentId;
  // A reading of 0 is real; only a genuinely absent value (OFFLINE has none) is '—'.
  // `valueText` wins when set: an RS485 failure has no number to format, and
  // printing '—' there says "no reading" for a sensor that reported loudly and
  // wrongly.
  const value = a.valueText?.trim()
    || formatDecimals(a.triggeredValue, a.decimals ?? TELEMETRY_DECIMALS_FALLBACK)
    || '—';
  const endAt = a.clearedAt ?? a.raisedAt;

  const vars: Record<string, string> = {
    event,
    alarmId: a.alarmId,
    instrument,
    instrumentName: a.instrumentName || instrument,
    instrumentId: a.instrumentId,
    metric: a.metric,
    value,
    condition: a.condition,
    ruleName: a.ruleName,
    timestamp: (event === 'CLEARED' ? endAt : new Date()).toISOString(),
  };

  if (event === 'CLEARED') {
    vars.raisedAt = a.raisedAt.toISOString();
    vars.duration = formatDuration(a.raisedAt, endAt);
  }
  if (event === 'ACKNOWLEDGED') {
    vars.raisedAt = a.raisedAt.toISOString();
    vars.acknowledgedBy = a.acknowledgedBy ?? '';
    vars.acknowledgeReason = a.acknowledgeReason ?? '';
  }
  return vars;
}

/**
 * `alarm.ruleSnapshot` carries one of two shapes depending on `Alarm.source`:
 *
 * - RULE alarms (`alarms/decide.ts:ruleSnapshot()`) — no `decimals` field;
 *   (RULE alarms were removed 2026-08-31; the enum value survives because
 *   Postgres cannot drop one, but nothing raises them any more.)
 * - INSTRUMENT_LIMIT alarms (`alarms/limit-decide.ts:limitSnapshot()`) — carries
 *   `source: 'INSTRUMENT_LIMIT'` and `decimals`; described by `describeLimit()`.
 *
 * These two helpers pick the right branch so a caller (the acknowledge route) never
 * has to know which kind of alarm it is holding. Neither ever throws: an unrecognised
 * or non-object snapshot degrades to an empty condition / null decimals rather than
 * blocking a regulated acknowledge action.
 */
function isLimitSnapshot(snapshot: unknown): snapshot is Record<string, unknown> {
  return (
    typeof snapshot === 'object' &&
    snapshot !== null &&
    !Array.isArray(snapshot) &&
    ((snapshot as Record<string, unknown>).source === 'INSTRUMENT_LIMIT' ||
      'limitKind' in (snapshot as Record<string, unknown>))
  );
}

export function describeSnapshot(snapshot: unknown): string {
  if (!isLimitSnapshot(snapshot)) {
    if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return '';
    try {
      return '';
    } catch {
      return '';
    }
  }
  const metric = snapshot.metric;
  const limitKind = snapshot.limitKind;
  const limit = snapshot.limit;
  if (typeof metric !== 'string' || typeof limitKind !== 'string' || typeof limit !== 'number') return '';
  try {
    return describeLimit({ metric: metric as never, limitKind: limitKind as never, limit });
  } catch {
    return '';
  }
}

export function decimalsFromSnapshot(snapshot: unknown): number | null {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return null;
  if (!isLimitSnapshot(snapshot)) return null;
  const decimals = (snapshot as Record<string, unknown>).decimals;
  return typeof decimals === 'number' ? decimals : null;
}
