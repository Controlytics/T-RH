/**
 * Idempotency helper — dedup retried offline replays via x-client-op-id header.
 *
 * Flow:
 *   1. Client queues an operation locally with a generated UUID (clientOpId)
 *   2. Sync engine replays with header `x-client-op-id: <uuid>` + body `clientOpId`
 *   3. Server checks if any FilterEvent was previously written with this clientOpId
 *      stored inside attributes.clientOpId — if so, returns the cached current-state
 *      response (effectively a no-op replay)
 *   4. Otherwise the mutation proceeds, and the writer must persist clientOpId
 *      inside FilterEvent.attributes so a future retry will hit step 3
 *
 * This makes every offline replay safe to retry without producing duplicate cycles,
 * double advances, or repeat checklist submissions.
 */
import { prisma } from './prisma.js';

/**
 * Has this clientOpId already been processed for this filter + cycle? Used
 * at the start of every cycle-scoped mutation (advance / bypass /
 * submit-checklist / terminate) to short-circuit duplicate replays.
 *
 * `cycleId` is REQUIRED (audit §1.10 / 2026-05-16). Without it, dedup
 * matched across a filter's entire history — so a clientOpId from a
 * completed cycle could silently no-op a fresh-cycle mutation when the
 * tablet's offline queue replayed an old op. IndexedDB persistence is
 * per-filter, not per-cycle, so reused UUIDs across cycles were possible
 * under offline-heavy field conditions.
 *
 * For mutations that run BEFORE a cycle exists (i.e., start-cycle), use
 * `findExistingStartByClientOpId` instead — it scopes by event type.
 */
export async function findExistingByClientOpId(
  filterId: string,
  clientOpId: string,
  cycleId: string,
): Promise<boolean> {
  const existing = await prisma.filterEvent.findFirst({
    where: {
      filterId,
      cycleId,
      attributes: { path: ['clientOpId'], equals: clientOpId },
    },
    select: { id: true },
  });
  return !!existing;
}

/**
 * Has this clientOpId already been used to start a cycle for this filter?
 * start-cycle has no cycleId yet (it's about to create one) so it can't
 * use the cycle-scoped helper above. Instead, scope by event type so a
 * replay of the same start-cycle op detects the prior CYCLE_STARTED row,
 * but clientOpIds reused for non-start events (advance / bypass / etc)
 * don't accidentally short-circuit a legitimate fresh start.
 */
export async function findExistingStartByClientOpId(
  filterId: string,
  clientOpId: string,
): Promise<boolean> {
  const existing = await prisma.filterEvent.findFirst({
    where: {
      filterId,
      eventType: 'CYCLE_STARTED',
      attributes: { path: ['clientOpId'], equals: clientOpId },
    },
    select: { id: true },
  });
  return !!existing;
}

/**
 * Embed clientOpId into the attributes JSON for a FilterEvent write so that
 * future replays of the same op can detect the duplicate.
 */
export function withClientOpId<T extends Record<string, any>>(attrs: T, clientOpId: string | null): T {
  if (!clientOpId) return attrs;
  return { ...attrs, clientOpId } as T;
}
