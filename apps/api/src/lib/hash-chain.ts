import { createHash, createHmac } from 'node:crypto';

// ---------------------------------------------------------------------------
// V3 keyed checksum — HMAC-SHA256 (audit finding: unkeyed chain is forgeable)
// ---------------------------------------------------------------------------
//
// V1/V2 hash the audit fields with a plain SHA-256. The checksum and
// previous_checksum live in the same audit_trail table they protect, so a
// DB-level actor (the exact threat the immutability triggers + chain defend
// against — triggers can be disabled) can recompute a fully self-consistent
// forged chain that passes verify-chain. V3 mixes in a secret key
// (AUDIT_CHAIN_KEY, held OUTSIDE the database in the API service's env), so an
// actor with DB write access but no key cannot forge a passing checksum.
//
// Versioning (mirrors the V1→V2 philosophy — never rewrite immutable history):
//   - New rows are stamped audit_trail.checksum_version = 3 and written with
//     the keyed HMAC when AUDIT_CHAIN_KEY is set; when it is unset the writer
//     falls back to V2 (version NULL) so an un-keyed install still works.
//   - The verifier REQUIRES the key + an HMAC match for version-3 rows and does
//     NOT accept the unkeyed V1/V2 formulas for them — otherwise a DB actor
//     could downgrade a row to unkeyed and still pass. Downgrading a stored v3
//     row to unkeyed breaks the FORWARD chain link (the next v3 row's
//     previous_checksum no longer matches), and re-linking the whole forward
//     chain needs the key — so the downgrade attack surfaces on a chain walk.
//   - Legacy rows (version NULL / 1 / 2) keep verifying via the unkeyed V1/V2
//     fallback, so all historical audit history stays valid across the cutover.

let auditChainKey: string | null | undefined; // undefined = not yet resolved

/**
 * The audit-chain HMAC key from `AUDIT_CHAIN_KEY`, or null when unset/blank.
 * Resolved once and cached. When null, the writer stays on unkeyed V2 (no
 * security improvement, but the app still works) and v3 rows cannot be verified.
 */
export function getAuditChainKey(): string | null {
  if (auditChainKey === undefined) {
    const k = process.env.AUDIT_CHAIN_KEY;
    auditChainKey = k && k.trim().length > 0 ? k.trim() : null;
  }
  return auditChainKey;
}

/** Test-only override for the cached key (both to set and to clear). */
export function __setAuditChainKeyForTest(key: string | null | undefined): void {
  auditChainKey = key;
}

let auditChainKeyedFrom: number | null | undefined;

/**
 * The keyed-era start `chain_position` from `AUDIT_CHAIN_KEYED_FROM`, or null
 * when unset. This is the OUT-OF-BAND anchor (it lives where AUDIT_CHAIN_KEY
 * lives — the env, NOT the mutable DB) that makes the keyed chain actually
 * tamper-evident: any row at/after this position MUST be a valid v3 (HMAC) row.
 *
 * Without it, a DB-level actor could relabel a v3 row `checksum_version = NULL`,
 * recompute it with the unkeyed formula, cascade-relink the forward chain
 * unkeyed, and pass verification — no key needed. Enforcing "position >= cutover
 * ⟹ must be v3" catches that downgrade because the downgraded row's version is
 * no longer 3. The operator sets this to the HEAD chain_position captured at the
 * moment AUDIT_CHAIN_KEY is first enabled (verify-chain reports headPosition).
 */
export function getAuditChainKeyedFrom(): number | null {
  if (auditChainKeyedFrom === undefined) {
    const raw = process.env.AUDIT_CHAIN_KEYED_FROM;
    const n = raw != null && raw.trim() !== '' ? Number(raw) : NaN;
    auditChainKeyedFrom = Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  }
  return auditChainKeyedFrom;
}

/** Test-only override for the cached keyed-era boundary. */
export function __setAuditChainKeyedFromForTest(from: number | null | undefined): void {
  auditChainKeyedFrom = from;
}

/** V3 per-row checksum: keyed HMAC-SHA256 over the V2 recursive canonical form. */
export function computeChecksumV3(data: Record<string, unknown>, key: string): string {
  return createHmac('sha256', key).update(canonicalize(data)).digest('hex');
}

