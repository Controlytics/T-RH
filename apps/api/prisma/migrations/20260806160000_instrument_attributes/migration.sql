-- Free-form per-instrument attributes.
--
-- A child table rather than a JSONB column on `instruments`: the unique index
-- below is what makes "set this attribute" idempotent, and one row per fact is
-- what lets each change be audited individually by key (an attribute may hold a
-- calibration date, which is a 21 CFR §11 record).
--
-- ON DELETE CASCADE: an attribute has no meaning without its instrument, and an
-- orphan row would be unreachable through every endpoint that exists.
CREATE TABLE "instrument_attributes" (
    "id" TEXT NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "instrument_attributes_pkey" PRIMARY KEY ("id")
);

-- Cross-instrument lookup: "which devices carry a Calibration Due date?"
CREATE INDEX "instrument_attributes_key_idx" ON "instrument_attributes"("key");

CREATE UNIQUE INDEX "instrument_attributes_instrument_id_key_key" ON "instrument_attributes"("instrument_id", "key");

ALTER TABLE "instrument_attributes" ADD CONSTRAINT "instrument_attributes_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
