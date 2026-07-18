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

\echo 'Invariants applied: audit_trail_no_delete'
