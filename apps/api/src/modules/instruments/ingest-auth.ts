import { prisma } from '../../lib/prisma.js';
import { tokenMatches, tokenPrefix } from './token.js';

// No `transport`: this resolver authenticates on the credential alone and never
// looked at protocol, which is why the instrument no longer stores one. The
// listener that accepted the connection knows its own transport and stamps it
// on a dead letter directly.
export interface IngestIdentity { id: string; code: string; isGateway: boolean }

// Short TTL, mirroring lib/reauth-check.ts. A device may post every second; a DB
// round trip per reading is the difference between working and not. The TTL is
// also the worst-case delay before a revocation takes effect, so keep it small.
const CACHE_TTL_MS = 10_000;
// Positive results: keyed on full token, stores resolved instruments.
const cache = new Map<string, { identity: IngestIdentity; at: number }>();
// Negative results: keyed on full token, tracks misses with TTL. Bounded to prevent
// memory exhaustion from attacker-supplied invalid tokens.
const NEGATIVE_CACHE_MAX_SIZE = 1000;
const negativeCache = new Map<string, number>();  // token -> timestamp

export function invalidateIngestAuthCache(instrumentId?: string): void {
  if (!instrumentId) { cache.clear(); negativeCache.clear(); return; }
  for (const [k, v] of cache) if (v.identity.id === instrumentId) cache.delete(k);
}

export async function resolveInstrumentByToken(token: string): Promise<IngestIdentity | null> {
  if (!token) return null;

  // Check positive cache (hit = found instrument).
  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.identity;

  // Check negative cache (miss = no instrument at this token).
  const negHit = negativeCache.get(token);
  if (negHit && Date.now() - negHit < CACHE_TTL_MS) return null;

  // Seek on the non-secret prefix, then compare hashes in constant time. Several
  // credentials can share a prefix, so this is a list, not a findUnique.
  const rows = await prisma.instrumentCredential.findMany({
    where: { tokenPrefix: tokenPrefix(token), revokedAt: null },
    include: { instrument: true },
  });

  let identity: IngestIdentity | null = null;
  let matchedCredentialId: string | null = null;
  for (const r of rows) {
    if (!tokenMatches(token, r.tokenHash)) continue;
    if (r.revokedAt) break;                  // revoked credential
    if (!r.instrument?.isActive) break;      // known token, disabled device
    identity = {
      id: r.instrument.id, code: r.instrument.code, isGateway: r.instrument.isGateway,
    };
    matchedCredentialId = r.id;
    break;
  }

  if (identity) {
    // Stamp last-used. This runs on a cache MISS only, so a device posting every
    // second costs one write per TTL window (10s), not one per reading — while
    // still being accurate enough for the "is this device talking?" column the
    // instrument list is built around. Without it that column reads "Never"
    // forever, which is worse than not showing it.
    if (matchedCredentialId) {
      await prisma.instrumentCredential.update({
        where: { id: matchedCredentialId },
        data: { lastUsedAt: new Date() },
      }).catch(() => {
        // Never fail an accepted reading over a telemetry-about-telemetry write.
      });
    }
    cache.set(token, { identity, at: Date.now() });
  } else {
    // Cache miss with size limit to prevent memory exhaustion.
    if (negativeCache.size >= NEGATIVE_CACHE_MAX_SIZE) {
      const oldest = negativeCache.entries().next().value;
      if (oldest) negativeCache.delete(oldest[0]);
    }
    negativeCache.set(token, Date.now());
  }

  return identity;
}
