-- Floorplans and their clickable rooms.
--
-- HAND-AUTHORED from `prisma migrate diff`, with three statements DELIBERATELY
-- STRIPPED from that output because they are out-of-band objects the datamodel
-- cannot see and would therefore have destroyed:
--
--   1. DROP TABLE "instrument_telemetry_history" — a PARTITIONED table Prisma
--      cannot express (see telemetry.repository.ts). Prisma reads it as stray
--      and wants it gone. It holds every historical reading.
--   2. ALTER TABLE "audit_trail" ALTER COLUMN "chain_position" DROP NOT NULL —
--      the 21 CFR §11 tamper-evident hash chain's position column, backed by a
--      manual sequence declared in prisma/sql/. Making it nullable would let a
--      row join the chain without a position.
--   3. DROP/ADD of instrument_credentials_instrument_id_fkey — an unchanged
--      constraint Prisma re-emits as churn. Dropping and recreating it takes a
--      lock for no benefit.
--
-- Coordinates are normalized 0..1 against the plan image. Bounds are enforced
-- in the application layer (floorplans/validation.ts), not by CHECK
-- constraints, so a bad payload returns a 400 naming the offending field
-- instead of an opaque constraint error the editor cannot explain.

-- CreateTable
CREATE TABLE "floorplans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "image_path" TEXT NOT NULL,
    "image_width" INTEGER NOT NULL,
    "image_height" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "floorplans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "floorplan_rooms" (
    "id" TEXT NOT NULL,
    "floorplan_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "w" DOUBLE PRECISION NOT NULL,
    "h" DOUBLE PRECISION NOT NULL,
    "temp_min" DOUBLE PRECISION,
    "temp_max" DOUBLE PRECISION,
    "rh_min" DOUBLE PRECISION,
    "rh_max" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "floorplan_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "floorplans_name_key" ON "floorplans"("name");

-- CreateIndex
CREATE INDEX "floorplan_rooms_floorplan_id_idx" ON "floorplan_rooms"("floorplan_id");

-- CreateIndex
CREATE UNIQUE INDEX "floorplan_rooms_floorplan_id_code_key" ON "floorplan_rooms"("floorplan_id", "code");

-- AddForeignKey
ALTER TABLE "floorplan_rooms" ADD CONSTRAINT "floorplan_rooms_floorplan_id_fkey" FOREIGN KEY ("floorplan_id") REFERENCES "floorplans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Instrument -> room. NULLABLE and ON DELETE SET NULL: deleting a room must
-- never delete the instruments that were in it. They return to the dashboard's
-- "not placed" tray instead.
-- AlterTable
ALTER TABLE "instruments" ADD COLUMN "room_id" TEXT;

-- CreateIndex
CREATE INDEX "instruments_room_id_idx" ON "instruments"("room_id");

-- AddForeignKey
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "floorplan_rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;
