-- Drop uns_path columns from typed hierarchy tables + asset_instances.
-- Phase 7 cleanup follow-up (post data-ingestion removal).
-- Pre-verified: all uns_path values are NULL across all 5 tables (693 rows).

BEGIN;

-- 1. DROP TRIGGERS
DROP TRIGGER IF EXISTS trg_mirror_asset_instance_iud      ON asset_instances;
DROP TRIGGER IF EXISTS trg_mirror_typed_to_asset_instance ON filters;

-- 2. DROP TRIGGER FUNCTIONS
DROP FUNCTION IF EXISTS public.fn_mirror_asset_instance() CASCADE;
DROP FUNCTION IF EXISTS public.fn_mirror_typed_to_asset_instance() CASCADE;

-- 3. DROP COLUMNS
ALTER TABLE blocks          DROP COLUMN IF EXISTS uns_path;
ALTER TABLE areas           DROP COLUMN IF EXISTS uns_path;
ALTER TABLE ahus            DROP COLUMN IF EXISTS uns_path;
ALTER TABLE filters         DROP COLUMN IF EXISTS uns_path;
ALTER TABLE asset_instances DROP COLUMN IF EXISTS uns_path;

-- 4. RECREATE fn_mirror_asset_instance (no uns_path)
CREATE OR REPLACE FUNCTION public.fn_mirror_asset_instance()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_kind TEXT;
  v_parent_kind TEXT;
  v_block_id UUID;
  v_area_id UUID;
  v_ahu_id UUID;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN COALESCE(NEW, OLD); END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT template_kind INTO v_kind FROM asset_templates WHERE id = OLD.template_id;
    DELETE FROM blocks  WHERE id = OLD.id;
    DELETE FROM areas   WHERE id = OLD.id;
    DELETE FROM ahus    WHERE id = OLD.id;
    DELETE FROM filters WHERE id = OLD.id;
    RETURN OLD;
  END IF;

  SELECT template_kind INTO v_kind FROM asset_templates WHERE id = NEW.template_id;

  IF NEW.parent_id IS NOT NULL THEN
    SELECT t.template_kind INTO v_parent_kind
    FROM asset_instances i
    JOIN asset_templates t ON i.template_id = t.id
    WHERE i.id = NEW.parent_id;
  END IF;

  IF v_kind = 'BLOCK' THEN
    DELETE FROM areas WHERE id = NEW.id;
    DELETE FROM ahus WHERE id = NEW.id;
    DELETE FROM filters WHERE id = NEW.id;
    INSERT INTO blocks (id, name, description, status, attributes, custom_attributes,
                        is_active, created_at, updated_at, created_by, updated_by)
    VALUES (NEW.id, NEW.name, NEW.description, NEW.status, NEW.attributes, NEW.custom_attributes,
            NEW.is_active, NEW.created_at, NEW.updated_at, NEW.created_by, NEW.updated_by)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name, description = EXCLUDED.description, status = EXCLUDED.status,
      attributes = EXCLUDED.attributes, custom_attributes = EXCLUDED.custom_attributes,
      is_active = EXCLUDED.is_active, updated_at = EXCLUDED.updated_at,
      updated_by = EXCLUDED.updated_by;

  ELSIF v_kind = 'AREA' THEN
    DELETE FROM blocks WHERE id = NEW.id;
    DELETE FROM ahus WHERE id = NEW.id;
    DELETE FROM filters WHERE id = NEW.id;
    v_block_id := CASE WHEN v_parent_kind = 'BLOCK' THEN NEW.parent_id ELSE NULL END;
    INSERT INTO areas (id, block_id, name, description, status, attributes, custom_attributes,
                       is_active, created_at, updated_at, created_by, updated_by)
    VALUES (NEW.id, v_block_id, NEW.name, NEW.description, NEW.status, NEW.attributes,
            NEW.custom_attributes, NEW.is_active, NEW.created_at, NEW.updated_at,
            NEW.created_by, NEW.updated_by)
    ON CONFLICT (id) DO UPDATE SET
      block_id = EXCLUDED.block_id, name = EXCLUDED.name, description = EXCLUDED.description,
      status = EXCLUDED.status, attributes = EXCLUDED.attributes,
      custom_attributes = EXCLUDED.custom_attributes, is_active = EXCLUDED.is_active,
      updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;

  ELSIF v_kind = 'AHU' THEN
    DELETE FROM blocks WHERE id = NEW.id;
    DELETE FROM areas WHERE id = NEW.id;
    DELETE FROM filters WHERE id = NEW.id;
    v_area_id := CASE WHEN v_parent_kind = 'AREA' THEN NEW.parent_id ELSE NULL END;
    v_block_id := CASE WHEN v_parent_kind = 'BLOCK' THEN NEW.parent_id ELSE NULL END;
    INSERT INTO ahus (id, area_id, block_id, name, description, status, attributes,
                      custom_attributes, is_active, created_at, updated_at, created_by, updated_by)
    VALUES (NEW.id, v_area_id, v_block_id, NEW.name, NEW.description, NEW.status,
            NEW.attributes, NEW.custom_attributes, NEW.is_active, NEW.created_at,
            NEW.updated_at, NEW.created_by, NEW.updated_by)
    ON CONFLICT (id) DO UPDATE SET
      area_id = EXCLUDED.area_id, block_id = EXCLUDED.block_id, name = EXCLUDED.name,
      description = EXCLUDED.description, status = EXCLUDED.status,
      attributes = EXCLUDED.attributes, custom_attributes = EXCLUDED.custom_attributes,
      is_active = EXCLUDED.is_active, updated_at = EXCLUDED.updated_at,
      updated_by = EXCLUDED.updated_by;

  ELSIF v_kind = 'FILTER' THEN
    DELETE FROM blocks WHERE id = NEW.id;
    DELETE FROM areas WHERE id = NEW.id;
    DELETE FROM ahus WHERE id = NEW.id;
    v_ahu_id := CASE WHEN v_parent_kind = 'AHU' THEN NEW.parent_id ELSE NULL END;
    INSERT INTO filters (id, ahu_id, name, description, status, attributes, custom_attributes,
                         is_active, created_at, updated_at, created_by, updated_by)
    VALUES (NEW.id, v_ahu_id, NEW.name, NEW.description, NEW.status, NEW.attributes,
            NEW.custom_attributes, NEW.is_active, NEW.created_at, NEW.updated_at,
            NEW.created_by, NEW.updated_by)
    ON CONFLICT (id) DO UPDATE SET
      ahu_id = EXCLUDED.ahu_id, name = EXCLUDED.name, description = EXCLUDED.description,
      status = EXCLUDED.status, attributes = EXCLUDED.attributes,
      custom_attributes = EXCLUDED.custom_attributes, is_active = EXCLUDED.is_active,
      updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;

  ELSE
    DELETE FROM blocks WHERE id = NEW.id;
    DELETE FROM areas WHERE id = NEW.id;
    DELETE FROM ahus WHERE id = NEW.id;
    DELETE FROM filters WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$function$;

