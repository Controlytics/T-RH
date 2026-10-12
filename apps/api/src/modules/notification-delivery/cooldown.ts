/**
 * Notification-rule cooldown (audit 2026-10-12 #4).
 *
 * WHAT WAS WRONG. The window was keyed on `rule.id` alone, across the whole fleet,
 * and claimed before anything was sent. So instrument B's alarm a minute after
 * instrument A's was dropped; ALARM_CLEARED was dropped by the ALARM_RAISED that
 * preceded it (the "it is over" message suppressed by the "it started" one); and a
 * send that failed still burned the window.
 *
 * NOW. One window per RULE + INSTRUMENT + EVENT TYPE (events with no instrument —
 * a login, a system error — key on the rule and event alone). A claim made for an
 * event that then reached nobody is handed back with `releaseCooldown`, the same
 * claim-then-release shape as the webhook throttle (alarm-webhooks/cooldown.ts,
 * INGEST-12). A claim carries the event's dedup key, so a RETRY of the same
 * notification job is not suppressed by its own first attempt's claim.
 *
 * In-memory and single-instance, like the webhook throttle: a restart empties it,
 * and the next notification is sent — the safe direction for an alarm.
 */

interface Claim { at: number; owner: string | undefined }

const claims = new Map<string, Claim>();

export function cooldownKey(ruleId: string, eventType: string, instrumentId: unknown): string {
  return typeof instrumentId === 'string' && instrumentId
    ? `${ruleId}|${eventType}|${instrumentId}`
    : `${ruleId}|${eventType}`;
}

/**
 * True when the rule may fire now; a true for a positive window is a CLAIM at
 * `now`. `owner` (the event's dedup key) lets a retry of the same event through.
 */
export function claimCooldown(key: string, windowMs: number, now: number, owner?: string): boolean {
  if (windowMs <= 0) return true;
  const existing = claims.get(key);
  if (existing && now - existing.at < windowMs) {
    return owner !== undefined && existing.owner === owner;
  }
  claims.set(key, { at: now, owner });
  return true;
}

/** Hand back the claim made at `claimedAt`, if it is still the recorded one. */
export function releaseCooldown(key: string, claimedAt: number): void {
  if (claims.get(key)?.at === claimedAt) claims.delete(key);
}

/** Test seam only. */
export function resetNotificationCooldowns(): void {
  claims.clear();
}