/** V3 chained checksum: binds the row to its predecessor under the keyed HMAC. */
export function computeChainedChecksumV3(
  data: Record<string, unknown>,
  previousChecksum: string | null,
  key: string,
): string {
  return computeChecksumV3({ ...data, previousChecksum }, key);
}

/**
 * V1 canonical form: sorts only top-level keys, then JSON.stringify.
 *
 * This is the ORIGINAL formula used by `computeChecksum` / `computeChainedChecksum`
 * since audit fix C3 (2026-05-04). It is VERIFY-ONLY now: rows written before
 * 2026-05-29 carry V1 checksums and are verified through the fallback in
 * `matchesStoredChecksum`. NEW ROWS ARE NOT WRITTEN WITH IT — `audit.ts` writes
 * V2 (`computeChainedChecksumV2`), or V3 (`computeChainedChecksumV3`, keyed)
 * when AUDIT_CHAIN_KEY is set. This comment said the opposite until the
 * 2026-10-03 audit (DATA-14); a maintainer "restoring the documented write
 * formula" would have forked the chain.
 *
 * DO NOT change this function — it is the contract for every V1 checksum still
 * stored in audit_trail.
 */
export function computeChecksum(data: Record<string, unknown>): string {
  // Sort keys for deterministic ordering, then stringify fully
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(data).sort()) {
    sorted[key] = data[key];
  }
  const payload = JSON.stringify(sorted);
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Audit 2026-05-04 fix C3: chain-aware checksum.
 *
 * When `previousChecksum` is supplied, mix it into the SHA256 input so the
 * row binds to its predecessor. Tampering with row N OR removing/inserting
 * any row before N invalidates row N+1's chain link, surfacing during a
 * verifyChain walk.
 *
 * `previousChecksum === null` is the genesis row (first audit ever, or
 * first audit after the C3 migration in pre-chain DBs). It still binds
 * the per-row fields but has no link.
 *
 * Compatible with the legacy single-row `computeChecksum(data)` — pass
 * the same per-row fields, plus `previousChecksum` for chain rows.
 *
 * NOTE: This function uses the V1 canonical form (top-level key sort only) and
 * is VERIFY-ONLY — the fallback for rows written before 2026-05-29. New writes
 * use `computeChainedChecksumV2` / `computeChainedChecksumV3` (see audit.ts).
 */
export function computeChainedChecksum(
  data: Record<string, unknown>,
  previousChecksum: string | null,
): string {
  return computeChecksum({ ...data, previousChecksum });
}

// ---------------------------------------------------------------------------
// V2 canonicalization — recursive key sort (audit finding V-1, 2026-05-29)
// ---------------------------------------------------------------------------
//
// COMPATIBILITY NOTE (V-1 fix, Option A — versioning approach):
//
// PostgreSQL JSONB normalises nested object key order on storage. When the
// verifier reads back an audit row, nested `afterValue` keys may arrive in a
// different order from what was JSON.stringify'd at write time. The V1
// computeChecksum only sorts TOP-LEVEL keys; nested key order is left to
// JSON.stringify, which preserves insertion order. This means per-row
// verification always fails for any row where `afterValue` (or any other
// nested object field) was stored by PostgreSQL in a different key order than
// the write-time in-memory object.
//
// WHAT WAS DONE (2026-05-29, and corrected in this comment 2026-10-03, DATA-14):
// the WRITE PATH MOVED TO V2 — `audit.ts` calls `computeChainedChecksumV2` (or
// the keyed V3 since 2026-07-25). Chain continuity across the cutover is not
// affected, because `previous_checksum` stores the predecessor's STORED
// checksum verbatim, whichever formula produced it; only the per-row formula
// changed. Historical V1 rows were never rewritten.
//
// The VERIFIER therefore accepts BOTH per-row formulas:
//   1. V2 (recursive sort) — what every row since the cutover was written with,
//      and the correct form for detecting real tampering.
//   2. V1 (top-level sort) — the fallback for rows written before the cutover,
//      which verify wherever JSONB returned nested keys in the write-time
//      order (in practice all of them — brute-force permutation in the bug
//      report confirmed the stored hashes are self-consistent).
//
// Limitation accepted: a pre-cutover row where JSONB key order happened to
// differ AND V2 also doesn't match will still show as a false-positive
// mismatch. No such row has been observed.
//
// An earlier version of this note said the write path had deliberately NOT
// been changed and that V1 remained the write formula. That was stale; the
// three comments that repeated it were rewritten together.
// ---------------------------------------------------------------------------

