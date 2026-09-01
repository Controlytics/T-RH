-- Sensor RANGE failures: a reading outside what the probe can physically measure
-- (`High/Low Temperature Range`, `High/Low Humidity Range` attributes), as
-- distinct from a LIMIT breach, which is a product excursion.
--
-- HAND-AUTHORED. `prisma migrate diff` also emitted
--   DROP TABLE "instrument_telemetry_history";
-- which is STRIPPED, as it has been from every migration authored in this repo
-- since 2026-08-08. That table is PARTITIONED and therefore invisible to the
-- datamodel; dropping it destroys the telemetry record. `migration-guard.ts`
-- fails the build if a committed migration ever carries it.

-- A new VALUE on an existing enum. No new enum, no new model.
ALTER TYPE "AlarmSource" ADD VALUE IF NOT EXISTS 'SENSOR_RANGE';
