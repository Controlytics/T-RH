-- Instrument visibility scope, per role and per user.
--
-- HAND-AUTHORED. The three statements `prisma migrate diff` emits in this repo are
-- deliberately absent — see the header of
-- 20260811120000_instrument_floorplans/migration.sql for the full reasons:
--   1. DROP TABLE instrument_telemetry_history  (partitioned; holds every reading)
--   2. ALTER audit_trail.chain_position DROP NOT NULL  (21 CFR hash-chain position)
--   3. unchanged instrument_credentials FK churn
--
-- NULLABLE WITH NO DEFAULT, on purpose. Three states must be distinguishable:
--
--   NULL   inherit (user -> role -> unrestricted)
--   '[]'   SEE NOTHING — a real instruction someone may have meant
--   '[..]' see these functional locations
--
-- A DEFAULT of '[]' would silently blind every existing role and user the moment
-- this migration ran. NULL means nothing changes until an administrator sets a scope.

ALTER TABLE "role_configs" ADD COLUMN "instrument_scope" JSONB;
ALTER TABLE "user_configs" ADD COLUMN "instrument_scope" JSONB;