/**
 * Recursively canonicalize any JSON-serialisable value.
 * Object keys are sorted at every nesting depth; arrays preserve element order.
 * Undefined / function / symbol values emit "null" (mirrors JSON.stringify).
 *
 * Exported (audit 2026-10-03, DATA-7) so the report-review snapshot digest
 * uses the SAME canonical form as the audit checksum — one definition of
 * "the bytes of this JSON", or a digest computed at the request could fail to
 * match the same document read back from JSONB.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  // undefined / function / symbol — emit null to mirror JSON.stringify's behavior
  return 'null';
}

/**
 * V2 checksum: recursively sorts all nested object keys before hashing.
 * Matches what PostgreSQL JSONB returns on read-back, eliminating false-positive
 * "tampering" alerts caused by JSONB key-order normalisation (audit finding V-1).
 *
 * Used in the verify path as the primary attempt (V1 is the fallback for old
 * rows), and the formula `audit.ts` WRITES unkeyed rows with (keyed rows use
 * V3, which HMACs this same canonical form).
 */
export function computeChecksumV2(data: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalize(data)).digest('hex');
}

/**
 * V2 chained checksum: like computeChainedChecksum but uses recursive canonicalization.
 *
 * THE unkeyed write formula: `audit.ts` has called this for every new row
 * since 2026-05-29 (V3 when a chain key is configured). Rows written with it
 * verify correctly even after JSONB normalises nested key order on read-back,
 * because the verifier tries V2 first; rows older than the cutover verify via
 * the V1 fallback. Chain link verification is unaffected by the cutover
 * (previous_checksum stores the predecessor's raw stored checksum, not a
 * recomputed hash).
 */
export function computeChainedChecksumV2(
  data: Record<string, unknown>,
  previousChecksum: string | null,
): string {
  return computeChecksumV2({ ...data, previousChecksum });
}

/**
 * Recompute checksum from a stored audit record's fields.
 * Used to verify integrity on read.
 *
 * For chain rows (previousChecksum != null), the chain link is included
 * in the verification. For pre-chain rows, behavior is identical to the
 * pre-C3 implementation.
 *
 * V-1 fix (2026-05-29): tries V2 (recursive canonical form) first, then falls
 * back to V1 (top-level sort) for historical rows. This eliminates false-positive
 * "tampering" alerts caused by PostgreSQL JSONB normalising nested key order on
 * storage.
 *
 * V-2 fix (2026-05-29): for genesis rows (previousChecksum === null), the
 * verifier now calls computeChainedChecksum(baseFields, null) — matching the
 * writer — rather than computeChecksum(baseFields) which omits the
 * previousChecksum key. Pre-chain rows (written before the C3 migration) had
 * previousChecksum set to undefined in the DB; they arrive here with
 * previousChecksum == null AND their stored checksum was computed by the
 * old computeChecksum path, so the V1 fallback handles them correctly.
 */
