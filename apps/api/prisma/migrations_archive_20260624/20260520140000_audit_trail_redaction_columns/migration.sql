-- Audit 2026-05-20 §C1 / May 16 §1.2 fix.
--
-- Adds REDACTION columns to audit_trail. The audit DELETE endpoints
-- (/audit/:id DELETE + /audit/bulk-delete POST) previously DISABLED
-- the audit_trail_no_delete trigger then physically removed rows,
-- leaving the chain permanently broken from the deletion point forward
-- (the row at min(chainPosition > deleted.position) still references
-- the deleted row's previous_checksum but the actual prior row is gone).
--
-- New model: REDACT preserves checksum + previous_checksum + chain_position
-- so the chain stays intact. beforeValue and afterValue are set to NULL.
-- verifyAuditChecksum() checks redactedAt != NULL and treats those rows
-- as "valid (redacted)" instead of recomputing the now-mismatched checksum.
--
-- The follow-up route changes (next commit) replace DELETE with REDACT
-- on /api/audit/:id and /api/audit/bulk-redact. The DB trigger and the
-- chain semantics enforce that DELETE remains unsafe — REDACT is now
-- the only Part 11-defensible erasure path.

ALTER TABLE audit_trail
  ADD COLUMN IF NOT EXISTS redacted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS redacted_by VARCHAR(100),
  ADD COLUMN IF NOT EXISTS redaction_reason TEXT;
