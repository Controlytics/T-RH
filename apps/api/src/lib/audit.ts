import { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
// V-1 write-path migration (audit 2026-05-29): use V2 recursive canonicalizer
// so new audit rows hash with JSONB-safe canonical form (nested keys sorted
// recursively, not just top-level). Verifier tries V2 first, falls back to V1
// for historical rows. See lib/hash-chain.ts for the full versioning story.
import { computeChainedChecksumV2, computeChainedChecksumV3, getAuditChainKey } from './hash-chain.js';

export interface AuditEntry {
  userId?: string | null;
  userName?: string | null;
  userRole?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  beforeValue?: unknown;
  afterValue?: unknown;
  reason?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  sessionId?: string | null;
  // `null` is accepted on every optional field (2026-10-05): the insert
  // writes `?? null` and the hash `?? undefined`, and the scripts under
  // apps/api/scripts/ — type-checked by `npm run lint` since the audit —
  // pass `sessionId: null` for a run with no session.
  signatureMeaning?: string | null;
}

/**
 * Actions that are emitted by background system processes (no human or
 * authenticated principal). NULL `userId` is allowed for these. Every other
 * action must carry a userId, enforced at runtime by `auditLog`.
 *
 * Delta-audit 2026-05-20 §C5 / May 16 §1.6 fix. Pre-fix the userId was
 * optional with no app-layer check; any state-changing action could be
 * recorded with no user attribution, violating § 11.10(e).
 *
 * If a new system-emitted action needs to skip the userId check, add it
 * here AND document why. Default is "userId required."
 */
const SYSTEM_AUDIT_ACTIONS = new Set<string>([
  'SYSTEM_BOOT',
  'SYSTEM_HEALTH_CHECK',
  'SYSTEM_SHUTDOWN',
  'MOSQUITTO_ACL_REFRESH',     // internal route fired by mqtt service refresh
  'PIPELINE_TRACE',             // ingestion stage traces
  'NOTIFICATION_DISPATCH',      // worker-emitted delivery audit
  'BACKUP_RETENTION_PRUNE',     // retention sweep
  'DLQ_OVERFLOW',               // dead-letter overflow
  'INSTRUMENT_ATTRIBUTE_REPORTED', // an attribute written by the DEVICE over MQTT (2026-09-05) — the device's code is in the row, there is no user
  'ADMIN_REQUEST_SUBMITTED',    // the PUBLIC admin-request form (2026-10-03): the caller is unauthenticated, the typed employee id is data in afterValue
  'DEVIATION_OPENED',           // PM overdue sweep — auto-opens a deviation (no user when cron-fired)
  'DEVIATION_CLOSED',           // PM overdue sweep — auto-closes when filters cleaned (no user when cron-fired)
  'DEVIATION_OPEN_BLOCKED',     // PM overdue sweep — re-overdue task whose deviation row is already CLOSED (no user when cron-fired)
]);

/**
 * Prisma transaction-client type. Anything that satisfies the Prisma
 * `Prisma.TransactionClient` interface — i.e., the `tx` parameter inside
 * a `prisma.$transaction(async (tx) => { ... })` callback — can be passed
 * to `auditLog` so the audit write joins the caller's transaction.
 */
export type AuditTx = Prisma.TransactionClient;

// Audit 2026-05-04 fix C3: Postgres advisory lock id used to serialize
// audit-trail writes so the hash chain stays monotonic across concurrent
// writers. The numeric id is arbitrary but must be stable. 7421151037n
// (= "AUDITCHN" if you squint at base32) — chosen for traceability + zero
// chance of collision with application-domain advisory locks.
const AUDIT_CHAIN_LOCK_ID = 7421151037n;

/**
 * Standalone audit logging function. Writes a chained audit row.
 *
 * Two modes:
 *   - **Standalone** (no `tx` arg) — opens its own `prisma.$transaction`
 *     and writes inside it. Use this only for ad-hoc / read-side audits
 *     where there's no business transaction to share.
 *   - **Transactional** (audit §1.1, 2026-05-16) — pass the caller's
 *     `tx` from inside `prisma.$transaction(async (tx) => { ... })`. The
 *     audit write joins the same transaction; if the business mutation
 *     rolls back, the audit row rolls back too. **This is the only mode
 *     that satisfies § 11.10(e) for mutation paths** — without it, a
 *     transient failure between the business commit and the standalone
 *     audit commit leaves state changed with no audit record.
 *
 * In both modes:
 *   1. `pg_advisory_xact_lock(AUDIT_CHAIN_LOCK_ID)` — serializes audit
 *      writes across all backends. Released on commit/rollback automatically.
 *      Re-entrant: acquiring the same lock twice from the same tx is a
 *      no-op (Postgres tracks per-tx hold count).
 *   2. SELECT the prior chain row's checksum (highest chain_position).
 *   3. Compute this row's checksum INCLUDING previousChecksum.
 *   4. INSERT the new row with both checksum + previous_checksum.
 *
 * Pre-chain rows (written before the C3 migration) carry previous_checksum
 * NULL. The first row written AFTER the migration becomes the chain
 * genesis — its previous_checksum is the checksum of the most recent
 * pre-chain row IF one exists, or NULL otherwise. That single bridge step
 * means a deletion of the last pre-chain row is detectable too.
 */
/**
 * `audit_trail.signature_meaning` is VARCHAR(255). A meaning longer than that
 * is cut to fit with an ellipsis rather than refused: the sentence names the
 * act, the detail belongs in `beforeValue` / `afterValue` (JSONB, unbounded),
 * and a 500 after the mutation committed is the worse outcome. Callers that
 * list many names should still compose with `boundedMeaning()` so the cut is
 * at a name boundary; this is the backstop for every other caller.
 */
export const SIGNATURE_MEANING_MAX = 255;
export function clampSignatureMeaning(meaning: string | undefined | null): string | undefined {
  if (meaning === undefined || meaning === null) return undefined;
  if (meaning.length <= SIGNATURE_MEANING_MAX) return meaning;
  return meaning.slice(0, SIGNATURE_MEANING_MAX - 1) + '…';
}

export async function auditLog(entry: AuditEntry, tx?: AuditTx): Promise<void> {
  // 21 CFR §11.10(e): every state-changing action must identify the
  // individual responsible. Reject calls that omit userId unless the
  // action is on the explicit system allow-list.
  if (!entry.userId && !SYSTEM_AUDIT_ACTIONS.has(entry.action)) {
    throw new Error(
      `audit.userId required for action='${entry.action}'. ` +
      `If this is a system-emitted action with no user principal, add it to ` +
      `SYSTEM_AUDIT_ACTIONS in apps/api/src/lib/audit.ts and document why.`,
    );
  }
  const timestamp = new Date();
  // Bounded ONCE here, before it is hashed or stored (audit 2026-10-03,
  // API-4): `signature_meaning` is VARCHAR(255) behind this raw insert, and a
  // longer meaning was a 22001 AFTER the caller's mutation had committed — a
  // record with no audit row. The bound and the hash must see the same string.
  const signatureMeaning = clampSignatureMeaning(entry.signatureMeaning);
  const afterValueClean = entry.afterValue ? JSON.parse(JSON.stringify(entry.afterValue)) : undefined;
  const beforeValueClean = entry.beforeValue ? JSON.parse(JSON.stringify(entry.beforeValue)) : undefined;
  // Checksum field set (expanded 2026-07-04): cover EVERY persisted audit column so
  // beforeValue / reason / signatureMeaning (§11.50) / userRole / userName / ip /
  // agent / session are all inside the tamper-evidence envelope. Keys + values MUST
  // stay byte-identical to `expandedFields` in hash-chain.ts:verifyAuditChecksum.
  // Old rows keep verifying via that function's reduced fallback (no rewrite).
  const baseFields = {
    timestamp: timestamp.toISOString(),
    userId: entry.userId ?? undefined,
    userName: entry.userName ?? undefined,
    userRole: entry.userRole ?? undefined,
    action: entry.action,
    targetType: entry.targetType ?? undefined,
    targetId: entry.targetId ?? undefined,
    beforeValue: beforeValueClean,
    afterValue: afterValueClean,
    reason: entry.reason ?? undefined,
    ipAddress: entry.ipAddress ?? undefined,
    userAgent: entry.userAgent ?? undefined,
    sessionId: entry.sessionId ?? undefined,
    signatureMeaning,
  } as Record<string, unknown>;

  if (tx) {
    // Transactional mode — write inside caller's tx.
    await writeAuditRow(tx, entry, timestamp, baseFields, beforeValueClean, afterValueClean);
  } else {
    // Standalone mode — open our own tx.
    await prisma.$transaction(async (txInner) => {
      await writeAuditRow(txInner, entry, timestamp, baseFields, beforeValueClean, afterValueClean);
    });
  }

  // (operation-tracer per-action debug trace removed with data-ingestion removal.
  // To be re-implemented against instrument events in the
  // repurposed TraceSource framework — see runbook Section 14.)
}

async function writeAuditRow(
  tx: AuditTx,
  entry: AuditEntry,
  timestamp: Date,
  baseFields: Record<string, unknown>,
  beforeValueClean: unknown,
  afterValueClean: unknown,
): Promise<void> {
  // Acquire the advisory lock. Released automatically on tx commit/rollback.
  // Using $executeRaw because pg_advisory_xact_lock returns void; $queryRaw
  // expects rows and Prisma's deserializer rejects 'void' column type.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_ID})`;

  // Read the latest chain row's checksum to link this row to it.
  const prior = await tx.$queryRaw<Array<{ checksum: string | null }>>`
    SELECT checksum
    FROM audit_trail
    ORDER BY chain_position DESC NULLS LAST
    LIMIT 1
  `;
  const previousChecksum: string | null = prior[0]?.checksum ?? null;

  // Keyed (V3, HMAC) checksum when AUDIT_CHAIN_KEY is configured, else the
  // unkeyed V2 fallback so an un-keyed install still writes a valid chain.
  // checksum_version = 3 marks keyed rows; NULL marks legacy V2/V1 rows so the
  // verifier picks the right formula and never accepts unkeyed for a v3 row.
  const chainKey = getAuditChainKey();
  const checksum = chainKey
    ? computeChainedChecksumV3(baseFields, previousChecksum, chainKey)
    : computeChainedChecksumV2(baseFields, previousChecksum);
  const checksumVersion: number | null = chainKey ? 3 : null;

  // Insert via raw SQL so we can write the new chain columns without
  // depending on a regenerated Prisma client (the dev server may be
  // holding the engine DLL when migration runs). chain_position is
  // BIGSERIAL so DEFAULT auto-fills it.
  await tx.$executeRaw`
    INSERT INTO audit_trail (
      timestamp, user_id, user_name, user_role, action,
      target_type, target_id, before_value, after_value,
      reason, ip_address, user_agent, session_id,
      checksum, previous_checksum, signature_meaning, checksum_version
    ) VALUES (
      ${timestamp},
      ${entry.userId ?? null},
      ${entry.userName ?? null},
      ${entry.userRole ?? null},
      ${entry.action},
      ${entry.targetType ?? null},
      ${entry.targetId ?? null},
      ${beforeValueClean ? JSON.stringify(beforeValueClean) : null}::jsonb,
      ${afterValueClean ? JSON.stringify(afterValueClean) : null}::jsonb,
      ${entry.reason ?? null},
      ${entry.ipAddress ?? null},
      ${entry.userAgent ?? null},
      ${entry.sessionId ?? null},
      ${checksum},
      ${previousChecksum},
      ${(baseFields.signatureMeaning as string | undefined) ?? null},
      ${checksumVersion}
    )
  `;
}
