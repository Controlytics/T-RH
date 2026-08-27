/**
 * Per-target RAISED throttle.
 *
 * In-memory, single-instance — the same approach and the same caveat as
 * notification-dispatcher.ts's cooldownMap. Recorded rather than inherited silently:
 * on a restart the map is empty and the next raise fires immediately, which is the
 * correct failure direction for an annunciator.
 *
 * THROTTLES `RAISED` ONLY. CLEARED and ACKNOWLEDGED are silence signals: suppressing
 * one leaves a buzzer sounding for a condition that has already gone away, and the
 * operator's only remedy is to unplug the hooter — the exact outcome the cooldown
 * exists to prevent. Never rate-limit the off switch.
 */

import type { AlarmWebhookEvent } from '@digilog/shared';

const lastRaised = new Map<string, number>();

/** `now` is injected so tests are deterministic. */
export function shouldFire(
  event: AlarmWebhookEvent,
  targetId: string,
  cooldownSeconds: number,
  now: number,
): boolean {
  if (event !== 'RAISED') return true;
  if (cooldownSeconds <= 0) return true;
  const last = lastRaised.get(targetId);
  if (last !== undefined && now - last < cooldownSeconds * 1000) return false;
  lastRaised.set(targetId, now);
  return true;
}

/** Test seam only. */
export function resetCooldowns(): void {
  lastRaised.clear();
}
