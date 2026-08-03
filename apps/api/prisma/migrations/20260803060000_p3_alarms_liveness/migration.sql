-- Data Injection P3 Task 4 — alarm thresholds, alarms, instrument liveness.
-- Purely additive: 4 new enum types, 3 new tables, 1 new nullable column on
-- "instruments". Nothing pre-existing is altered or dropped.
--
-- Hand-authored per apps/api/CLAUDE.md ("Database Migrations"): `prisma
-- migrate dev` / `db push` are FORBIDDEN against a populated 21 CFR §11 DB.
--
-- Generated with
--   npx prisma migrate diff --from-url <dev db> --to-schema-datamodel prisma/schema.prisma --script
-- (`--from-migrations` is not usable here: Prisma RESETS the shadow database
-- before replaying, which wipes the `ltree` extension the pg_dump baseline
-- depends on, so migration 20260801120000_data_injection_p1 fails with
-- `type "ltree" does not exist`. The drift guard, scripts/verify-migrations.ps1,
-- was run immediately before generating this diff and PASSED, proving the dev
-- DB used as the from-state is bit-for-bit the migrations state.)
--
-- THREE statements from the generated candidate were deliberately omitted as
-- known, pre-existing, out-of-band noise — all three are destructive and none
-- has anything to do with this change:
--   1. DROP INDEX "hierarchy_nodes_path_btree_idx";
--   2. DROP INDEX "hierarchy_nodes_path_gist_idx";
--      `hierarchy_nodes.path` is `Unsupported("ltree")?`; Prisma cannot express
--      a GiST/btree index over an Unsupported() column, so these read as
--      permanent diff noise. Documented in 20260801130000_data_injection_p1_indexes.
--   3. ALTER TABLE "audit_trail" ALTER COLUMN "chain_position" DROP NOT NULL;
--      chain_position is a manual BIGSERIAL backing the tamper-evident hash
--      chain. audit_trail is off-limits. Documented in the same P1 migration.

-- CreateEnum
CREATE TYPE "AlarmState" AS ENUM ('ACTIVE', 'ACTIVE_ACKED', 'RESOLVED_UNACKED', 'CLOSED');

-- CreateEnum
CREATE TYPE "AlarmSeverity" AS ENUM ('CRITICAL', 'MAJOR', 'MINOR', 'INFO');

-- CreateEnum
CREATE TYPE "ThresholdOperator" AS ENUM ('GT', 'GTE', 'LT', 'LTE', 'EQ', 'NEQ', 'OUT_OF_RANGE');

-- CreateEnum
CREATE TYPE "LivenessState" AS ENUM ('ONLINE', 'OFFLINE', 'UNKNOWN');

-- AlterTable
ALTER TABLE "instruments" ADD COLUMN     "expected_interval_sec" INTEGER;

-- CreateTable
CREATE TABLE "alarm_thresholds" (
    "id" TEXT NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "operator" "ThresholdOperator" NOT NULL,
    "limit" DOUBLE PRECISION,
    "limit_low" DOUBLE PRECISION,
    "limit_high" DOUBLE PRECISION,
    "hysteresis" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "severity" "AlarmSeverity" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "alarm_thresholds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alarms" (
    "id" TEXT NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "threshold_id" TEXT,
    "severity" "AlarmSeverity" NOT NULL,
    "state" "AlarmState" NOT NULL DEFAULT 'ACTIVE',
    "first_breach_at" TIMESTAMPTZ(3) NOT NULL,
    "last_breach_at" TIMESTAMPTZ(3) NOT NULL,
    "breach_count" INTEGER NOT NULL DEFAULT 1,
    "trigger_value" DOUBLE PRECISION,
    "peak_value" DOUBLE PRECISION,
    "resolved_at" TIMESTAMPTZ(3),
    "acked_by" TEXT,
    "acked_at" TIMESTAMPTZ(3),
    "ack_reason" TEXT,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alarms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instrument_liveness" (
    "instrument_id" TEXT NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3),
    "state" "LivenessState" NOT NULL DEFAULT 'UNKNOWN',
    "state_changed_at" TIMESTAMPTZ(3),
    "offline_alarm_id" TEXT,

    CONSTRAINT "instrument_liveness_pkey" PRIMARY KEY ("instrument_id")
);

-- CreateIndex
CREATE INDEX "alarm_thresholds_instrument_id_idx" ON "alarm_thresholds"("instrument_id");

-- CreateIndex
CREATE UNIQUE INDEX "alarm_thresholds_instrument_id_key_operator_key" ON "alarm_thresholds"("instrument_id", "key", "operator");

-- CreateIndex
CREATE INDEX "alarms_state_severity_idx" ON "alarms"("state", "severity");

-- CreateIndex
CREATE INDEX "alarms_instrument_id_key_idx" ON "alarms"("instrument_id", "key");

-- CreateIndex
CREATE INDEX "alarms_first_breach_at_idx" ON "alarms"("first_breach_at" DESC);

-- CreateIndex
CREATE INDEX "instrument_liveness_state_idx" ON "instrument_liveness"("state");

-- AddForeignKey
ALTER TABLE "alarm_thresholds" ADD CONSTRAINT "alarm_thresholds_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alarms" ADD CONSTRAINT "alarms_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alarms" ADD CONSTRAINT "alarms_threshold_id_fkey" FOREIGN KEY ("threshold_id") REFERENCES "alarm_thresholds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instrument_liveness" ADD CONSTRAINT "instrument_liveness_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instrument_liveness" ADD CONSTRAINT "instrument_liveness_offline_alarm_id_fkey" FOREIGN KEY ("offline_alarm_id") REFERENCES "alarms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- At most one OPEN alarm per (instrument, key, threshold), enforced in the
-- DATABASE and not only in evaluator logic — two concurrent flushes would
-- otherwise both INSERT and the re-trigger counter would silently become two
-- rows.
--
-- threshold_id is part of the key because one telemetry key can carry several
-- thresholds (a high limit and a low limit). Collapsing them into one series
-- makes a reading that breaches the high limit satisfy the low limit's recovery
-- test in the same pass, resolving the alarm it just raised.
CREATE UNIQUE INDEX alarms_one_open_per_threshold_key
  ON alarms (instrument_id, key, threshold_id)
  WHERE state <> 'CLOSED' AND threshold_id IS NOT NULL;

-- Liveness alarms carry threshold_id = NULL, and PostgreSQL treats NULLs as
-- DISTINCT in a unique index — so the index above gives them no guarantee at
-- all and a device could accumulate one offline alarm per sweep. This second
-- index covers exactly that case: at most one open liveness alarm per
-- instrument.
CREATE UNIQUE INDEX alarms_one_open_liveness_key
  ON alarms (instrument_id)
  WHERE state <> 'CLOSED' AND threshold_id IS NULL;
