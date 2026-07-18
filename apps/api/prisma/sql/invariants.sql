-- Phase 5b.5: DB-side invariants that Prisma cannot express
--
-- Audit 2026-05-04 fix data-layer C2: these invariants are now ALSO installed
-- by the dedicated migration `20260504190000_compliance_invariants`. This
-- file remains as defense-in-depth for `prisma db push` workflows that bypass
-- migrations (typically dev). Operators should rely on the migration as the
-- authoritative installer.
--
-- Apply after every `prisma db push`. Idempotent — safe to re-run.
-- Run via:  psql -h localhost -U digilog -d digilog_db -f apps/api/prisma/sql/invariants.sql

-- ─── Invariant 1: at most ONE IN_PROGRESS cycle per filter ─────────────────
-- The transactional re-check in startCycle is belt; this partial unique index
-- is suspenders. Prevents data corruption from buggy services or manual DB edits.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cleaning_cycles_one_in_progress_per_filter
  ON cleaning_cycles (filter_id)
  WHERE status = 'IN_PROGRESS';

-- ─── Invariant 2: FilterEvent.filterId must match its cycle's filterId ─────
-- Step 6 split filter cycle state off AssetInstance into FilterDetails. This
-- trigger ensures that FilterEvent rows with cycleId set always reference an
-- event for the SAME filter that owns the cycle — no cross-filter event leakage.
CREATE OR REPLACE FUNCTION check_filter_event_consistency() RETURNS TRIGGER AS $$
DECLARE
  cycle_filter_id UUID;
BEGIN
  IF NEW.cycle_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT filter_id INTO cycle_filter_id FROM cleaning_cycles WHERE id = NEW.cycle_id;
  IF cycle_filter_id IS NULL THEN
    RAISE EXCEPTION 'FilterEvent references non-existent cycle %', NEW.cycle_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF cycle_filter_id <> NEW.filter_id THEN
    RAISE EXCEPTION 'FilterEvent.filter_id (%) does not match cycle.filter_id (%) for cycle %',
      NEW.filter_id, cycle_filter_id, NEW.cycle_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_filter_event_consistency ON filter_events;
CREATE TRIGGER trg_filter_event_consistency
  BEFORE INSERT OR UPDATE OF cycle_id, filter_id ON filter_events
  FOR EACH ROW EXECUTE FUNCTION check_filter_event_consistency();

-- ─── Invariant 3: AssetRelationship bidirectional pair must exist (Step 2) ──
-- Every (source, target, type) row implies a (target, source, INVERSE(type)) row
-- must also exist. Enforced as a deferred constraint trigger so create-pair
-- transactions can insert both rows without ordering games.
CREATE OR REPLACE FUNCTION inverse_relationship_type(rt relationship_type_enum)
RETURNS relationship_type_enum AS $$
BEGIN
  RETURN CASE rt
    WHEN 'CONTAINS' THEN 'CONTAINED_IN'
    WHEN 'CONTAINED_IN' THEN 'CONTAINS'
    WHEN 'CONNECTED_TO' THEN 'CONNECTED_TO'
    WHEN 'FEEDS' THEN 'FED_BY'
    WHEN 'FED_BY' THEN 'FEEDS'
    WHEN 'DEPENDS_ON' THEN 'DEPENDED_ON_BY'
    WHEN 'DEPENDED_ON_BY' THEN 'DEPENDS_ON'
    WHEN 'BACKS_UP' THEN 'BACKED_UP_BY'
    WHEN 'BACKED_UP_BY' THEN 'BACKS_UP'
    WHEN 'MONITORS' THEN 'MONITORED_BY'
    WHEN 'MONITORED_BY' THEN 'MONITORS'
    WHEN 'CUSTOM' THEN 'CUSTOM'
  END::relationship_type_enum;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION check_asset_relationship_pair() RETURNS TRIGGER AS $$
DECLARE
  inv_type relationship_type_enum;
  pair_exists BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    inv_type := inverse_relationship_type(NEW.relationship_type);
    SELECT EXISTS (
      SELECT 1 FROM asset_relationships
      WHERE source_asset_id = NEW.target_asset_id
        AND target_asset_id = NEW.source_asset_id
        AND relationship_type = inv_type
    ) INTO pair_exists;
    IF NOT pair_exists THEN
      RAISE EXCEPTION 'AssetRelationship bidirectional pair invariant violated: (% -> % via %) requires inverse (% -> % via %)',
        NEW.source_asset_id, NEW.target_asset_id, NEW.relationship_type,
        NEW.target_asset_id, NEW.source_asset_id, inv_type
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    inv_type := inverse_relationship_type(OLD.relationship_type);
    -- Only complain if the inverse still exists. The pair-delete transaction
    -- removes both; the second delete sees no inverse and passes.
    SELECT EXISTS (
      SELECT 1 FROM asset_relationships
      WHERE source_asset_id = OLD.target_asset_id
        AND target_asset_id = OLD.source_asset_id
        AND relationship_type = inv_type
    ) INTO pair_exists;
    IF pair_exists THEN
      RAISE EXCEPTION 'Cannot delete AssetRelationship without its inverse pair: (% -> % via %) inverse (% -> % via %) still present',
        OLD.source_asset_id, OLD.target_asset_id, OLD.relationship_type,
        OLD.target_asset_id, OLD.source_asset_id, inv_type
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_asset_relationship_pair ON asset_relationships;
CREATE CONSTRAINT TRIGGER trg_asset_relationship_pair
  AFTER INSERT OR DELETE ON asset_relationships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_asset_relationship_pair();

-- ─── Invariant 4: audit_trail no-delete trigger ────────────────────────────
-- C3 follow-up — referenced by tests + admin delete-audit endpoint
-- (audit/routes.ts disables before bulk delete + re-enables after).
CREATE OR REPLACE FUNCTION block_audit_trail_delete() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_trail rows are immutable. Use the admin delete endpoint which temporarily disables this trigger under audit.'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_trail_no_delete ON audit_trail;
CREATE TRIGGER audit_trail_no_delete
  BEFORE DELETE ON audit_trail
  FOR EACH ROW EXECUTE FUNCTION block_audit_trail_delete();

-- Confirmation log (visible when run via psql)
\echo 'Invariants applied: idx_cleaning_cycles_one_in_progress_per_filter + trg_filter_event_consistency + trg_asset_relationship_pair + audit_trail_no_delete'
