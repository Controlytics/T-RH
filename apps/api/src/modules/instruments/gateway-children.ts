import { prisma } from '../../lib/prisma.js';
import type { ChildMap } from './gateway-fanout.js';

// Same 10s window as ingest-auth: a gateway posting every second must not cost
// a query per reading. The TTL is also the worst case before an unlink takes
// effect, which is why link/unlink invalidates explicitly rather than waiting.
const TTL_MS = 10_000;
const cache = new Map<string, { map: ChildMap; at: number }>();

export function invalidateChildMapCache(gatewayId?: string): void {
  if (!gatewayId) { cache.clear(); return; }
  cache.delete(gatewayId);
}

export async function childMapFor(gatewayId: string): Promise<ChildMap> {
  const hit = cache.get(gatewayId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.map;

  const rows = await prisma.instrument.findMany({
    where: { gatewayId },
    select: { id: true, code: true, isActive: true },
  });
  const map: ChildMap = new Map(rows.map((r) => [r.code, { id: r.id, isActive: r.isActive }]));
  cache.set(gatewayId, { map, at: Date.now() });
  return map;
}
