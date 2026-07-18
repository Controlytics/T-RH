-- Wave 1 of asset-removal: add Block / Area / AHU / Filter as typed tables
-- alongside AssetInstance. Reuses AssetInstance.id (UUID) so existing soft-FK
-- columns (cleaning_cycles.filterId, filter_events.blockId, etc.) continue to
-- resolve. Dual-write trigger keeps the typed tables in sync with every
-- AssetInstance mutation. Backfill seeds the current 9 rows
-- (4 BLOCK + 2 AREA + 2 AHU + 1 FILTER from dev DB).
--
-- This migration is ADDITIVE only — AssetInstance + AssetTemplate continue to
-- exist and remain the source of truth until Wave 5 cutover.
-- Created 2026-05-17 per tasks/REMOVE-RULECHAIN-ALARM-PLAN.md sibling plan.

BEGIN;

-- ============================================================
-- 1. Typed hierarchy tables (mirror of AssetInstance per kind)
-- ============================================================

-- Blocks are roots — no parent. UUID matches asset_instances.id.
CREATE TABLE "blocks" (
  "id"                UUID PRIMARY KEY,
  "name"              VARCHAR(255) NOT NULL,
  "description"       TEXT,
  "status"            VARCHAR(50) NOT NULL DEFAULT 'Active',
  "attributes"        JSONB NOT NULL DEFAULT '{}',
  "custom_attributes" JSONB NOT NULL DEFAULT '{}',
  "uns_path"          VARCHAR(500),
  "is_active"         BOOLEAN NOT NULL DEFAULT true,
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  "created_by"        VARCHAR(50),
  "updated_by"        VARCHAR(50)
);

CREATE INDEX "blocks_status_idx"    ON "blocks"("status");
CREATE INDEX "blocks_name_idx"      ON "blocks"("name");
CREATE INDEX "blocks_is_active_idx" ON "blocks"("is_active");

-- Areas live under blocks.
CREATE TABLE "areas" (
  "id"                UUID PRIMARY KEY,
  "block_id"          UUID,
  "name"              VARCHAR(255) NOT NULL,
  "description"       TEXT,
  "status"            VARCHAR(50) NOT NULL DEFAULT 'Active',
  "attributes"        JSONB NOT NULL DEFAULT '{}',
  "custom_attributes" JSONB NOT NULL DEFAULT '{}',
  "uns_path"          VARCHAR(500),
  "is_active"         BOOLEAN NOT NULL DEFAULT true,
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  "created_by"        VARCHAR(50),
  "updated_by"        VARCHAR(50)
);

CREATE INDEX "areas_block_id_idx"  ON "areas"("block_id");
CREATE INDEX "areas_status_idx"    ON "areas"("status");
CREATE INDEX "areas_name_idx"      ON "areas"("name");
CREATE INDEX "areas_is_active_idx" ON "areas"("is_active");

-- AHUs live under areas. (Orphan AHUs allowed during Wave 1 because legacy data
-- has some without a parent set; cleanup in Wave 5.)
CREATE TABLE "ahus" (
  "id"                UUID PRIMARY KEY,
  "area_id"           UUID,
  "name"              VARCHAR(255) NOT NULL,
  "description"       TEXT,
  "status"            VARCHAR(50) NOT NULL DEFAULT 'Active',
  "attributes"        JSONB NOT NULL DEFAULT '{}',
  "custom_attributes" JSONB NOT NULL DEFAULT '{}',
  "uns_path"          VARCHAR(500),
  "is_active"         BOOLEAN NOT NULL DEFAULT true,
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  "created_by"        VARCHAR(50),
  "updated_by"        VARCHAR(50)
);

CREATE INDEX "ahus_area_id_idx"   ON "ahus"("area_id");
CREATE INDEX "ahus_status_idx"    ON "ahus"("status");
CREATE INDEX "ahus_name_idx"      ON "ahus"("name");
CREATE INDEX "ahus_is_active_idx" ON "ahus"("is_active");

