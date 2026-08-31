-- One ACTIVE inactivity alarm per instrument.
--
-- A SEPARATE migration from the enum value on purpose: Postgres refuses to use a
-- newly added enum value in the same transaction that added it ("unsafe use of
-- new value ... of enum type"). Splitting them is the documented way round it,
-- not an accident of authoring.
--
-- PARTIAL, mirroring `alarms_active_instrument_limit_unique`: many CLEARED rows
-- for one instrument are legitimate, one per outage. Prisma cannot express a
-- partial unique index, so this is hand-authored and `prisma migrate diff` will
-- propose dropping it — do not accept that.
--
-- This is the real guard against two overlapping evaluation passes opening the
-- same outage: the pass reads its open set once and cannot see a row another
-- process inserts mid-cycle. The worker catches P2002 and treats it as "somebody
-- else already opened this one", which is a success for the system.

CREATE UNIQUE INDEX IF NOT EXISTS "alarms_active_inactivity_unique"
  ON "alarms" ("instrument_id")
  WHERE "state" = 'ACTIVE' AND "source" = 'INACTIVITY';
