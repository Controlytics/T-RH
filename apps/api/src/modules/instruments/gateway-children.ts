import { prisma } from '../../lib/prisma.js';
import type { ChildMap } from './gateway-fanout.js';

// Same 10s window as ingest-auth: a gateway posting every second must not cost
// a query per reading. The TTL is also the worst case before an unlink takes
// effect, which is why link/unlink invalidates explicitly rather than waiting.
const TTL_MS = 10_000;
const cache = new Map<string, { map: ChildMap; at: number }>();

/**
 * Bumped by EVERY invalidation. Without it the read-then-set below swallows its
 * own invalidation, because the two straddle an `await` and nothing carries a
 * version:
 *
 *   1. a batch request misses and issues `findMany` — in flight
 *   2. an operator unlinks child C; the PUT commits and invalidates. There is
 *      no entry yet, so the `cache.delete` is a NO-OP
 *   3. the in-flight `findMany` (which read pre-unlink) resolves and writes a
 *      map that still contains C
 *
 * C then stays writable by the gateway for a full TTL *after the unlink
 * committed* — i.e. explicit invalidation, which spec §10 names as THE
 * mitigation for child-map staleness, does nothing in that interleaving.
 *
 * Deliberately GLOBAL rather than per-gateway: a per-gateway counter has to
 * define what the no-arg `cache.clear()` does to the generation map, and the
 * only cost of the global one is an occasional extra miss.
 */
let generation = 0;

export function invalidateChildMapCache(gatewayId?: string): void {
  generation++;
  if (!gatewayId) { cache.clear(); return; }
  cache.delete(gatewayId);
}

export async function childMapFor(gatewayId: string): Promise<ChildMap> {
  const hit = cache.get(gatewayId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.map;

  const gen = generation;
  const rows = await prisma.instrument.findMany({
    where: { gatewayId },
    select: { id: true, code: true, isActive: true },
  });
  const map: ChildMap = new Map(rows.map((r) => [r.code, { id: r.id, isActive: r.isActive }]));
  // Scope of the guarantee, precisely: the map is still RETURNED to this
  // caller, and it may itself predate the invalidation. What the check buys is
  // that a stale read is never PUBLISHED for the next 10s — the next request
  // misses and re-reads. Making the in-flight request see the unlink would
  // need the read inside the writer's transaction, which it is not.
  if (gen === generation) cache.set(gatewayId, { map, at: Date.now() });
  return map;
}
