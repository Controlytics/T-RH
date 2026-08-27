/**
 * Alarm webhook annunciator. graphile-worker task, registered as `alarm_webhook`.
 *
 * Design: docs/superpowers/specs/2026-08-27-alarm-webhook-annunciator-design.md
 *
 * NOT scheduled — there is no crontab entry. This task is enqueued by the alarm
 * evaluator and by the acknowledge route. (packages/queue/crontab.txt warns that a
 * cron identifier with no handler leaks jobs forever; the converse is fine — a handler
 * with no cron entry is exactly what an event-driven task looks like.)
 */

import { prisma } from '../lib/prisma.js';
import { alarmWebhookJobSchema, type AlarmWebhookJob } from '@digilog/queue';
import type { AlarmWebhookTargetShape } from '@digilog/shared';
import { expandLocations, targetMatches } from '../modules/alarm-webhooks/target-scope.js';
import { shouldFire } from '../modules/alarm-webhooks/cooldown.js';
import { deliverToTarget } from '../modules/alarm-webhooks/send.js';

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export async function runAlarmWebhookJob(
  payload: AlarmWebhookJob,
  now: number = Date.now(),
): Promise<{ targets: number; sent: number; failed: number }> {
  const { event, alarmId, instrumentId, severity, variables } = payload;

  const [instrument, targets, nodes] = await Promise.all([
    prisma.instrument.findUnique({ where: { id: instrumentId }, select: { functionalLocationId: true } }),
    prisma.alarmWebhookTarget.findMany({ where: { isActive: true } }),
    // Exactly the four fields FlNode declares, so the result is structurally an FlNode[]
    // and needs no cast.
    prisma.functionalLocation.findMany({ select: { id: true, name: true, type: true, parentId: true } }),
  ]);

  let sent = 0;
  let failed = 0;
  let matched = 0;

  for (const t of targets) {
    const shape: AlarmWebhookTargetShape = {
      id: t.id,
      isActive: t.isActive,
      fireOnRaised: t.fireOnRaised,
      fireOnCleared: t.fireOnCleared,
      fireOnAcknowledged: t.fireOnAcknowledged,
      severities: t.severities === null ? null : asStringArray(t.severities),
      scopeLocationIds: asStringArray(t.scopeLocationIds),
      scopeInstrumentIds: asStringArray(t.scopeInstrumentIds),
    };

    const locations = expandLocations(shape.scopeLocationIds, nodes);
    if (!targetMatches(shape, {
      event,
      severity,
      instrumentId,
      functionalLocationId: instrument?.functionalLocationId ?? null,
      locations,
    })) continue;

    matched++;
    if (!shouldFire(event, t.id, t.cooldownSeconds, now)) continue;

    const ok = await deliverToTarget(t, event, alarmId, variables);
    if (ok) sent++; else failed++;
  }

  return { targets: matched, sent, failed };
}

/** graphile-worker task. Registered as `alarm_webhook`. */
export const alarmWebhookTask = async (
  payload: unknown,
  helpers?: { logger?: { info: (m: string) => void; error?: (m: string) => void } },
) => {
  const parsed = alarmWebhookJobSchema.safeParse(payload);
  if (!parsed.success) {
    // Do not throw: a malformed job would retry forever against a payload that can
    // never become valid. Log it and let the job complete.
    helpers?.logger?.error?.(`[alarm-webhook] discarding malformed job: ${parsed.error.message}`);
    return;
  }
  const res = await runAlarmWebhookJob(parsed.data);
  if (res.targets > 0) {
    helpers?.logger?.info(
      `[alarm-webhook] ${parsed.data.event} ${parsed.data.alarmId}: ${res.targets} target(s), sent ${res.sent}, failed ${res.failed}`,
    );
  }
};
