-- Sensor offsets (2026-10-01): `instrument_telemetry_history.raw_value`.
--
-- An instrument's Temp / Humid Off set is applied to a reading AS IT ARRIVES,
-- so `value` holds the CORRECTED reading — what every screen, report and alarm
-- uses (operator's choice: applied at ingest, history stays as it was shown).
-- `raw_value` keeps what the device actually sent, for the record; it is NULL
-- when no offset applied, and it is never shown (operator: "no original value").
--
-- The table is PARTITIONED and invisible to the Prisma datamodel; ADD COLUMN on
-- the parent propagates to every existing partition and to every partition
-- created later. Nullable, no default: no rewrite of existing rows.
-- HAND-AUTHORED; never let `prisma migrate diff` near this table.

ALTER TABLE "instrument_telemetry_history" ADD COLUMN "raw_value" JSONB;
