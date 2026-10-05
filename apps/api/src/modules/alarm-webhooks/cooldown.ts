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
 *
 * CLAIM, THEN RELEASE ON FAILURE (audit 2026-10-03, INGEST-12). `shouldFire`
 * records the raise the moment it says yes — before any send — so two jobs
 * running at once cannot both read "not fired yet" and sound the hooter twice.
 * But a claim for a raise that then FAILED every attempt (the hooter unplugged,
 * three FAILED rows) used to stand: a second excursion inside the window was
 * suppressed although nothing had ever sounded. The worker now hands a failed
 * claim back through `releaseCooldown`, which clears it only if it is still the
 * claim in question — a newer, successful raise is never clobbered.
 */

import type { AlarmWebhookEvent } from '@digilog/shared';

const lastRaised = new Map<string, number>();

/** `now` is injected so tests are deterministic. A `true` for RAISED is a CLAIM at `now`. */
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

/**
 * Give back the claim `shouldFire` made at `claimedAt`, because the raise it
 * covered never reached the device. A no-op unless that exact claim is still
 * the recorded one — so a later successful raise keeps its window.
 */
export function releaseCooldown(targetId: string, claimedAt: number): void {
  if (lastRaised.get(targetId) === claimedAt) lastRaised.delete(targetId);
}

/** Test seam only. */
export function resetCooldowns(): void {
  lastRaised.clear();
}
