-- Instrument auto-fetch revision (2026-06-13): one reading endpoint per group +
-- a response key per instrument (replaces the per-instrument url from
-- 20260613120000). Pre-ship, no production data depends on the dropped column.
ALTER TABLE "equipment_groups"
    ADD COLUMN "reading_url" VARCHAR(2048);
ALTER TABLE "equipment_group_instruments"
    ADD COLUMN "response_key" VARCHAR(100);
ALTER TABLE "equipment_group_instruments"
    DROP COLUMN IF EXISTS "url";
