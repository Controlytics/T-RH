-- Instrument Profiles: a named container for instruments.
--
-- HAND-AUTHORED. `prisma migrate diff` was used to check this against the
-- datamodel, but its output could not be used verbatim — it carried three
-- changes that have nothing to do with this feature and must not ship:
--
--   1. `ALTER TABLE audit_trail ALTER COLUMN chain_position DROP NOT NULL`
--      — the pg_dump baseline models chain_position as BIGSERIAL, which the
--      datamodel cannot express. Applying it would weaken the tamper-evident
--      audit chain (21 CFR 11.10(e)).
--   2. `DROP TABLE instrument_telemetry_history` — that table exists in the
--      database with rows in it but is absent from schema.prisma. Pre-existing
--      drift; dropping it would destroy data this migration has no business
--      touching.
--   3. Drop-and-re-add of instrument_credentials' FK — pure churn, no net change.
--
--   4. And its `ADD COLUMN "profile_id" TEXT NOT NULL` would simply FAIL: the
--      table is populated and the column has no default. Hence the three-step
--      add/backfill/constrain below.

CREATE TABLE "instrument_profiles" (
    "id"          TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "description" TEXT,
    "is_active"   BOOLEAN NOT NULL DEFAULT true,
    "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMPTZ(3) NOT NULL,
    "created_by"  TEXT,
    "updated_by"  TEXT,

    CONSTRAINT "instrument_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "instrument_profiles_name_key" ON "instrument_profiles"("name");

-- Every instrument registered before profiles existed lands here. Created
-- unconditionally, even on a fresh install with no instruments: a new
-- deployment then has somewhere to put its first instrument without an admin
-- having to invent a profile before they can begin.
INSERT INTO "instrument_profiles" ("id", "name", "description", "updated_at")
VALUES (
    gen_random_uuid()::text,
    'Default',
    'Instruments registered before profiles existed',
    CURRENT_TIMESTAMP
);

-- Nullable first — a NOT NULL column cannot be added to a populated table
-- without a default, and a default here would linger as a silent fallback long
-- after the backfill it existed for.
ALTER TABLE "instruments" ADD COLUMN "profile_id" TEXT;

UPDATE "instruments"
   SET "profile_id" = (SELECT "id" FROM "instrument_profiles" WHERE "name" = 'Default')
 WHERE "profile_id" IS NULL;

ALTER TABLE "instruments" ALTER COLUMN "profile_id" SET NOT NULL;

-- RESTRICT, deliberately: deleting a profile must never destroy registered
-- devices, and must never leave an instrument without a profile. This is what
-- makes the "move or delete its instruments first" rule an invariant of the
-- database rather than a check some future endpoint might forget.
ALTER TABLE "instruments"
    ADD CONSTRAINT "instruments_profile_id_fkey"
    FOREIGN KEY ("profile_id") REFERENCES "instrument_profiles"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "instruments_profile_id_idx" ON "instruments"("profile_id");
