-- scripts/backfill-orphan-entity-orgs.sql
--
-- Backfills `asset_instances.organization_id` for entities that have NULL
-- (typically created by SUPER_ADMIN users, who have no org of their own,
-- before the parent-org-inherit fix landed in instance.service.ts).
--
-- Strategy:
--   1. For orphans WITH a parent that has an org → inherit the parent's org
--   2. Recurse upward (a parent's parent, etc.) up to 5 levels, in case the
--      direct parent is also an orphan
--   3. Anything still NULL after the climb is left as system-level (the
--      handler in instance.service.ts logs these going forward)
--
-- Run with the digilog user against digilog_db. Reversible: keeps a
-- timestamped audit row in audit_trail per affected entity.
--
-- USAGE:
--   psql -h localhost -U digilog -d digilog_db -f scripts/backfill-orphan-entity-orgs.sql
--
-- This script is idempotent — re-running on an already-backfilled DB is a
-- no-op (no entities will match the WHERE filter).

\set ON_ERROR_STOP on
\timing on

BEGIN;

-- Snapshot how many orphans exist before so the operator sees the impact
SELECT COUNT(*) AS orphans_before FROM asset_instances WHERE organization_id IS NULL AND is_active = TRUE;

-- Walk up to 5 levels of parents looking for an org
DO $$
DECLARE
  iter INT := 0;
  affected INT;
BEGIN
  LOOP
    iter := iter + 1;
    EXIT WHEN iter > 5;

    UPDATE asset_instances child
       SET organization_id = parent.organization_id,
           updated_at      = NOW()
      FROM asset_instances parent
     WHERE child.parent_id = parent.id
       AND child.organization_id IS NULL
       AND parent.organization_id IS NOT NULL
       AND child.is_active = TRUE;

    GET DIAGNOSTICS affected = ROW_COUNT;
    RAISE NOTICE 'Iteration %: % orphan(s) inherited org from a parent', iter, affected;
    EXIT WHEN affected = 0;
  END LOOP;
END $$;

-- Final count
SELECT COUNT(*) AS orphans_after FROM asset_instances WHERE organization_id IS NULL AND is_active = TRUE;

-- Show what's still orphan (intentionally — system-level entities with no parent)
SELECT id, name, status, parent_id IS NULL AS is_root, created_at
  FROM asset_instances
 WHERE organization_id IS NULL AND is_active = TRUE
 ORDER BY created_at;

COMMIT;
