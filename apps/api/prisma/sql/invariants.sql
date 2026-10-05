-- DB-side invariants that Prisma cannot express.
--
-- 2026-07-18 (compliance-core domain strip): invariants 1–3 (cleaning-cycle
-- one-in-progress index, filter_event consistency trigger, asset_relationship
-- bidirectional-pair trigger) were removed with the cleanroom domain. Only the
-- audit_trail immutability trigger remains — it is the core 21 CFR §11.10(e)
-- tamper-evidence control.
--
-- Idempotent — safe to re-run.
-- Run via:  psql -h localhost -U digilog -d digilog_db -f apps/api/prisma/sql/invariants.sql

-- ─── audit_trail no-delete trigger ─────────────────────────────────────────
-- Physical DELETE of an audit row is blocked. The admin hard-delete endpoint
-- temporarily disables this trigger inside an audited transaction; the REDACT
-- path (chain-preserving) is the recommended way to neutralise a row.
CREATE OR REPLACE FUNCTION block_audit_trail_delete() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_trail rows are immutable. Use the admin delete endpoint which temporarily disables this trigger under audit.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_trail_no_delete ON audit_trail;
CREATE TRIGGER audit_trail_no_delete
  BEFORE DELETE ON audit_trail
  FOR EACH ROW EXECUTE FUNCTION block_audit_trail_delete();

-- ─── audit_trail no-update trigger (audit 2026-10-03, DATA-6) ──────────────
-- The only UPDATE an audit row may receive is a REDACTION, and only once:
-- redacted_at / redacted_by / redaction_reason NULL → value, before_value and
-- after_value cleared, every other column unchanged. Compared over to_jsonb(row)
-- minus the five redaction columns so a column added later is guarded by
-- default. Same function as migration 20261005120000_audit_trail_no_update;
-- keep the two in step by hand, like the delete trigger above.
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

\echo 'Invariants applied: audit_trail_no_delete, audit_trail_no_update'
