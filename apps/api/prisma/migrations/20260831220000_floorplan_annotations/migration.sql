-- Floorplan annotation layer: what a DRAWING carries that a generated plan does not.
--
-- Two nullable JSONB columns, no new model and no new enum — the same shape as
-- the `doors` and `grade` additions (20260824100000, 20260824140000) and for the
-- same reason: a drawing's vocabulary grows, and a migration per annotation kind
-- is a tax on transcribing one.
--
--   floorplan_rooms.meta   {fill, fch, dims} — the room's drawn fill colour, its
--                          finished ceiling height and its floor dimensions, all
--                          free text because they are transcribed, not computed.
--   floorplans.annotations {equipment, hvac, water, airflow, labels} — everything
--                          on the plan that is not a room, each with coordinates
--                          normalized 0..1 against the plan, the same convention
--                          as floorplan_rooms.x/y/w/h.
--
-- Both NULL for every existing row, and NULL renders exactly as the plan rendered
-- before this migration. No backfill: a generated plan has no drawing to
-- transcribe, and inventing annotations for one would be inventing floor content.
--
-- HAND-AUTHORED. `prisma migrate diff` also emits
--   DROP TABLE "instrument_telemetry_history";
-- which is STRIPPED here, as in the fifteen migrations before it: that table is
-- partitioned, invisible to the datamodel, and holds live telemetry. See
-- apps/api/src/lib/migration-guard.ts, which fails the build if it comes back.

ALTER TABLE "floorplan_rooms" ADD COLUMN "meta" JSONB;
ALTER TABLE "floorplans" ADD COLUMN "annotations" JSONB;
