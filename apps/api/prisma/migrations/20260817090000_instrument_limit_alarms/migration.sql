-- Instrument-limit alarms.
--
-- Alarms raised from an instrument's own High/Low Temperature and Humidity Limit
-- attributes have NO rule row, so `rule_id` becomes nullable and a `source`
-- discriminator says which kind a row is. `cleared_value` records the reading that
-- brought the condition back in spec — nothing captured that before.
--
-- SAFE AT THIS MOMENT: `alarms` holds 0 rows and `alarm_rules` 0 rows (verified
-- 2026-08-17). Dropping NOT NULL is widening and would be safe regardless; the
-- backfill below is therefore a no-op but is written so the migration is correct
-- against a populated database too.
--
-- HAND-AUTHORED. `prisma migrate diff` emits three further statements, ALL
-- deliberately omitted — the same three it has emitted since 20260811120000:
--
--   DROP TABLE "instrument_telemetry_history"
--     — partitioned, invisible to the datamodel, holds live telemetry.
--   ALTER TABLE "audit_trail" ALTER COLUMN "chain_position" DROP NOT NULL
--     — the 21 CFR §11 hash-chain position, sequence-backed outside Prisma.
--   DROP/ADD CONSTRAINT "instrument_credentials_instrument_id_fkey"
--     — unchanged; a drop-and-recreate of an identical FK.
--
-- Read the header of 20260811120000_instrument_floorplans before regenerating.

CREATE TYPE "AlarmSource" AS ENUM ('RULE', 'INSTRUMENT_LIMIT');
CREATE TYPE "AlarmLimitKind" AS ENUM ('HIGH', 'LOW');

ALTER TABLE "alarms" ALTER COLUMN "rule_id" DROP NOT NULL;

ALTER TABLE "alarms" ADD COLUMN "source" "AlarmSource" NOT NULL DEFAULT 'RULE';
ALTER TABLE "alarms" ADD COLUMN "limit_kind" "AlarmLimitKind";
ALTER TABLE "alarms" ADD COLUMN "cleared_value" DOUBLE PRECISION;

-- Every pre-existing alarm came from a rule. Explicit rather than relying on the
-- column default, so the intent survives a future default change.
UPDATE "alarms" SET "source" = 'RULE' WHERE "rule_id" IS NOT NULL;

CREATE INDEX "alarms_source_instrument_id_metric_limit_kind_state_idx"
  ON "alarms" ("source", "instrument_id", "metric", "limit_kind", "state");
