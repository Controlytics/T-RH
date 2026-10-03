-- audit_trail.user_role was VARCHAR(20) while roles.name (and users.role) are
-- VARCHAR(50) and the role zod allows 50 (audit 2026-10-03, DATA-3). The audit
-- insert is RAW SQL with no clamp, so every audited action by a user in a
-- role named longer than 20 characters — LOGIN_SUCCESS included — failed with
-- 22001: such a user could not log in. Widen to match the source columns.
-- Widening a varchar is a catalog-only change in Postgres; no row is rewritten.
ALTER TABLE "audit_trail" ALTER COLUMN "user_role" TYPE VARCHAR(50);
