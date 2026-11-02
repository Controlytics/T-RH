-- TCP/IP (MODBUS) READING STATUS (2026-10-31, Part 2): one row per instrument the
-- server's Reader has read — when it last tried, last succeeded, how many reads in a
-- row have failed and why. Operational state, not a §11 record: the record is the
-- SYSTEM audit row (MODBUS_DEVICE_NOT_ANSWERING / MODBUS_DEVICE_ANSWERING) written on
-- each healthy <-> failing transition, in the same transaction as the row change.
-- Spec: docs/superpowers/specs/2026-10-31-tcpip-instruments-design.md §5.3, §7.5
--
-- Hand-authored from `prisma migrate diff`; ONLY the new table and its FK are kept.
-- Stripped, as on every migration here: the DROP of the partitioned
-- instrument_telemetry_history (Prisma cannot see it), the audit_trail.chain_position
-- / audit_chain_counter noise, the instrument_credentials FK drop/re-add and the
-- notification_rule_recipients index drop.
--
-- `failure_run_started_at` is not in the spec's column list: it holds the time of the
-- FIRST failed read of the current run from the run's first miss, so the third miss can
-- set `failing_since` to it (a time held in memory would be wrong after a restart
-- mid-run). NULL once a read succeeds.
--
-- `instrument_id` is TEXT because instruments.id is TEXT. ON DELETE CASCADE: the row
-- is about the instrument and means nothing without it.

CREATE TABLE "modbus_poll_status" (
    "instrument_id" TEXT NOT NULL,
    "read_by" TEXT NOT NULL DEFAULT 'server',
    "last_attempt_at" TIMESTAMPTZ(3),
    "last_success_at" TIMESTAMPTZ(3),
    "failing_since" TIMESTAMPTZ(3),
    "failure_run_started_at" TIMESTAMPTZ(3),
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "last_error_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "modbus_poll_status_pkey" PRIMARY KEY ("instrument_id")
);

ALTER TABLE "modbus_poll_status" ADD CONSTRAINT "modbus_poll_status_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