export function verifyAuditChecksum(record: {
  timestamp: Date | string;
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
  signatureMeaning?: string | null;
  checksum: string;
  previousChecksum?: string | null;
  redactedAt?: Date | string | null;
  checksumVersion?: number | null;
}): boolean {
  // Audit 2026-05-20 §C1 fix: redacted rows preserve the original checksum +
  // chain link, but beforeValue + afterValue are NULLed. Recomputing would now
  // fail because the payload no longer matches the original, so a redacted row
  // can't be checksum-verified the normal way.
  //
  // 2026-07-15: this used to `return true` unconditionally, and the reasoning
  // for that was WRONG. It claimed a payload mutation "would still surface via
  // chain mismatch on the NEXT row (its previous_checksum points at this row's
  // stored checksum)" — but the next row's link points at this row's STORED
  // checksum, which an attacker simply doesn't touch. Rewrite before_value /
  // after_value, leave the checksum alone, and every link still matches: the
  // row verifies, the chain verifies, and the API serves the forgery. That is
  // precisely the DB-level actor this file names as its threat model below, and
  // it fires ahead of the V3 HMAC path too, so even a keyed chain didn't help.
  //
  // We can't re-derive the original payload, but we CAN assert the one thing
  // redaction guarantees: both payloads are NULL. A redacted row whose payload
  // came back is tampered with, whatever its checksum says.
  if (record.redactedAt != null) {
    return record.beforeValue == null && record.afterValue == null;
  }
  const ts = record.timestamp instanceof Date ? record.timestamp.toISOString() : record.timestamp;

  // EXPANDED field set (audit finding, 2026-07-04): the per-row checksum now
  // covers EVERY persisted audit column — beforeValue / reason / signatureMeaning
  // (§11.50) / userRole / userName / ipAddress / userAgent / sessionId — not just
  // {timestamp, userId, action, target*, afterValue}. Those columns were outside
  // the tamper-evidence envelope, so a DB-level actor (the exact threat the chain
  // defends against — triggers can be disabled) could rewrite them and verify-chain
  // still passed. New rows are WRITTEN over this set (audit.ts).
  const expandedFields: Record<string, unknown> = {
    timestamp: ts,
    userId: record.userId ?? undefined,
    userName: record.userName ?? undefined,
    userRole: record.userRole ?? undefined,
    action: record.action,
    targetType: record.targetType ?? undefined,
    targetId: record.targetId ?? undefined,
    beforeValue: record.beforeValue ?? undefined,
    afterValue: record.afterValue ?? undefined,
    reason: record.reason ?? undefined,
    ipAddress: record.ipAddress ?? undefined,
    userAgent: record.userAgent ?? undefined,
    sessionId: record.sessionId ?? undefined,
    signatureMeaning: record.signatureMeaning ?? undefined,
  };
  // REDUCED field set — the original formula. Every row written before the
  // field-coverage expansion verifies via this set (accepted limitation: the extra
  // columns aren't tamper-covered for those historical rows — same versioning
  // philosophy as V1/V2 above, and NO rewrite of immutable historical rows).
  const reducedFields: Record<string, unknown> = {
    timestamp: ts,
    userId: record.userId ?? undefined,
    action: record.action,
    targetType: record.targetType ?? undefined,
    targetId: record.targetId ?? undefined,
    afterValue: record.afterValue ?? undefined,
  };

  // V3 (keyed) rows: REQUIRE the key + an HMAC match. Do NOT fall back to the
  // unkeyed V1/V2 formulas — accepting them would let a DB actor downgrade a
  // row to unkeyed and still pass, defeating the point of the key. A missing
  // key makes v3 rows unverifiable (fail loud) rather than silently "valid".
  if (record.checksumVersion === 3) {
    const key = getAuditChainKey();
    if (!key) return false;
    return matchesStoredChecksumV3(expandedFields, record.checksum, record.previousChecksum, key)
        || matchesStoredChecksumV3(reducedFields, record.checksum, record.previousChecksum, key);
  }

  return matchesStoredChecksum(expandedFields, record.checksum, record.previousChecksum)
      || matchesStoredChecksum(reducedFields, record.checksum, record.previousChecksum);
}

/** V3 keyed variant of matchesStoredChecksum (chain row, then genesis). */
function matchesStoredChecksumV3(
  fields: Record<string, unknown>,
  checksum: string,
  previousChecksum: string | null | undefined,
  key: string,
): boolean {
  if (previousChecksum != null) {
    return computeChainedChecksumV3(fields, previousChecksum, key) === checksum;
  }
  return computeChainedChecksumV3(fields, null, key) === checksum
      || computeChecksumV3(fields, key) === checksum;
}

/**
 * Does `fields` hash (under any of the accepted formulas) to `checksum`?
 * Chain rows: V2-chained then V1-chained. Genesis/pre-chain rows: V2/V1-chained
 * (previousChecksum key = null) then V2/V1 legacy (no previousChecksum key).
 */
function matchesStoredChecksum(
  fields: Record<string, unknown>,
  checksum: string,
  previousChecksum?: string | null,
): boolean {
  if (previousChecksum != null) {
    return computeChainedChecksumV2(fields, previousChecksum) === checksum
        || computeChainedChecksum(fields, previousChecksum) === checksum;
  }
  return computeChainedChecksumV2(fields, null) === checksum
      || computeChainedChecksum(fields, null) === checksum
      || computeChecksumV2(fields) === checksum
      || computeChecksum(fields) === checksum;
}
