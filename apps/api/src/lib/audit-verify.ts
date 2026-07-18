/**
 * Audit chain verifier — audit 2026-05-04 fix C3.
 *
 * Walks audit_trail in chain_position order and reports any per-row checksum
 * mismatch OR chain-link mismatch. Used by the operator-facing
 * GET /api/audit/verify-chain endpoint and by tests that prove tampering is
 * detected.
 *
 * Pre-chain rows (previous_checksum NULL) are verified by per-row checksum
 * only — they predate the C3 migration and have no chain link.
 *
 * Tamper modes detected:
 *   - row N's per-row checksum doesn't match its current field values
 *     (in-place mutation)
 *   - row N's previous_checksum doesn't match row N-1's checksum (insertion
 *     between N-1 and N, or deletion of N-1)
 *   - row N+1's previous_checksum doesn't match row N's checksum after row N
 *     is mutated (forward propagation — every later row also fails)
 *
 * Tamper modes NOT detected by chain alone (require external counter):
 *   - deletion of the latest row (no successor exists to detect the gap)
 *   - removal of the entire tail. Mitigated by chain_position monotonicity:
 *     verifyChain returns the highest position seen, which an operator can
 *     compare against an out-of-band record (e.g., last known max from a
 *     daily snapshot).
 */
import { prisma } from './prisma.js';
import { verifyAuditChecksum } from './hash-chain.js';

export interface ChainAnomaly {
  position: number;
  id: string;
  kind: 'PER_ROW_CHECKSUM_MISMATCH' | 'CHAIN_LINK_MISMATCH' | 'CHAIN_POSITION_GAP';
  message: string;
  expected?: string | null;
  actual?: string | null;
}

export interface VerifyChainOptions {
  /** Verify only rows in [fromPosition, toPosition]. Default: full table. */
  fromPosition?: number;
  toPosition?: number;
  /** Stop after N anomalies (the rest may be cascading). Default: 100. */
  maxAnomalies?: number;
}

export interface VerifyChainResult {
  totalRowsChecked: number;
  preChainRows: number;
  chainedRows: number;
  highestPosition: number | null;
  anomalies: ChainAnomaly[];
  intact: boolean;
}

interface AuditRow {
  id: string;
  chain_position: bigint | number | null;
  timestamp: Date;
  user_id: string | null;
  user_name: string | null;
  user_role: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  before_value: unknown;
  after_value: unknown;
  reason: string | null;
  ip_address: string | null;
  user_agent: string | null;
  session_id: string | null;
  signature_meaning: string | null;
  checksum: string;
  previous_checksum: string | null;
  redacted_at: Date | null;
  checksum_version: number | null;
}

export async function verifyAuditChain(opts: VerifyChainOptions = {}): Promise<VerifyChainResult> {
  const maxAnomalies = opts.maxAnomalies ?? 100;
  const fromPos = opts.fromPosition ?? 0;
  const toPos = opts.toPosition ?? Number.MAX_SAFE_INTEGER;

  // Read in chain_position order. NULL chain_positions land last (NULLS LAST)
  // — those rows wouldn't exist after the migration backfill, but the SQL
  // is defensive.
  const rows = await prisma.$queryRaw<AuditRow[]>`
    SELECT id, chain_position, timestamp, user_id, user_name, user_role, action,
           target_type, target_id, before_value, after_value, reason,
           ip_address, user_agent, session_id, signature_meaning,
           checksum, previous_checksum, redacted_at, checksum_version
    FROM audit_trail
    WHERE chain_position >= ${fromPos}
      AND chain_position <= ${toPos}
    ORDER BY chain_position ASC NULLS LAST
  `;

  const anomalies: ChainAnomaly[] = [];
  let preChainRows = 0;
  let chainedRows = 0;
  let priorChecksum: string | null = null;
  let priorPosition: number | null = null;
  let highestPosition: number | null = null;

  for (const row of rows) {
    const position = row.chain_position == null
      ? -1
      : (typeof row.chain_position === 'bigint' ? Number(row.chain_position) : row.chain_position);
    if (position > (highestPosition ?? -1)) highestPosition = position;

    // Per-row checksum verification.
    const perRowOk = verifyAuditChecksum({
      timestamp: row.timestamp,
      userId: row.user_id,
      // #audit-3 (2026-07-04): plumb ALL persisted columns so the expanded
      // checksum (audit.ts) verifies for new rows. Omitting any of these would
      // reconstruct the expanded field set with nulls → per-row mismatch on
      // every post-expansion row. Old rows ignore the extras via the reduced
      // fallback in verifyAuditChecksum.
      userName: row.user_name,
      userRole: row.user_role,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      beforeValue: row.before_value ?? undefined,
      afterValue: row.after_value ?? undefined,
      reason: row.reason,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      sessionId: row.session_id,
      signatureMeaning: row.signature_meaning,
      checksum: row.checksum,
      previousChecksum: row.previous_checksum,
      // #audit-2: plumb redacted_at so verifyAuditChecksum's redaction
      // short-circuit (hash-chain.ts) fires during the chain walk. Without
      // this, a chain-preserving REDACT (after_value nulled, checksum kept)
      // false-FAILs verify-chain while GET /api/audit shows the row valid.
      redactedAt: row.redacted_at ?? undefined,
      // Keyed-era (v3) rows must verify against the HMAC; legacy rows (NULL)
      // keep using the unkeyed V1/V2 fallback in verifyAuditChecksum.
      checksumVersion: row.checksum_version,
    });
    if (!perRowOk) {
      anomalies.push({
        position,
        id: row.id,
        kind: 'PER_ROW_CHECKSUM_MISMATCH',
        message: `Row ${row.id} checksum does not match its current field values — in-place tampering detected.`,
      });
      if (anomalies.length >= maxAnomalies) break;
    }

    if (row.previous_checksum != null) {
      chainedRows++;
      // Chain link verification: only meaningful when we have a prior chain row.
      // The genesis row (first chained row written, possibly bridging the
      // pre-chain era) carries previousChecksum == checksum-of-last-pre-chain-row;
      // we don't have that bridge value tracked separately, so we accept any
      // non-null value as "valid genesis" iff it's the first chained row
      // we've encountered in this walk.
      if (priorChecksum != null && row.previous_checksum !== priorChecksum) {
        anomalies.push({
          position,
          id: row.id,
          kind: 'CHAIN_LINK_MISMATCH',
          message: `Row ${row.id} previous_checksum does not match the prior row's checksum — insertion or deletion detected.`,
          expected: priorChecksum,
          actual: row.previous_checksum,
        });
        if (anomalies.length >= maxAnomalies) break;
      }
    } else {
      preChainRows++;
    }

    // Detect chain_position gaps (deletion of an interior row).
    if (priorPosition != null && position - priorPosition > 1) {
      anomalies.push({
        position,
        id: row.id,
        kind: 'CHAIN_POSITION_GAP',
        message: `Gap between chain_position ${priorPosition} and ${position} — interior row deletion detected.`,
        expected: String(priorPosition + 1),
        actual: String(position),
      });
      if (anomalies.length >= maxAnomalies) break;
    }

    priorChecksum = row.checksum;
    priorPosition = position;
  }

  return {
    totalRowsChecked: rows.length,
    preChainRows,
    chainedRows,
    highestPosition,
    anomalies,
    intact: anomalies.length === 0,
  };
}
