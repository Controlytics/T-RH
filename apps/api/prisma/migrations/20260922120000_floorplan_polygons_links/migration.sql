-- Layout Designer (2026-09-22): polygon rooms, room links, blank plans.
--
--   floorplan_rooms.points        the outline as corners, NULL = a rectangle
--                                 (x/y/w/h stay and become the bounding box)
--   floorplans.image_path         nullable: a plan may start from a blank canvas
--   floorplan_room_links          OPENING (a gap in a shared wall) or CONNECTOR
--                                 (a drawn line) between two rooms of one plan;
--                                 `kind` is a validated string, not an enum
--
-- No backfill: NULL points render exactly as the rectangle rendered before.
--
-- HAND-AUTHORED. `prisma migrate diff` also emits
--   DROP TABLE "instrument_telemetry_history";
-- which is STRIPPED here as in every migration since 2026-08-08: that table is
-- partitioned, invisible to the datamodel, and holds live telemetry. See
-- apps/api/src/lib/migration-guard.ts.

ALTER TABLE "floorplan_rooms" ADD COLUMN "points" JSONB;
ALTER TABLE "floorplans" ALTER COLUMN "image_path" DROP NOT NULL;

CREATE TABLE "floorplan_room_links" (
    "id" TEXT NOT NULL,
    "floorplan_id" TEXT NOT NULL,
    "from_room_id" TEXT NOT NULL,
    "to_room_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "from_edge" INTEGER,
    "offset" DOUBLE PRECISION,
    "width" DOUBLE PRECISION,
    "door" TEXT,
    "label" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "floorplan_room_links_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "floorplan_room_links_floorplan_id_idx" ON "floorplan_room_links"("floorplan_id");

ALTER TABLE "floorplan_room_links" ADD CONSTRAINT "floorplan_room_links_floorplan_id_fkey"
  FOREIGN KEY ("floorplan_id") REFERENCES "floorplans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "floorplan_room_links" ADD CONSTRAINT "floorplan_room_links_from_room_id_fkey"
  FOREIGN KEY ("from_room_id") REFERENCES "floorplan_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "floorplan_room_links" ADD CONSTRAINT "floorplan_room_links_to_room_id_fkey"
  FOREIGN KEY ("to_room_id") REFERENCES "floorplan_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
