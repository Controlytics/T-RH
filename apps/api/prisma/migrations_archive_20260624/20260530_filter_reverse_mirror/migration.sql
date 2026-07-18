-- A-01 Tier 2 Phase 1: reverse-mirror filters -> asset_instances + recursion guards (2026-05-30)
-- (1) Forward trigger re-applied verbatim (from pg_get_functiondef) with a
--     pg_trigger_depth()>1 guard inserted right after BEGIN to break the
--     reverse<->forward recursion. Body otherwise byte-for-byte unchanged.
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
$function$

;

-- (2) Reverse trigger: a typed-filter write back-fills the legacy asset_instances mirror.
CREATE OR REPLACE FUNCTION fn_mirror_typed_to_asset_instance() RETURNS TRIGGER AS $$
DECLARE
  v_tmpl UUID;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' THEN
    DELETE FROM asset_instances WHERE id = OLD.id;
    RETURN OLD;
  END IF;
  SELECT id INTO v_tmpl FROM asset_templates
    WHERE template_kind = 'FILTER' AND is_active = true
    ORDER BY created_at ASC LIMIT 1;
  IF v_tmpl IS NULL THEN
    RAISE EXCEPTION 'No active FILTER asset_template to mirror filter % into asset_instances', NEW.id;
  END IF;
  INSERT INTO asset_instances
    (id, name, description, template_id, template_version, status, attributes,
     telemetry_config, custom_attributes, parent_id, uns_path, is_active,
     created_at, updated_at, created_by, updated_by)
  VALUES
    (NEW.id, NEW.name, NEW.description, v_tmpl, 1, NEW.status, NEW.attributes,
     '{}'::jsonb, NEW.custom_attributes, NEW.ahu_id, NEW.uns_path, NEW.is_active,
     NEW.created_at, NEW.updated_at, NEW.created_by, NEW.updated_by)
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, description = EXCLUDED.description, status = EXCLUDED.status,
    attributes = EXCLUDED.attributes, custom_attributes = EXCLUDED.custom_attributes,
    parent_id = EXCLUDED.parent_id, uns_path = EXCLUDED.uns_path, is_active = EXCLUDED.is_active,
    updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mirror_typed_to_asset_instance ON filters;
CREATE TRIGGER trg_mirror_typed_to_asset_instance
  AFTER INSERT OR UPDATE OR DELETE ON filters
  FOR EACH ROW EXECUTE FUNCTION fn_mirror_typed_to_asset_instance();
