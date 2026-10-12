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
 *   - KEYED-ERA DOWNGRADE (2026-07-25): a v3 row relabelled checksum_version
 *     = NULL and recomputed with the unkeyed formula. See below.
 *
 * Tamper modes NOT detected by chain alone (require external counter):
 *   - deletion of the latest row (no successor exists to detect the gap)
 *   - removal of the entire tail. Mitigated by chain_position monotonicity:
 *     verifyChain returns the highest position seen, which an operator can
 *     compare against an out-of-band record (e.g., last known max from a
 *     daily snapshot).
 *
 * ── Keyed-era enforcement (added 2026-07-25) ────────────────────────────────
 * verifyAuditChecksum() picks the keyed (v3) or unkeyed (v1/v2) formula from
 * the row's OWN `checksum_version` column — which lives in the very table the
 * chain protects. A DB-level actor could therefore:
 *     1. take a v3 row, set checksum_version = NULL,
 *     2. recompute its checksum with the unkeyed formula (NO key needed),
 *     3. cascade-relink the forward chain unkeyed,
 * and the walk below would take the unkeyed branch and PASS.
 *
 * AUDIT_CHAIN_KEYED_FROM is the out-of-band anchor that closes this: it lives
 * in the API's environment, NOT in the database, and records the chain_position
 * at which keying began. Any row at or after it MUST be v3. The downgrade above
 * changes the row's version away from 3, so it is caught here.
 *
 * `getAuditChainKeyedFrom()` existed since the keyed-chain work but had NO
 * CALLERS — the defence its docstring described was never actually enforced.
 * This is that enforcement.
 */
import { prisma } from './prisma.js';
import { verifyAuditChecksum } from './hash-chain.js';
import { getAuditChainKeyedFrom } from './hash-chain.js';

export type ChainAnomalyKind =
  | 'PER_ROW_CHECKSUM_MISMATCH' | 'CHAIN_LINK_MISMATCH' | 'CHAIN_POSITION_GAP'
  | 'KEYED_ERA_DOWNGRADE' | 'REDACTION_UNATTESTED' | 'REDACTION_MISMATCH';

