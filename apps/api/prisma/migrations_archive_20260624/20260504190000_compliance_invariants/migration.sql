-- Audit 2026-05-04 fix data-layer C2: compliance invariants live in migrations.
--
-- These three invariants were previously installed ONLY by seed.ts (which
-- read prisma/sql/invariants.sql at seed-time). A `prisma migrate deploy`-only
-- production cutover therefore shipped WITHOUT:
--   1. one-IN_PROGRESS-per-filter unique index — corruption protection
--      against buggy services or manual DB edits
--   2. filter_event ↔ cycle.filter_id consistency trigger — prevents
--      cross-filter event leakage after the FilterDetails split (Step 6)
--   3. asset_relationship bidirectional-pair constraint trigger —
--      enforces inverse-pair invariant for graph navigation
--
-- Idempotent — every statement uses IF NOT EXISTS / OR REPLACE so this
-- migration is safe to re-run if a prior install already applied them via
-- the seed path.
--
-- The seed.ts applyInvariants() call stays in place as defense-in-depth
-- (e.g., dev `prisma db push` workflows that skip migrations); operators
-- should rely on this migration as the authoritative installer.

-- ─── Invariant 1: at most ONE IN_PROGRESS cycle per filter ─────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_cleaning_cycles_one_in_progress_per_filter
  ON cleaning_cycles (filter_id)
  WHERE status = 'IN_PROGRESS';

-- ─── Invariant 2: FilterEvent.filter_id must match its cycle's filter_id ───
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

-- ─── Invariant 3: AssetRelationship bidirectional pair must exist ──────────
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
-- Audit C3 follow-up — referenced by tests + admin delete-audit endpoint
-- (audit/routes.ts disables before bulk delete + re-enables after). Was
-- previously installed only via seed.ts.
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
