-- Manual display order for functional locations.
--
-- `sort_order` orders siblings, lowest first, with name as the tiebreak.
-- DEFAULT 0 is what makes this a no-op on existing data: every current row
-- gets 0, they all tie, and the name tiebreak reproduces exactly the
-- alphabetical order the application showed before this column existed.
-- Nothing moves until an operator actually arranges something.
--
-- The index matches how the rows are read - siblings of one parent, in order -
-- because both the list endpoint and the reorder screen sort on
-- (parent_id, sort_order) and would otherwise scan the table on every render.
--
-- ---------------------------------------------------------------------------
-- HAND-AUTHORED. `prisma migrate diff` generated FIVE statements for this
-- change; THREE were stripped, and stripping them is not optional:
--
--   1. DROP TABLE "instrument_telemetry_history"
--      The partitioned telemetry table. It cannot appear in schema.prisma
--      because Prisma cannot express PARTITION BY, so Prisma reads it as
--      drift and proposes deleting it. It held 226,582 readings when this
--      was written and there is no other copy. This is the sixteenth
--      migration in this repository to carry that statement in its generated
--      form; see apps/api/src/lib/migration-guard.ts, which now fails the
--      build if one is ever committed.
--
--   2. ALTER TABLE "audit_trail" ALTER COLUMN "chain_position" DROP NOT NULL
--      The §11 hash-chain position. It is sequence-backed out of band, so the
--      datamodel does not describe it and Prisma proposes relaxing it.
--      Dropping the constraint would permit a NULL position and break the
--      chain walk.
--
--   3. DROP + re-ADD of instrument_credentials_instrument_id_fkey
--      Identical constraint, dropped and recreated for no reason. Churn on a
--      live foreign key, so it is left alone.
--
-- Read the header of migrations/20260811120000_instrument_floorplans for the
-- same three, and prisma/schema.prisma's FunctionalLocation comment for why
-- the default is 0.
-- ---------------------------------------------------------------------------

ALTER TABLE "functional_locations"
  ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "functional_locations_parent_id_sort_order_idx"
  ON "functional_locations"("parent_id", "sort_order");