-- Filters live under AHUs and inline the FilterDetails 1:1 sidecar fields.
CREATE TABLE "filters" (
  "id"                       UUID PRIMARY KEY,
  "ahu_id"                   UUID,
  "name"                     VARCHAR(255) NOT NULL,
  "description"              TEXT,
  "status"                   VARCHAR(50) NOT NULL DEFAULT 'Active',
  "attributes"               JSONB NOT NULL DEFAULT '{}',
  "custom_attributes"        JSONB NOT NULL DEFAULT '{}',
  "uns_path"                 VARCHAR(500),
  "is_active"                BOOLEAN NOT NULL DEFAULT true,
  -- Inlined from FilterDetails (1:1 sidecar in legacy schema):
  "filter_profile_id"        UUID,
  "current_lifecycle_state"  VARCHAR(100),
  "current_cycle_id"         UUID,
  "filter_set"               VARCHAR(50),
  "created_at"               TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"               TIMESTAMPTZ NOT NULL DEFAULT now(),
  "created_by"               VARCHAR(50),
  "updated_by"               VARCHAR(50)
);

CREATE INDEX "filters_ahu_id_idx"                  ON "filters"("ahu_id");
CREATE INDEX "filters_status_idx"                  ON "filters"("status");
CREATE INDEX "filters_name_idx"                    ON "filters"("name");
CREATE INDEX "filters_is_active_idx"               ON "filters"("is_active");
CREATE INDEX "filters_current_lifecycle_state_idx" ON "filters"("current_lifecycle_state");
CREATE INDEX "filters_current_cycle_id_idx"        ON "filters"("current_cycle_id");
CREATE INDEX "filters_filter_profile_id_idx"       ON "filters"("filter_profile_id");

-- ============================================================
-- 2. Dual-write trigger: mirror AssetInstance changes into typed tables
-- ============================================================

CREATE OR REPLACE FUNCTION fn_mirror_asset_instance() RETURNS TRIGGER AS $$
DECLARE
  v_kind TEXT;
  v_parent_kind TEXT;
  v_parent_id UUID;
  v_block_id UUID;
  v_area_id UUID;
  v_ahu_id UUID;
  v_filter_profile_id UUID;
  v_current_lifecycle_state TEXT;
  v_current_cycle_id UUID;
  v_filter_set TEXT;
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

  -- Pull FilterDetails sidecar fields for FILTER kind
  IF v_kind = 'FILTER' THEN
    SELECT filter_profile_id, current_lifecycle_state, current_cycle_id, filter_set::text
      INTO v_filter_profile_id, v_current_lifecycle_state, v_current_cycle_id, v_filter_set
    FROM filter_details WHERE asset_instance_id = NEW.id;
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
    INSERT INTO filters (id, ahu_id, name, description, status, attributes, custom_attributes, uns_path, is_active, filter_profile_id, current_lifecycle_state, current_cycle_id, filter_set, created_at, updated_at, created_by, updated_by)
    VALUES (NEW.id, v_ahu_id, NEW.name, NEW.description, NEW.status, NEW.attributes, NEW.custom_attributes, NEW.uns_path, NEW.is_active, v_filter_profile_id, v_current_lifecycle_state, v_current_cycle_id, v_filter_set, NEW.created_at, NEW.updated_at, NEW.created_by, NEW.updated_by)
    ON CONFLICT (id) DO UPDATE SET
      ahu_id = EXCLUDED.ahu_id,
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      status = EXCLUDED.status,
      attributes = EXCLUDED.attributes,
      custom_attributes = EXCLUDED.custom_attributes,
      uns_path = EXCLUDED.uns_path,
      is_active = EXCLUDED.is_active,
      filter_profile_id = EXCLUDED.filter_profile_id,
      current_lifecycle_state = EXCLUDED.current_lifecycle_state,
      current_cycle_id = EXCLUDED.current_cycle_id,
      filter_set = EXCLUDED.filter_set,
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

CREATE TRIGGER trg_mirror_asset_instance_iud
AFTER INSERT OR UPDATE OR DELETE ON asset_instances
FOR EACH ROW EXECUTE FUNCTION fn_mirror_asset_instance();

