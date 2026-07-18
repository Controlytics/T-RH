-- Drop two orphaned tables (both 0 rows, no foreign keys, no code references).
--
-- checklist_reviews: a 3-step Performed/Checked/Verified review workflow whose
--   checklist_id linked to the ts_checklist_responses TimescaleDB hypertable —
--   dropped entirely in Phase 7 (2026-06-11..2026-06-17). Nothing ever wrote to it.
-- electronic_signatures: a 21 CFR §11.50/§11.70 signature store keyed off Alarm.id
--   (Alarm removed 2026-05-17) or ChecklistReview.id. Never written; the live
--   e-signature surface uses report_signatures + the hash-chained audit_trail.
--
-- Both were introduced with the data-ingestion feature set (commit e8706bb) and
-- stranded by the Phase 6/7 tear-outs — same class as qr_codes/latest_telemetry
-- dropped 2026-07-01. Hand-authored per the migration discipline
-- (EXE-PACKAGING-PLAN.md section 2.1b; apps/api/CLAUDE.md). The out-of-band
-- deviation_number_seq default noise from `migrate diff` is intentionally omitted
-- (managed in prisma/sql/*). IF EXISTS keeps it idempotent/replay-safe.

DROP TABLE IF EXISTS "checklist_reviews";
DROP TABLE IF EXISTS "electronic_signatures";
