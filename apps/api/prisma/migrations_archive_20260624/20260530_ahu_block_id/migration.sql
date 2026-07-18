-- A-01 T2.2: typed ahus.block_id for direct-under-block AHUs (the typed model
-- previously only had area_id, so an AHU parented directly by a block had no
-- typed link). Adds the column, backfills from the legacy parent, and updates
-- the forward-mirror AHU branch to set block_id when the parent is a BLOCK.
ALTER TABLE ahus ADD COLUMN IF NOT EXISTS block_id UUID REFERENCES blocks(id);
CREATE INDEX IF NOT EXISTS ahus_block_id_idx ON ahus(block_id);
UPDATE ahus a SET block_id = p.id
  FROM asset_instances i JOIN asset_instances p ON p.id = i.parent_id
  JOIN asset_templates pt ON pt.id = p.template_id
  WHERE a.id = i.id AND a.area_id IS NULL AND pt.template_kind = 'BLOCK';

-- Forward trigger re-applied (from pg_get_functiondef, depth-guarded already)
-- with ONLY the AHU branch extended to also mirror block_id.
CREATE OR REPLACE FUNCTION public.fn_mirror_asset_instance()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_kind TEXT;
  v_parent_kind TEXT;
  v_parent_id UUID;
  v_block_id UUID;
  v_area_id UUID;
  v_ahu_id UUID;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN COALESCE(NEW, OLD); END IF;
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
    v_block_id := CASE WHEN v_parent_kind = 'BLOCK' THEN NEW.parent_id ELSE NULL END;
    INSERT INTO ahus (id, area_id, block_id, name, description, status, attributes, custom_attributes, uns_path, is_active, created_at, updated_at, created_by, updated_by)
    VALUES (NEW.id, v_area_id, v_block_id, NEW.name, NEW.description, NEW.status, NEW.attributes, NEW.custom_attributes, NEW.uns_path, NEW.is_active, NEW.created_at, NEW.updated_at, NEW.created_by, NEW.updated_by)
    ON CONFLICT (id) DO UPDATE SET
      area_id = EXCLUDED.area_id,
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
$function$

;
