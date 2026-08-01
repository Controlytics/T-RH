-- Fix round 1 of Task 4 review. Second, purely additive migration on top of
-- 20260801120000_data_injection_p1 (already applied to compliance_core_db
-- and compliance_core_db_test — do not amend that migration).
--
-- NOTE: the auto-generated candidate diff (--from-url live-dev-db
-- --to-schema-datamodel schema.prisma) also included two blocks of noise,
-- both deliberately omitted here:
--   1. DROP INDEX "hierarchy_nodes_path_btree_idx"; DROP INDEX
--      "hierarchy_nodes_path_gist_idx"; ALTER TABLE "hierarchy_nodes" DROP
--      COLUMN "path"; — because `path ltree` is intentionally absent from
--      schema.prisma (see the comment above HierarchyNode), any datamodel
--      diff will always propose dropping it. It must never actually be
--      dropped.
--   2. ALTER TABLE "audit_trail" ALTER COLUMN "chain_position" DROP NOT
--      NULL; — the same pre-existing schema.prisma/live-DB divergence
--      documented in the first migration and tasks/todo.md. audit_trail is
--      off-limits for this task.

-- Missing FK indexes flagged in Task 4 review: Tasks 5-11 will query
-- "gateways using profile Y" / "profiles for protocol X" style lookups.
CREATE INDEX "communication_profiles_protocol_key_idx" ON "communication_profiles"("protocol_key");
CREATE INDEX "gateways_communication_profile_id_idx" ON "gateways"("communication_profile_id");
CREATE INDEX "instruments_communication_profile_id_idx" ON "instruments"("communication_profile_id");

-- Root-level slug uniqueness. `@@unique([parentId, slug])` in schema.prisma
-- does not constrain root nodes because Postgres treats NULL <> NULL, so two
-- COMPANY-level roots could both be slug 'controlyt' and produce identical
-- UNS topic paths for different instrument trees. Prisma cannot express a
-- partial unique index, so this is raw SQL only (see the comment above
-- HierarchyNode in schema.prisma).
CREATE UNIQUE INDEX "hierarchy_nodes_root_slug_key"
  ON "hierarchy_nodes" ("slug") WHERE "parent_id" IS NULL;
