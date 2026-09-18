-- scripts/aws/rds-repair-orphaned-data-injection.sql
--
-- WHY THIS EXISTS (2026-09-18). The AWS database (RDS `compliance-core-db`) was
-- last migrated on 2026-08-01 from branch `final-user-management` at f05cbd3.
-- That deploy applied two migrations from the Data Injection programme:
--     20260801120000_data_injection_p1
--     20260801130000_data_injection_p1_indexes
-- The programme was REMOVED from the repo on 2026-08-04 (folder rolled back to
-- 9a6350f; the work survives only on tag `pre-data-injection-drop`), and those
-- two migration files no longer exist on any live branch. The next migration
-- in `data-layer`, 20260804120000_instruments_p1, does `CREATE TABLE
-- "instruments"` — which fails while the orphaned table of the same name is
-- still there. So the orphan has to go before `prisma migrate deploy` can run.
--
-- RECEIPT, measured over SSM from the Windows instance before this was written:
--     hierarchy_nodes        1 row   (the seeded root)
--     protocols             18 rows  (seeded protocol catalogue)
--     communication_profiles 0
--     gateways               0
--     instruments            0
--     instrument_settings    0
--     instrument_topics      0
--   Foreign keys: only AMONG these seven tables. None references users, roles,
--   audit_trail or any other table. Both migrations mention audit_trail ONLY in
--   comments; nothing here touches it (42 rows, checksum_version 3, keyed from
--   row 0). RDS snapshot `compliance-core-db-pre-ubuntu-20260918` was taken
--   first.
--
-- Runs inside ONE transaction via scripts/aws/run-sql.cjs. Every statement is
-- IF EXISTS so a re-run is a no-op.

DROP TABLE IF EXISTS "instrument_topics"       CASCADE;
DROP TABLE IF EXISTS "instrument_settings"     CASCADE;
DROP TABLE IF EXISTS "instruments"             CASCADE;
DROP TABLE IF EXISTS "gateways"                CASCADE;
DROP TABLE IF EXISTS "communication_profiles"  CASCADE;
DROP TABLE IF EXISTS "protocols"               CASCADE;
DROP TABLE IF EXISTS "hierarchy_nodes"         CASCADE;
DROP TYPE  IF EXISTS "HierarchyLevel";
DROP TYPE  IF EXISTS "TopicCategory";

DELETE FROM "_prisma_migrations"
 WHERE migration_name IN ('20260801120000_data_injection_p1',
                          '20260801130000_data_injection_p1_indexes');

-- Sanity: the baseline must still be the one applied migration left.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM "_prisma_migrations";
  IF n <> 1 THEN RAISE EXCEPTION 'expected exactly 1 migration row (baseline) after repair, found %', n; END IF;
  SELECT count(*) INTO n FROM "audit_trail";
  IF n < 42 THEN RAISE EXCEPTION 'audit_trail lost rows (% < 42) — refusing to commit', n; END IF;
END $$;
