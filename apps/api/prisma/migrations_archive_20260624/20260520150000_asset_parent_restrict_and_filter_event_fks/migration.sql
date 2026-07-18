-- Wave 5 (2026-05-20) — AssetInstance.parent_id FK semantics change.
--
-- Was ON DELETE SET NULL: deleting a Block silently re-rooted all child
-- Areas / AHUs / Filters under it (parent_id → NULL). Hierarchy context
-- lost with no error. Reports filtering by Block.id silently dropped rows.
--
-- Now ON DELETE RESTRICT: the FK constraint refuses the delete if any
-- child still references the parent. Operators must explicitly detach
-- children first.
--
-- FilterEvent soft-keyed FK additions (filter_id, cleaning_area_id,
-- equipment_id, block_id → asset_instances.id) deliberately deferred —
-- the install likely has orphan rows where the referenced AssetInstance
-- was deleted, and adding the FK would fail. Backfill + FK addition is
-- planned in a follow-up Wave-5b migration after orphan cleanup pass.

-- Drop existing FK (Prisma generated name follows the asset_instances_parent_id_fkey pattern).
ALTER TABLE asset_instances
  DROP CONSTRAINT IF EXISTS asset_instances_parent_id_fkey;

ALTER TABLE asset_instances
  ADD CONSTRAINT asset_instances_parent_id_fkey
  FOREIGN KEY (parent_id)
  REFERENCES asset_instances(id)
  ON DELETE RESTRICT
  ON UPDATE CASCADE;
