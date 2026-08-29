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
import { logger } from '../lib/logger.js';

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * Delivers to one target with error isolation. A throw here — the delivery-row
 * insert failing on a connection blip or constraint violation, or anything else
 * inside `deliverToTarget` — must cost ONE target's annunciation, never abort the
 * rest of the targets in this job. Same precedent as notification-dispatcher.ts's
 * per-recipient try/catch around `prisma.notification.create`.
 *
 * `deliver` is injected (default `deliverToTarget`) so this is testable without a
 * database — a test can pass a stub that throws.
 */
export async function attemptTarget(
  target: Parameters<typeof deliverToTarget>[0],
  event: string,
  alarmId: string | null,
  variables: Record<string, string>,
  deliver: typeof deliverToTarget = deliverToTarget,
): Promise<boolean> {
  try {
    return await deliver(target, event, alarmId, variables);
  } catch (err) {
    logger.error(
      `[alarm-webhook] target ${target.id} threw during delivery:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

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
  /** Matched, past the cooldown, and awaiting delivery. Delivered concurrently below. */
  const due: typeof targets = [];

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

    due.push(t);
  }

  // DELIVERY FANS OUT. The loop above stays sequential — `shouldFire` mutates the
  // cooldown map, and claiming concurrently would let two passes both read "not fired
  // yet" — but delivery must not be, because `deliverToTarget` retries 3 times ~2s
  // apart: one unplugged panel hooter would otherwise buzz the control-room hooter
  // ~19s late (up to ~184s at the permitted timeoutMs of 60000). The spec promises a
  // dead target "does not block ... or affect any other target in the same job", and
  // that is a LATENCY promise as well as a failure-isolation one.
  //
  // Safe to run concurrently: the targets share no mutable state. The cooldown map is
  // already fully updated above, before any send starts. Fan-out is bounded by the
  // number of ACTIVE targets this event matched — operator-configured, a handful of
  // hooters in practice — so it is deliberately not throttled.
  //
  // allSettled, and `attemptTarget` keeps its own try/catch: the per-target catch is
  // the failure isolation, and a settled rejection (which that catch should make
  // unreachable) is still counted as a failure rather than silently dropped.
  const results = await Promise.allSettled(
    due.map((t) => attemptTarget(t, event, alarmId, variables)),
  );
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) sent++;
    else failed++;
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
