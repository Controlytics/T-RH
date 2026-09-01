-- RS485 sensor-failure alarms: raised when a sensor reports a non-numeric value
-- on a temperature or humidity slot key, cleared when it reports a number again.
--
-- HAND-AUTHORED. `prisma migrate diff` also emitted
--   DROP TABLE "instrument_telemetry_history";
-- which is STRIPPED, as it has been from every migration authored in this repo
-- since 2026-08-08. That table is PARTITIONED and therefore invisible to the
-- datamodel; dropping it destroys the telemetry record. `migration-guard.ts`
-- fails the build if a committed migration ever carries it.
--
-- Do NOT "fix" the drift by adding a Prisma model for that table: Prisma would
-- then emit a plain CREATE TABLE for a fresh environment, producing an
-- UNPARTITIONED table, and ingest dies at the first month boundary.

-- A new VALUE on an existing enum. No new enum, no new model.
ALTER TYPE "AlarmSource" ADD VALUE IF NOT EXISTS 'RS485_FAILURE';