-- 5. RECREATE fn_mirror_typed_to_asset_instance (no uns_path)
CREATE OR REPLACE FUNCTION public.fn_mirror_typed_to_asset_instance()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
     telemetry_config, custom_attributes, parent_id, is_active,
     created_at, updated_at, created_by, updated_by)
  VALUES
    (NEW.id, NEW.name, NEW.description, v_tmpl, 1, NEW.status, NEW.attributes,
     '{}'::jsonb, NEW.custom_attributes, NEW.ahu_id, NEW.is_active,
     NEW.created_at, NEW.updated_at, NEW.created_by, NEW.updated_by)
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, description = EXCLUDED.description, status = EXCLUDED.status,
    attributes = EXCLUDED.attributes, custom_attributes = EXCLUDED.custom_attributes,
    parent_id = EXCLUDED.parent_id, is_active = EXCLUDED.is_active,
    updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;
  RETURN NEW;
END;
$function$;

-- 6. RE-BIND TRIGGERS
CREATE TRIGGER trg_mirror_asset_instance_iud
  AFTER INSERT OR UPDATE OR DELETE ON asset_instances
  FOR EACH ROW EXECUTE FUNCTION public.fn_mirror_asset_instance();

CREATE TRIGGER trg_mirror_typed_to_asset_instance
  AFTER INSERT OR UPDATE OR DELETE ON filters
  FOR EACH ROW EXECUTE FUNCTION public.fn_mirror_typed_to_asset_instance();

COMMIT;
SELECT table_name, column_name FROM information_schema.columns
WHERE column_name = 'uns_path' AND table_schema = 'public';
SELECT trigger_name, event_object_table, event_manipulation
FROM information_schema.triggers
WHERE trigger_name ILIKE '%mirror%'
ORDER BY event_object_table, event_manipulation;
SELECT table_name, column_name FROM information_schema.columns
WHERE column_name = 'uns_path' AND table_schema = 'public';
SELECT trigger_name, event_object_table, event_manipulation
FROM information_schema.triggers
WHERE trigger_name ILIKE '%mirror%'
ORDER BY event_object_table, event_manipulation;
-- Verify the new trigger functions have NO uns_path references
SELECT proname,
       CASE WHEN pg_get_functiondef(oid) LIKE '%uns_path%' THEN '❌ STILL HAS uns_path'
            ELSE '✅ clean'
       END AS status
FROM pg_proc
WHERE proname IN ('fn_mirror_asset_instance', 'fn_mirror_typed_to_asset_instance');
-- The test block should be soft-deleted (isActive=false)
SELECT id, name, is_active FROM blocks WHERE name LIKE 'TEST_BLOCK%' ORDER BY created_at DESC LIMIT 5;

-- And mirrored back to asset_instances also soft-deleted
SELECT id, name, is_active FROM asset_instances WHERE name LIKE 'TEST_BLOCK%' ORDER BY created_at DESC LIMIT 5;







