-- Drop two orphaned operational tables (both had 0 rows, no foreign keys).
--
-- qr_codes: the QR-code module (routes/generation) was deleted 2026-06-06, but
--   the QrCode model + table lingered. Nothing wrote to it; only a cascade
--   deleteMany on entity delete referenced it.
-- latest_telemetry: a "current value" cache populated by the telemetry ingestion
--   pipeline, which was torn out in Phase 7 (2026-06-11..2026-06-17). Nothing
--   populates it; the dashboards value_card/gauge/status_indicator widgets read
--   it and always got [] (now stubbed to [] like the timeseries_chart widget).
--
-- Hand-authored per the migration discipline (EXE-PACKAGING-PLAN.md section 2.1b;
-- apps/api/CLAUDE.md). IF EXISTS keeps it idempotent/replay-safe.

DROP TABLE IF EXISTS "qr_codes";
DROP TABLE IF EXISTS "latest_telemetry";
