-- audit_trail: refuse every UPDATE except a redaction (audit 2026-10-03, DATA-6).
--
-- Until now the only DB-side guard on audit_trail was the BEFORE DELETE trigger.
-- A DB-level actor could run
--   UPDATE audit_trail SET before_value = NULL, after_value = NULL, redacted_at = now() WHERE id = …
-- from any session: no meta-audit row, chain intact (the checksum is not
-- touched), and verifyAuditChecksum short-circuits a redacted row to "both
-- payloads NULL", so the forgery rendered as a legitimate redaction — even
-- under the keyed V3 chain, because the short-circuit fires before the HMAC.
--
-- This trigger permits ONE transition, the one the redact routes make
-- (apps/api/src/modules/audit/routes.ts, single and bulk):
--   redacted_at / redacted_by / redaction_reason go from NULL to a value, ONCE;
--   before_value and after_value are cleared;
--   every other column is byte-for-byte unchanged.
-- Everything else — rewriting a payload on a row that is not being redacted,
-- changing any other column alongside a redaction, un-redacting, re-redacting
-- with a different reason, touching the checksum or the chain — is refused.
--
-- The "every other column" comparison is made over to_jsonb(row) with the five
-- redaction columns removed, rather than by naming each column: a column added
-- to the table later is then guarded by default instead of silently exempt.
--
-- Same function in prisma/sql/invariants.sql (kept in step by hand, like the
-- delete trigger). The verifier cross-checks each redacted row against the
-- AUDIT_RECORD_REDACTED / AUDIT_RECORDS_BULK_REDACTED meta row that names it
-- (lib/audit-verify.ts), so a redaction with no record of who made it is an
-- anomaly even if the trigger was disabled for it.
CREATE OR REPLACE FUNCTION guard_audit_trail_update() RETURNS TRIGGER AS $$
DECLARE
  redaction_cols text[] := ARRAY['redacted_at', 'redacted_by', 'redaction_reason', 'before_value', 'after_value'];
BEGIN
  IF OLD.redacted_at IS NULL
     AND NEW.redacted_at IS NOT NULL
     AND NEW.redacted_by IS NOT NULL
     AND NEW.redaction_reason IS NOT NULL
     AND NEW.before_value IS NULL
     AND NEW.after_value IS NULL
     AND (to_jsonb(NEW) - redaction_cols) = (to_jsonb(OLD) - redaction_cols)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_trail rows are immutable. The only permitted UPDATE is a redaction: redacted_at, redacted_by and redaction_reason set once on an un-redacted row, before_value and after_value cleared, every other column unchanged.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_trail_no_update ON audit_trail;
CREATE TRIGGER audit_trail_no_update
  BEFORE UPDATE ON audit_trail
  FOR EACH ROW EXECUTE FUNCTION guard_audit_trail_update();
