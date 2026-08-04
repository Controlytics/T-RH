import { prisma } from '../../lib/prisma.js';
import { tokenMatches, tokenPrefix } from './token.js';

export interface IngestIdentity { id: string; code: string; transport: string }

// Short TTL, mirroring lib/reauth-check.ts. A device may post every second; a DB
// round trip per reading is the difference between working and not. The TTL is
// also the worst-case delay before a revocation takes effect, so keep it small.
const CACHE_TTL_MS = 10_000;
const cache = new Map<string, { identity: IngestIdentity | null; at: number }>();

export function invalidateIngestAuthCache(instrumentId?: string): void {
  if (!instrumentId) { cache.clear(); return; }
  for (const [k, v] of cache) if (v.identity?.id === instrumentId) cache.delete(k);
}

export async function resolveInstrumentByToken(token: string): Promise<IngestIdentity | null> {
  if (!token) return null;

  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.identity;

  // Seek on the non-secret prefix, then compare hashes in constant time. Several
  // credentials can share a prefix, so this is a list, not a findUnique.
  const rows = await prisma.instrumentCredential.findMany({
    where: { tokenPrefix: tokenPrefix(token), revokedAt: null },
    include: { instrument: true },
  });

  let identity: IngestIdentity | null = null;
  for (const r of rows) {
    if (!tokenMatches(token, r.tokenHash)) continue;
    if (r.revokedAt) break;                  // revoked credential
    if (!r.instrument?.isActive) break;      // known token, disabled device
    identity = { id: r.instrument.id, code: r.instrument.code, transport: r.instrument.transport };
    break;
  }

  cache.set(token, { identity, at: Date.now() });
  return identity;
}
