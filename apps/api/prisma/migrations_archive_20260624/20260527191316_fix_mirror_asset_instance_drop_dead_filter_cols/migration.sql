-- 2026-05-27 — M-04: stop fn_mirror_asset_instance() from writing the four
-- dead cycle columns into the `filters` sidecar table.
--
-- Context: commit 97d298c (2026-05-25) dropped four columns from `filters`:
--   - filter_profile_id
--   - current_lifecycle_state
--   - current_cycle_id
--   - filter_set
-- They were a duplicate of the same columns on `filter_details`, which
-- remains the authoritative home for cycle state.
--
-- The companion migration 20260525223000 dropped fn_mirror_filter_details()
-- (which only existed to feed those columns) and unblocked the cycle-write
-- path. But fn_mirror_asset_instance() — the Wave-1 trigger that mirrors
-- every asset_instances write into blocks/areas/ahus/filters by
-- template_kind — was NOT touched. Its FILTER branch still does:
--
--     INSERT INTO filters (... filter_profile_id, current_lifecycle_state,
--       current_cycle_id, filter_set ...)
--
-- Since the columns are gone, every asset_instances write whose template is
-- FILTER-kind now fails with:
--
--     column "filter_profile_id" of relation "filters" does not exist
--
-- That breaks filter create / rename / retire / replace and bulk-upload
-- (all of which write asset_instances and trip this AFTER trigger).
-- Confirmed live on 2026-05-27: the four columns are absent from `filters`
-- while pg_get_functiondef(fn_mirror_asset_instance) still references them.
--
-- Fix: CREATE OR REPLACE the function with ONLY the FILTER branch cleaned —
-- drop the four dead column refs from the INSERT column list, the VALUES
-- list, and the ON CONFLICT UPDATE assignments, plus the now-unused local
-- variables and the SELECT-INTO that populated them. BLOCK / AREA / AHU /
-- DELETE / ELSE branches are byte-for-byte unchanged. The trigger itself
-- (trg_mirror_asset_instance_iud) is untouched — only the function body is
-- replaced. FilterDetails stays the authoritative source for cycle state;
-- when the A-01 asset cutover merges FilterDetails into `filters`, these
-- columns get re-added there and the mirror can be revisited.

CREATE OR REPLACE FUNCTION fn_mirror_asset_instance() RETURNS TRIGGER AS $$
DECLARE
  v_kind TEXT;
  v_parent_kind TEXT;
  v_parent_id UUID;
  v_block_id UUID;
  v_area_id UUID;
  v_ahu_id UUID;