-- Mirror filter_details changes back to filters table (the FK sidecar fields
-- live on filter_details; the trigger above only fires on asset_instances).
CREATE OR REPLACE FUNCTION fn_mirror_filter_details() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE filters
    SET filter_profile_id       = NULL,
        current_lifecycle_state = NULL,
        current_cycle_id        = NULL,
        filter_set              = NULL,
        updated_at              = now()
    WHERE id = OLD.asset_instance_id;
    RETURN OLD;
  END IF;

  UPDATE filters
  SET filter_profile_id       = NEW.filter_profile_id,
      current_lifecycle_state = NEW.current_lifecycle_state,
      current_cycle_id        = NEW.current_cycle_id,
      filter_set              = NEW.filter_set::text,
      updated_at              = NEW.updated_at
  WHERE id = NEW.asset_instance_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_mirror_filter_details_iud
AFTER INSERT OR UPDATE OR DELETE ON filter_details
FOR EACH ROW EXECUTE FUNCTION fn_mirror_filter_details();

-- ============================================================
-- 3. Backfill existing rows by template_kind
-- ============================================================

-- Blocks
INSERT INTO blocks (id, name, description, status, attributes, custom_attributes, uns_path, is_active, created_at, updated_at, created_by, updated_by)
SELECT i.id, i.name, i.description, i.status, i.attributes, i.custom_attributes, i.uns_path, i.is_active, i.created_at, i.updated_at, i.created_by, i.updated_by
FROM asset_instances i
JOIN asset_templates t ON i.template_id = t.id
WHERE t.template_kind = 'BLOCK'
ON CONFLICT (id) DO NOTHING;

-- Areas (with block parent if any)
INSERT INTO areas (id, block_id, name, description, status, attributes, custom_attributes, uns_path, is_active, created_at, updated_at, created_by, updated_by)
SELECT i.id,
       CASE WHEN pt.template_kind = 'BLOCK' THEN i.parent_id ELSE NULL END,
       i.name, i.description, i.status, i.attributes, i.custom_attributes, i.uns_path, i.is_active, i.created_at, i.updated_at, i.created_by, i.updated_by
FROM asset_instances i
JOIN asset_templates t ON i.template_id = t.id
LEFT JOIN asset_instances p ON i.parent_id = p.id
LEFT JOIN asset_templates pt ON p.template_id = pt.id
WHERE t.template_kind = 'AREA'
ON CONFLICT (id) DO NOTHING;

-- AHUs (with area parent if any)
INSERT INTO ahus (id, area_id, name, description, status, attributes, custom_attributes, uns_path, is_active, created_at, updated_at, created_by, updated_by)
SELECT i.id,
       CASE WHEN pt.template_kind = 'AREA' THEN i.parent_id ELSE NULL END,
       i.name, i.description, i.status, i.attributes, i.custom_attributes, i.uns_path, i.is_active, i.created_at, i.updated_at, i.created_by, i.updated_by
FROM asset_instances i
JOIN asset_templates t ON i.template_id = t.id
LEFT JOIN asset_instances p ON i.parent_id = p.id
LEFT JOIN asset_templates pt ON p.template_id = pt.id
WHERE t.template_kind = 'AHU'
ON CONFLICT (id) DO NOTHING;

-- Filters (with AHU parent if any, plus inlined FilterDetails fields)
INSERT INTO filters (id, ahu_id, name, description, status, attributes, custom_attributes, uns_path, is_active, filter_profile_id, current_lifecycle_state, current_cycle_id, filter_set, created_at, updated_at, created_by, updated_by)
SELECT i.id,
       CASE WHEN pt.template_kind = 'AHU' THEN i.parent_id ELSE NULL END,
       i.name, i.description, i.status, i.attributes, i.custom_attributes, i.uns_path, i.is_active,
       fd.filter_profile_id, fd.current_lifecycle_state, fd.current_cycle_id, fd.filter_set::text,
       i.created_at, i.updated_at, i.created_by, i.updated_by
FROM asset_instances i
JOIN asset_templates t ON i.template_id = t.id
LEFT JOIN asset_instances p ON i.parent_id = p.id
LEFT JOIN asset_templates pt ON p.template_id = pt.id
LEFT JOIN filter_details fd ON fd.asset_instance_id = i.id
WHERE t.template_kind = 'FILTER'
ON CONFLICT (id) DO NOTHING;

COMMIT;
