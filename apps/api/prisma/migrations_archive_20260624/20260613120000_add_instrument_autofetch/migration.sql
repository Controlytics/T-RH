-- Instrument auto-fetch (2026-06-13): per-instrument reading URL + toggle.
-- Backward-compatible: url nullable, auto_fetch_enabled defaults false (= manual).
ALTER TABLE "equipment_group_instruments"
    ADD COLUMN "url" VARCHAR(2048),
    ADD COLUMN "auto_fetch_enabled" BOOLEAN NOT NULL DEFAULT false;
