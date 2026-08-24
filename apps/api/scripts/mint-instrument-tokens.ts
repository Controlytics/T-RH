/**
 * Mint device tokens for instruments that have none usable.
 *
 * Mirrors `POST /api/instruments/:id/regenerate-token` exactly:
 *   - the old credential is REVOKED, never deleted — the credential history is
 *     the §11 record of which secret was live when a given reading arrived;
 *   - the audit row is written INSIDE the same transaction, so a regeneration
 *     cannot land without its record;
 *   - `invalidateIngestAuthCache` runs afterwards, because without it the OLD
 *     token keeps authenticating for the cache TTL and "revoked immediately"
 *     would be untrue.
 *
 * By default it SKIPS any instrument that already has a decryptable token, so
 * re-running does not churn credentials a device is using. `--force` regenerates
 * regardless — which will break any real device still holding the old secret.
 *
 * What it cannot reproduce: the route's `enforceReauthAlways` password prompt.
 * A script cannot capture a signature. Every audit row says so rather than
 * leaving it to be discovered.
 *
 * Usage:
 *   npx tsx apps/api/scripts/mint-instrument-tokens.ts            # dry run
 *   npx tsx apps/api/scripts/mint-instrument-tokens.ts --apply
 *   npx tsx apps/api/scripts/mint-instrument-tokens.ts --apply --force
 */
import { prisma } from '../src/lib/prisma.js';
import { auditLog } from '../src/lib/audit.js';
import { generateToken, hashToken, tokenPrefix } from '../src/modules/instruments/token.js';
import { encryptToken, decryptToken, tokenKeyConfigured } from '../src/modules/instruments/token-crypto.js';
import { invalidateIngestAuthCache } from '../src/modules/instruments/ingest-auth.js';

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
const ACTOR = 'superadmin';
const REASON = 'Device token minted by scripts/mint-instrument-tokens.ts so local telemetry can be posted. '
  + 'No e-signature was captured: a script cannot prompt for re-authentication as the HTTP route does.';

async function main() {
  if (!tokenKeyConfigured()) {
    throw new Error('INSTRUMENT_TOKEN_KEY is not configured — a minted token could not be stored recoverably');
  }

  const instruments = await prisma.instrument.findMany({
    select: {
      id: true, code: true,
      credentials: { where: { revokedAt: null }, select: { id: true, tokenEncrypted: true } },
    },
    orderBy: { code: 'asc' },
  });

  const needing = instruments.filter((i) => {
    if (FORCE) return true;
    const blob = i.credentials.find((c) => c.tokenEncrypted)?.tokenEncrypted;
    if (!blob) return true;
    try { decryptToken(blob); return false; } catch { return true; }
  });

  console.log(`MODE: ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'}${FORCE ? '  [FORCE — regenerates even usable tokens]' : ''}`);
  console.log(`instruments: ${instruments.length}   needing a token: ${needing.length}`);
  if (!needing.length) { console.log('nothing to do'); await prisma.$disconnect(); return; }
  if (!APPLY) {
    console.log(needing.slice(0, 10).map((i) => '  ' + i.code).join('\n') + (needing.length > 10 ? `\n  … and ${needing.length - 10} more` : ''));
    console.log('\nDry run only. Re-run with --apply to execute.');
    await prisma.$disconnect();
    return;
  }

  let minted = 0;
  for (const inst of needing) {
    const token = generateToken();
    await prisma.$transaction(async (tx) => {
      await tx.instrumentCredential.updateMany({
        where: { instrumentId: inst.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.instrumentCredential.create({
        data: {
          instrumentId: inst.id,
          tokenHash: hashToken(token),
          tokenPrefix: tokenPrefix(token),
          tokenEncrypted: encryptToken(token),
        },
      });
      await auditLog({
        action: 'INSTRUMENT_TOKEN_REGENERATED', targetType: 'Instrument', targetId: inst.id,
        afterValue: { code: inst.code, tokenPrefix: tokenPrefix(token) },
        reason: REASON,
        signatureMeaning: `Access token for instrument "${inst.code}" regenerated; previous token revoked`,
        userId: ACTOR, userRole: 'SUPER_ADMIN',
        ipAddress: '127.0.0.1', userAgent: 'scripts/mint-instrument-tokens.ts', sessionId: null,
      }, tx);
    });
    invalidateIngestAuthCache(inst.id);
    minted++;
  }

  console.log(`minted ${minted} token(s)`);
  const usable = (await prisma.instrumentCredential.count({ where: { revokedAt: null, tokenEncrypted: { not: null } } }));
  console.log(`instruments with a recoverable live token: ${usable}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
