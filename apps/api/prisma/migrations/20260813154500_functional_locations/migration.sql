-- Functional Locations: a two-level BLOCK > AREA tree, with each instrument
-- linked to at most one.
--
-- HAND-AUTHORED. `prisma migrate diff` in this repo emits three statements that
-- are DELIBERATELY ABSENT here because the datamodel cannot see the objects they
-- would destroy — the same three listed in the header of
-- 20260811120000_instrument_floorplans/migration.sql:
--
--   1. DROP TABLE "instrument_telemetry_history" — PARTITIONED, so Prisma reads
--      it as stray and wants it gone. It holds every historical reading.
--   2. ALTER "audit_trail"."chain_position" DROP NOT NULL — the 21 CFR §11
--      hash-chain position, backed by a manual sequence in prisma/sql/.
--   3. DROP/ADD of instrument_credentials_instrument_id_fkey — unchanged
--      constraint churn that takes a lock for no benefit.
--
-- EXCLUSIVITY IS STRUCTURAL: instruments.functional_location_id is a single
-- nullable FK, so an instrument holding two locations is unrepresentable rather
-- than merely forbidden. No join table, no partial unique index.
--
-- Both FKs are ON DELETE RESTRICT: deleting a location that still has child areas
-- or linked instruments must fail loudly, not silently orphan instruments in a
-- feature whose whole purpose is grouping them.

CREATE TYPE "FunctionalLocationType" AS ENUM ('BLOCK', 'AREA');

CREATE TABLE "functional_locations" (
    "id"         TEXT NOT NULL,
    "name"       TEXT NOT NULL,
    "type"       "FunctionalLocationType" NOT NULL,
    "parent_id"  TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "functional_locations_pkey" PRIMARY KEY ("id")
);

-- Unique per parent, so two Blocks may each own an area called "QC".
-- NOTE: Postgres treats NULLs as DISTINCT, so this does NOT make top-level Block
-- names unique. That check lives in the service layer, deliberately.
CREATE UNIQUE INDEX "functional_locations_parent_id_name_key" ON "functional_locations"("parent_id", "name");
CREATE INDEX "functional_locations_type_idx" ON "functional_locations"("type");

ALTER TABLE "functional_locations"
    ADD CONSTRAINT "functional_locations_parent_id_fkey"
    FOREIGN KEY ("parent_id") REFERENCES "functional_locations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "instruments" ADD COLUMN "functional_location_id" TEXT;
CREATE INDEX "instruments_functional_location_id_idx" ON "instruments"("functional_location_id");
ALTER TABLE "instruments"
    ADD CONSTRAINT "instruments_functional_location_id_fkey"
    FOREIGN KEY ("functional_location_id") REFERENCES "functional_locations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Seed from the existing free-text block/area values.
--
-- Verified against the live database 2026-08-13 (20 instruments): this creates
-- 2 Blocks (CWH, Block C) and 2 Areas (Module-E, Sterile Core) and links 5
-- instruments. The other 15 have no block/area at all and stay unlinked.
--
-- The block/area COLUMNS ARE KEPT. They stop being read for grouping and leave
-- the instrument form, but a bad mapping must stay comparable and correctable —
-- data is deleted only once proven redundant, not in the same step that stops
-- using it. Dropping them is a separate follow-up migration.
-- ---------------------------------------------------------------------------

INSERT INTO "functional_locations" ("id", "name", "type", "parent_id", "updated_at", "created_by")
SELECT gen_random_uuid()::text, TRIM("block"), 'BLOCK', NULL, NOW(), 'migration'
FROM "instruments"
WHERE "block" IS NOT NULL AND TRIM("block") <> ''
GROUP BY TRIM("block");

INSERT INTO "functional_locations" ("id", "name", "type", "parent_id", "updated_at", "created_by")
SELECT gen_random_uuid()::text, TRIM(i."area"), 'AREA', b."id", NOW(), 'migration'
FROM "instruments" i
JOIN "functional_locations" b ON b."type" = 'BLOCK' AND b."name" = TRIM(i."block")
WHERE i."area" IS NOT NULL AND TRIM(i."area") <> ''
  AND i."block" IS NOT NULL AND TRIM(i."block") <> ''
GROUP BY TRIM(i."area"), b."id";

-- Area first (the more specific match), then block-only instruments. The second
-- statement's `functional_location_id IS NULL` guard is what keeps it from
-- overwriting an area link with its parent block.
UPDATE "instruments" i
SET "functional_location_id" = a."id"
FROM "functional_locations" a
JOIN "functional_locations" b ON b."id" = a."parent_id"
WHERE a."type" = 'AREA'
  AND a."name" = TRIM(i."area")
  AND b."name" = TRIM(i."block");

UPDATE "instruments" i
SET "functional_location_id" = b."id"
FROM "functional_locations" b
WHERE b."type" = 'BLOCK'
  AND b."name" = TRIM(i."block")
  AND i."functional_location_id" IS NULL
  AND (i."area" IS NULL OR TRIM(i."area") = '');
