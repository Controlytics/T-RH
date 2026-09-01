-- Alarm RULES removed (operator, 2026-08-31).
--
-- Every alarm in this product now derives from the instrument itself — its
-- limits, its sensor range, a non-numeric reading, or silence. Nobody authored
-- rules, and the database confirmed it before this ran:
--   SELECT count(*) FROM alarm_rules;                    -- 0
--   SELECT count(*) FROM alarms WHERE source = 'RULE';   -- 0
-- So no regulated record is deleted or closed by this migration. Had either
-- count been non-zero, the model would have stayed and only the authoring
-- surface would have gone — an alarm is a §11 record and is never dropped to
-- tidy a schema.
--
-- HAND-AUTHORED. `prisma migrate diff` also emitted
--   DROP TABLE "instrument_telemetry_history";
-- which is STRIPPED, as it has been from every migration authored here since
-- 2026-08-08 — that table is PARTITIONED and invisible to the datamodel, and
-- `migration-guard.ts` fails the build if a committed migration carries it.
--
-- `AlarmSource.RULE` is deliberately LEFT IN the enum: Postgres cannot drop a
-- value from an enum type without recreating it, and recreating a type the
-- `alarms` table depends on is not worth doing for a value nothing writes.

-- The FK first, then the column it hangs off.
ALTER TABLE "alarms" DROP CONSTRAINT IF EXISTS "alarms_rule_id_fkey";
DROP INDEX IF EXISTS "alarms_rule_id_idx";
ALTER TABLE "alarms" DROP COLUMN IF EXISTS "rule_id";

DROP TABLE IF EXISTS "alarm_rules";

-- Only AlarmRule used it.
DROP TYPE IF EXISTS "AlarmComparison";