export interface ChainAnomaly {
  position: number;
  id: string;
  kind: ChainAnomalyKind;
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

/**
 * One audit_trail row in COLUMN form — what `SELECT *` returns and what a
 * backup archive carries. Archive rows arrive JSON-round-tripped: bigints as
 * strings and timestamps as ISO strings; the walk normalises both.
 */
export interface ChainRow {
  id: string;
  chain_position: bigint | number | string | null;
  timestamp: Date | string;
  user_id: string | null;
  user_name?: string | null;
  user_role?: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  before_value?: unknown;
  after_value?: unknown;
  reason?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
  session_id?: string | null;
  signature_meaning?: string | null;
  checksum: string;
  previous_checksum: string | null;
  redacted_at?: Date | string | null;
  checksum_version?: number | null;
}

/**
 * A meta row that names a redacted row: an AUDIT_RECORD_REDACTED row
 * (target_id = the row, `record` = its before_value) or one entry of an
 * AUDIT_RECORDS_BULK_REDACTED row's before_value.records[].
 */
export interface RedactionAttestation {
  /** The redacted row the meta row names. */
  id: string;
  /** chain_position of the META row. */
  position: number;
  /** The redacted row's columns as the meta row recorded them, or null when
   *  the meta row is itself redacted (its before_value is gone). */
  record: Record<string, unknown> | null;
}

export interface WalkOptions {
  /** The row just before the window — its checksum and position — so the
   *  first row's link and gap are checked too. */
  seed?: { checksum: string; position: number } | null;
  maxAnomalies?: number;
  /** Every meta row naming any of `ids`, wherever it sits. */
  findRedactionAttestations: (ids: string[]) => Promise<RedactionAttestation[]>;
}

const toPosition = (p: bigint | number | string | null | undefined): number =>
  p == null ? -1 : Number(p);

/**
 * THE chain walk (audit 2026-10-12 #3) — the live verifier below and the
 * backup restore's pre-check (`modules/backup/backup.repository.ts`) both run
 * this, so an archive is held to exactly the standard the live trail is.
 * Until then restore had its own copy that checked per-row checksums and links
 * only — no keyed era, no gaps, no redaction attestation — and a downgraded or
 * forged archive installed without `force`, TRUNCATEing the real trail.
 *
 * Only data access differs between the two callers: where the rows come from,
 * and where a redaction's meta row is looked up (the live table, or the
 * archive itself — never the live table for an archive).
 */
export async function walkAuditChain(input: ChainRow[], opts: WalkOptions): Promise<VerifyChainResult> {
  const maxAnomalies = opts.maxAnomalies ?? 100;
  // chain_position order, NULLs last — the live query's order.
  const rows = [...input].sort((a, b) => {
    const ap = a.chain_position == null ? Number.MAX_SAFE_INTEGER : Number(a.chain_position);
    const bp = b.chain_position == null ? Number.MAX_SAFE_INTEGER : Number(b.chain_position);
    return ap - bp;
  });

  const anomalies: ChainAnomaly[] = [];
  let preChainRows = 0;
  let chainedRows = 0;
  let priorChecksum: string | null = opts.seed?.checksum ?? null;
  let priorPosition: number | null = opts.seed?.position ?? null;
  let highestPosition: number | null = null;

  // Redacted rows in the window, cross-checked below against the meta row
  // that records who redacted them.
  const redacted: Array<{ row: ChainRow; position: number }> = [];

  // Out-of-band keyed-era boundary. NOTE: 0 is a LEGITIMATE value (a fresh
  // install keys from the very first row), so this must be compared with
  // `!== null` — a truthiness check would silently disable enforcement for the
  // strictest possible configuration.
  const keyedFrom = getAuditChainKeyedFrom();

  for (const row of rows) {
    const position = toPosition(row.chain_position);
    if (position > (highestPosition ?? -1)) highestPosition = position;
    const checksumVersion = row.checksum_version ?? null;

    // Keyed-era enforcement: at/after the cutover, a row that is not v3 has
    // been downgraded. Checked BEFORE the per-row checksum, because a
    // successful downgrade produces a checksum that verifies under the unkeyed
    // formula — so the per-row check alone would report the row as healthy.
    if (keyedFrom !== null && position >= keyedFrom && checksumVersion !== 3) {
      anomalies.push({
        position,
        id: row.id,
        kind: 'KEYED_ERA_DOWNGRADE',
        message:
          `Row ${row.id} at chain_position ${position} is at/after the keyed-era boundary `
          + `(AUDIT_CHAIN_KEYED_FROM=${keyedFrom}) but has checksum_version=`
          + `${checksumVersion === null ? 'NULL' : checksumVersion}, not 3. `
          + `A keyed row was downgraded to the unkeyed formula, or the boundary is misconfigured.`,
        expected: '3',
        actual: checksumVersion === null ? null : String(checksumVersion),
      });
      if (anomalies.length >= maxAnomalies) break;
    }

    // Per-row checksum verification.
    const perRowOk = verifyAuditChecksum({
      timestamp: row.timestamp,
      userId: row.user_id,
      // #audit-3 (2026-07-04): plumb ALL persisted columns so the expanded
      // checksum (audit.ts) verifies for new rows. Omitting any of these would
      // reconstruct the expanded field set with nulls → per-row mismatch on
      // every post-expansion row. Old rows ignore the extras via the reduced
      // fallback in verifyAuditChecksum.
      userName: row.user_name ?? null,
      userRole: row.user_role ?? null,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      beforeValue: row.before_value ?? undefined,
      afterValue: row.after_value ?? undefined,
      reason: row.reason ?? null,
      ipAddress: row.ip_address ?? null,
      userAgent: row.user_agent ?? null,
      sessionId: row.session_id ?? null,
      signatureMeaning: row.signature_meaning ?? null,
      checksum: row.checksum,
      previousChecksum: row.previous_checksum,
      // #audit-2: plumb redacted_at so verifyAuditChecksum's redaction
      // short-circuit (hash-chain.ts) fires during the chain walk. Without
      // this, a chain-preserving REDACT (after_value nulled, checksum kept)
      // false-FAILs verify-chain while GET /api/audit shows the row valid.
      redactedAt: row.redacted_at ?? undefined,
      // Keyed-era (v3) rows must verify against the HMAC; legacy rows (NULL)
      // keep using the unkeyed V1/V2 fallback in verifyAuditChecksum.
      checksumVersion,
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

    if (row.redacted_at != null) redacted.push({ row, position });

    priorChecksum = row.checksum;
    priorPosition = position;
  }

  // Every redacted row must be named by a LATER meta row — AUDIT_RECORD_REDACTED
  // (target_id) or AUDIT_RECORDS_BULK_REDACTED (before_value.records[].id) —
  // written in the same transaction as the redaction by audit/routes.ts (audit
  // 2026-10-03, DATA-6). The per-row check cannot recompute a redacted row's
  // checksum, so without this a DB actor who NULLed the payloads and stamped
  // redacted_at passed as a legitimate redaction; the trigger
  // `audit_trail_no_update` refuses that UPDATE, and this is the detection for
  // a redaction made with the trigger disabled.
  //
  // And the meta row's own `before_value` — inside ITS checksum — records the
  // redacted row's action, timestamp, userId, targetType and targetId. Those
  // are compared with the redacted row's columns (audit 2026-10-12 #4): until
  // then a redacted row had no tamper evidence outside its payload, which the
  // redaction removed, so its columns could be rewritten freely.
  //
  // Known limit: a BULK meta row that is itself later redacted loses its
  // record list, so the rows it attested report here. The evidence of who
  // redacted them was removed; that is the right thing to show. A SINGLE meta
  // row that is later redacted keeps its target_id, so it still attests, but
  // its record is gone and the columns cannot be compared.
  if (redacted.length > 0 && anomalies.length < maxAnomalies) {
    const meta = await opts.findRedactionAttestations(redacted.map((r) => r.row.id));
    const byId = new Map<string, RedactionAttestation[]>();
    for (const m of meta) byId.set(m.id, [...(byId.get(m.id) ?? []), m]);
    for (const { row, position } of redacted) {
      const all = byId.get(row.id) ?? [];
      // The meta row is written AFTER the UPDATE in the same transaction, so a
      // genuine attestation always sits later in the chain than the row it names.
      const later = all.filter((m) => m.position > position);
      if (later.length === 0) {
        const at = all.length > 0 ? Math.max(...all.map((m) => m.position)) : undefined;
        anomalies.push({
          position,
          id: row.id,
          kind: 'REDACTION_UNATTESTED',
          message: at === undefined
            ? `Row ${row.id} is redacted but no AUDIT_RECORD_REDACTED / AUDIT_RECORDS_BULK_REDACTED row names it — the payload was cleared outside the redact endpoints.`
            : `Row ${row.id} is redacted but the only meta row naming it sits at chain_position ${at}, before the row itself — not a record of this redaction.`,
        });
        if (anomalies.length >= maxAnomalies) break;
        continue;
      }
      const verdicts = later.map((m) => (m.record ? recordMismatch(row, m.record) : []));
      if (verdicts.some((v) => v.length === 0)) continue;
      const fields = [...new Set(verdicts.flat())];
      anomalies.push({
        position,
        id: row.id,
        kind: 'REDACTION_MISMATCH',
        message: `Row ${row.id} is redacted, but its ${fields.join(', ')} no longer match what the meta row recording its redaction says — the row was altered after it was redacted.`,
      });
      if (anomalies.length >= maxAnomalies) break;
    }
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

/** The meta record's keys that name a redacted row's columns. Only keys the
 *  record actually carries are compared — an older meta row may lack some. */
const RECORD_COLUMNS: Array<[string, (r: ChainRow) => unknown]> = [
  ['action', (r) => r.action],
  ['timestamp', (r) => r.timestamp],
  ['userId', (r) => r.user_id],
  ['targetType', (r) => r.target_type],
  ['targetId', (r) => r.target_id],
];

function normalise(key: string, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (key === 'timestamp') {
    const d = v instanceof Date ? v : new Date(String(v));
    return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
  }
  return String(v);
}

/** The columns of `row` that disagree with the meta row's record of it. */
function recordMismatch(row: ChainRow, record: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, col] of RECORD_COLUMNS) {
    if (!(key in record)) continue;
    if (normalise(key, record[key]) !== normalise(key, col(row))) out.push(key);
  }
  return out;
}

/**
 * The redaction attestations for `ids`, read from a set of rows in memory —
 * the backup archive's own rows. Same rules as the live SQL in
 * `verifyAuditChain`: single meta rows by target_id, bulk ones by
 * before_value.records[].id.
 */
export function attestationsFromRows(rows: ChainRow[]): (ids: string[]) => Promise<RedactionAttestation[]> {
  return async (ids) => {
    const want = new Set(ids);
    const out: RedactionAttestation[] = [];
    for (const r of rows) {
      const position = toPosition(r.chain_position);
      const before = (r.before_value ?? null) as Record<string, unknown> | null;
      if (r.action === 'AUDIT_RECORD_REDACTED' && r.target_id && want.has(r.target_id)) {
        out.push({ id: r.target_id, position, record: before && typeof before === 'object' ? before : null });
      } else if (r.action === 'AUDIT_RECORDS_BULK_REDACTED' && before && Array.isArray(before.records)) {
        for (const rec of before.records as Array<Record<string, unknown>>) {
          const id = rec && typeof rec.id === 'string' ? rec.id : null;
          if (id && want.has(id)) out.push({ id, position, record: rec });
        }
      }
    }
    return out;
  };
}

/** The live verifier: reads the window from audit_trail and walks it. */
export async function verifyAuditChain(opts: VerifyChainOptions = {}): Promise<VerifyChainResult> {
  const fromPos = opts.fromPosition ?? 0;
  const toPos = opts.toPosition ?? Number.MAX_SAFE_INTEGER;

  // Read in chain_position order. NULL chain_positions land last (NULLS LAST)
  // — those rows wouldn't exist after the migration backfill, but the SQL
  // is defensive.
  const rows = await prisma.$queryRaw<ChainRow[]>`
    SELECT id, chain_position, timestamp, user_id, user_name, user_role, action,
           target_type, target_id, before_value, after_value, reason,
           ip_address, user_agent, session_id, signature_meaning,
           checksum, previous_checksum, redacted_at, checksum_version
    FROM audit_trail
    WHERE chain_position >= ${fromPos}
      AND chain_position <= ${toPos}
    ORDER BY chain_position ASC NULLS LAST
  `;

  // A RANGED walk seeds its link from the row just before the window (audit
  // 2026-10-03, DATA-18). Until then the first row in [fromPosition, ...] was
  // treated as genesis — its previous_checksum accepted unchecked — so a break
  // between N-1 and N was invisible to `?fromPosition=N`, and an auditor
  // verifying in windows could be told "intact" across a cut. Seeding the
  // position too lets the gap check see a row deleted at the boundary.
  let seed: { checksum: string; position: number } | null = null;
  if (fromPos > 0) {
    const [prior] = await prisma.$queryRaw<Array<{ checksum: string; chain_position: bigint | number }>>`
      SELECT checksum, chain_position
      FROM audit_trail
      WHERE chain_position < ${fromPos}
      ORDER BY chain_position DESC
      LIMIT 1
    `;
    if (prior) seed = { checksum: prior.checksum, position: toPosition(prior.chain_position) };
  }

  return walkAuditChain(rows, {
    seed,
    maxAnomalies: opts.maxAnomalies,
    // The meta rows are looked up over the WHOLE table, not the window, since
    // they follow the redaction.
    findRedactionAttestations: async (ids) => {
      const meta = await prisma.$queryRaw<Array<{ id: string; chain_position: bigint | number | null; record: unknown }>>`
        SELECT target_id AS id, chain_position, before_value AS record
        FROM audit_trail
        WHERE action = 'AUDIT_RECORD_REDACTED' AND target_id = ANY(${ids}::text[])
        UNION ALL
        SELECT r->>'id' AS id, a.chain_position, r AS record
        FROM audit_trail a, jsonb_array_elements(a.before_value->'records') r
        WHERE a.action = 'AUDIT_RECORDS_BULK_REDACTED'
          AND jsonb_typeof(a.before_value->'records') = 'array'
          AND (r->>'id') = ANY(${ids}::text[])
      `;
      return meta.map((m) => ({
        id: m.id,
        position: toPosition(m.chain_position),
        record: m.record && typeof m.record === 'object' ? (m.record as Record<string, unknown>) : null,
      }));
    },
  });
}
