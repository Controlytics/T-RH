-- Alarm subsystem: configurable rules over instrument telemetry, and the alarms they
-- raise.
--
-- HAND-AUTHORED. The three statements `prisma migrate diff` emits in this repo are
-- deliberately absent — see 20260811120000_instrument_floorplans/migration.sql:
--   1. DROP TABLE instrument_telemetry_history  (partitioned; holds every reading)
--   2. ALTER audit_trail.chain_position DROP NOT NULL  (21 CFR hash-chain position)
--   3. unchanged instrument_credentials FK churn
--
-- TWO DELIBERATE ASYMMETRIES IN THE FOREIGN KEYS:
--
--   alarm_rules -> instruments / functional_locations : CASCADE
--     A rule targeting a deleted instrument or location is meaningless, so it goes with
--     it. Its historical alarms survive, because each alarm carries a snapshot of the
--     rule rather than depending on the row.
--
--   alarms -> alarm_rules / instruments : RESTRICT
--     An alarm is a REGULATED RECORD. Deleting an instrument or a rule must not erase
--     the history of what it did. Deleting a rule that has alarms is refused by the API
--     with a 409 naming the count, so the operator gets something actionable rather
--     than a constraint error.
--
-- There is deliberately no UPDATE path on alarms beyond cleared_at and the three
-- acknowledgement columns, and no DELETE path at all.

CREATE TYPE "AlarmMetric" AS ENUM ('TEMPERATURE', 'HUMIDITY', 'OFFLINE');
CREATE TYPE "AlarmComparison" AS ENUM ('ABOVE', 'BELOW', 'OUTSIDE_RANGE');
CREATE TYPE "AlarmSeverity" AS ENUM ('CRITICAL', 'MAJOR', 'MINOR');
CREATE TYPE "AlarmState" AS ENUM ('ACTIVE', 'CLEARED');

CREATE TABLE "alarm_rules" (
    "id"                     TEXT NOT NULL,
    "name"                   TEXT NOT NULL,
    "instrument_id"          TEXT,
    "functional_location_id" TEXT,
    "metric"                 "AlarmMetric" NOT NULL,
    "comparison"             "AlarmComparison" NOT NULL,
    "threshold_low"          DOUBLE PRECISION,
    "threshold_high"         DOUBLE PRECISION,
    "delay_seconds"          INTEGER NOT NULL DEFAULT 0,
    "severity"               "AlarmSeverity" NOT NULL DEFAULT 'MAJOR',
    "is_active"              BOOLEAN NOT NULL DEFAULT true,
    "created_at"             TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"             TIMESTAMPTZ(3) NOT NULL,
    "created_by"             TEXT,
    "updated_by"             TEXT,

    CONSTRAINT "alarm_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "alarm_rules_is_active_idx" ON "alarm_rules"("is_active");
CREATE INDEX "alarm_rules_instrument_id_idx" ON "alarm_rules"("instrument_id");
CREATE INDEX "alarm_rules_functional_location_id_idx" ON "alarm_rules"("functional_location_id");

ALTER TABLE "alarm_rules"
    ADD CONSTRAINT "alarm_rules_instrument_id_fkey"
    FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "alarm_rules"
    ADD CONSTRAINT "alarm_rules_functional_location_id_fkey"
    FOREIGN KEY ("functional_location_id") REFERENCES "functional_locations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "alarms" (
    "id"                 TEXT NOT NULL,
    "rule_id"            TEXT NOT NULL,
    "rule_snapshot"      JSONB NOT NULL,
    "instrument_id"      TEXT NOT NULL,
    "metric"             "AlarmMetric" NOT NULL,
    "triggered_value"    DOUBLE PRECISION,
    "severity"           "AlarmSeverity" NOT NULL,
    "state"              "AlarmState" NOT NULL DEFAULT 'ACTIVE',
    "raised_at"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cleared_at"         TIMESTAMPTZ(3),
    "acknowledged_at"    TIMESTAMPTZ(3),
    "acknowledged_by"    TEXT,
    "acknowledge_reason" TEXT,

    CONSTRAINT "alarms_pkey" PRIMARY KEY ("id")
);

-- The active-list query and the dashboard summary count both read (state, raised_at).
CREATE INDEX "alarms_state_raised_at_idx" ON "alarms"("state", "raised_at" DESC);
CREATE INDEX "alarms_instrument_id_raised_at_idx" ON "alarms"("instrument_id", "raised_at" DESC);
CREATE INDEX "alarms_acknowledged_at_idx" ON "alarms"("acknowledged_at");

ALTER TABLE "alarms"
    ADD CONSTRAINT "alarms_rule_id_fkey"
    FOREIGN KEY ("rule_id") REFERENCES "alarm_rules"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "alarms"
    ADD CONSTRAINT "alarms_instrument_id_fkey"
    FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