BEGIN
  -- Look up the template_kind for both INSERT/UPDATE (NEW) and DELETE (OLD)
  IF TG_OP = 'DELETE' THEN
    SELECT template_kind INTO v_kind FROM asset_templates WHERE id = OLD.template_id;
    -- Cascade-delete from whichever typed table holds the row
    DELETE FROM blocks  WHERE id = OLD.id;
    DELETE FROM areas   WHERE id = OLD.id;
    DELETE FROM ahus    WHERE id = OLD.id;
    DELETE FROM filters WHERE id = OLD.id;
    RETURN OLD;
  END IF;

  SELECT template_kind INTO v_kind FROM asset_templates WHERE id = NEW.template_id;

  -- Determine the parent's kind so we know which typed-table FK to set
  IF NEW.parent_id IS NOT NULL THEN
    SELECT t.template_kind INTO v_parent_kind
    FROM asset_instances i
    JOIN asset_templates t ON i.template_id = t.id
    WHERE i.id = NEW.parent_id;
  END IF;

  -- INSERT or UPDATE: upsert into the correct typed table, and remove from any
  -- other typed table the row may have been mirrored to previously (handles
  -- the rare case of template_kind changing via direct admin edit).
  IF v_kind = 'BLOCK' THEN
    DELETE FROM areas WHERE id = NEW.id;
    DELETE FROM ahus WHERE id = NEW.id;
    DELETE FROM filters WHERE id = NEW.id;
    INSERT INTO blocks (id, name, description, status, attributes, custom_attributes, uns_path, is_active, created_at, updated_at, created_by, updated_by)
    VALUES (NEW.id, NEW.name, NEW.description, NEW.status, NEW.attributes, NEW.custom_attributes, NEW.uns_path, NEW.is_active, NEW.created_at, NEW.updated_at, NEW.created_by, NEW.updated_by)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      status = EXCLUDED.status,
      attributes = EXCLUDED.attributes,
      custom_attributes = EXCLUDED.custom_attributes,
      uns_path = EXCLUDED.uns_path,
      is_active = EXCLUDED.is_active,
      updated_at = EXCLUDED.updated_at,
      updated_by = EXCLUDED.updated_by;

  ELSIF v_kind = 'AREA' THEN
    DELETE FROM blocks WHERE id = NEW.id;
    DELETE FROM ahus WHERE id = NEW.id;
    DELETE FROM filters WHERE id = NEW.id;
    -- Only set block_id if parent is actually a BLOCK
    v_block_id := CASE WHEN v_parent_kind = 'BLOCK' THEN NEW.parent_id ELSE NULL END;
    INSERT INTO areas (id, block_id, name, description, status, attributes, custom_attributes, uns_path, is_active, created_at, updated_at, created_by, updated_by)
    VALUES (NEW.id, v_block_id, NEW.name, NEW.description, NEW.status, NEW.attributes, NEW.custom_attributes, NEW.uns_path, NEW.is_active, NEW.created_at, NEW.updated_at, NEW.created_by, NEW.updated_by)
    ON CONFLICT (id) DO UPDATE SET
      block_id = EXCLUDED.block_id,
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      status = EXCLUDED.status,
      attributes = EXCLUDED.attributes,
      custom_attributes = EXCLUDED.custom_attributes,
      uns_path = EXCLUDED.uns_path,
      is_active = EXCLUDED.is_active,
      updated_at = EXCLUDED.updated_at,
      updated_by = EXCLUDED.updated_by;

  ELSIF v_kind = 'AHU' THEN
    DELETE FROM blocks WHERE id = NEW.id;
    DELETE FROM areas WHERE id = NEW.id;
    DELETE FROM filters WHERE id = NEW.id;
    v_area_id := CASE WHEN v_parent_kind = 'AREA' THEN NEW.parent_id ELSE NULL END;
    INSERT INTO ahus (id, area_id, name, description, status, attributes, custom_attributes, uns_path, is_active, created_at, updated_at, created_by, updated_by)
    VALUES (NEW.id, v_area_id, NEW.name, NEW.description, NEW.status, NEW.attributes, NEW.custom_attributes, NEW.uns_path, NEW.is_active, NEW.created_at, NEW.updated_at, NEW.created_by, NEW.updated_by)
    ON CONFLICT (id) DO UPDATE SET
      area_id = EXCLUDED.area_id,
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      status = EXCLUDED.status,
      attributes = EXCLUDED.attributes,
      custom_attributes = EXCLUDED.custom_attributes,
      uns_path = EXCLUDED.uns_path,
      is_active = EXCLUDED.is_active,
      updated_at = EXCLUDED.updated_at,
      updated_by = EXCLUDED.updated_by;

  ELSIF v_kind = 'FILTER' THEN
    DELETE FROM blocks WHERE id = NEW.id;
    DELETE FROM areas WHERE id = NEW.id;
    DELETE FROM ahus WHERE id = NEW.id;
    v_ahu_id := CASE WHEN v_parent_kind = 'AHU' THEN NEW.parent_id ELSE NULL END;
    -- M-04: cycle-state columns (filter_profile_id, current_lifecycle_state,
    -- current_cycle_id, filter_set) were dropped from `filters` on 2026-05-25;
    -- FilterDetails is now their only home. Mirror only the identity/hierarchy
    -- columns here.
    INSERT INTO filters (id, ahu_id, name, description, status, attributes, custom_attributes, uns_path, is_active, created_at, updated_at, created_by, updated_by)
    VALUES (NEW.id, v_ahu_id, NEW.name, NEW.description, NEW.status, NEW.attributes, NEW.custom_attributes, NEW.uns_path, NEW.is_active, NEW.created_at, NEW.updated_at, NEW.created_by, NEW.updated_by)
    ON CONFLICT (id) DO UPDATE SET
      ahu_id = EXCLUDED.ahu_id,
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      status = EXCLUDED.status,
      attributes = EXCLUDED.attributes,
      custom_attributes = EXCLUDED.custom_attributes,
      uns_path = EXCLUDED.uns_path,
      is_active = EXCLUDED.is_active,
      updated_at = EXCLUDED.updated_at,
      updated_by = EXCLUDED.updated_by;

  ELSE
    -- OTHER / EQUIPMENT / unknown kind — remove from all typed tables (no mirror)
    DELETE FROM blocks WHERE id = NEW.id;
    DELETE FROM areas WHERE id = NEW.id;
    DELETE FROM ahus WHERE id = NEW.id;
    DELETE FROM filters WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
