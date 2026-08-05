-- Placement (spec D8) — free text, nullable, no backfill needed.
ALTER TABLE "instruments" ADD COLUMN "location" TEXT;
ALTER TABLE "instruments" ADD COLUMN "area"     TEXT;
ALTER TABLE "instruments" ADD COLUMN "block"    TEXT;

-- Gateway link. ON DELETE SET NULL implements spec D7 at the database level:
-- deleting a gateway unlinks its children, it never deletes them.
ALTER TABLE "instruments" ADD COLUMN "is_gateway" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "instruments" ADD COLUMN "gateway_id" TEXT;
ALTER TABLE "instruments"
  ADD CONSTRAINT "instruments_gateway_id_fkey"
  FOREIGN KEY ("gateway_id") REFERENCES "instruments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- An instrument cannot be its own gateway. The service layer enforces the two
-- richer invariants (a gateway has no parent; only a gateway may be a parent),
-- which a CHECK cannot express because they read another row.
ALTER TABLE "instruments"
  ADD CONSTRAINT "instruments_gateway_not_self" CHECK ("gateway_id" IS DISTINCT FROM "id");

-- Last-seen on the instrument (spec D9).
ALTER TABLE "instruments" ADD COLUMN "last_seen_at"  TIMESTAMPTZ(3);
ALTER TABLE "instruments" ADD COLUMN "last_seen_via" TEXT;

CREATE INDEX "instruments_gateway_id_idx" ON "instruments"("gateway_id");
CREATE INDEX "instruments_block_area_location_idx" ON "instruments"("block", "area", "location");
