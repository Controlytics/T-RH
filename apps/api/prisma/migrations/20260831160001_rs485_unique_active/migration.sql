-- One ACTIVE RS485 alarm per instrument PER METRIC.
--
-- A SEPARATE migration from the enum value on purpose: Postgres refuses to use a
-- newly added enum value in the same transaction that added it ("unsafe use of
-- new value ... of enum type"). Splitting them is the documented way round it,
-- not an accident of authoring.
--
-- ON (instrument_id, metric), NOT on instrument_id alone as the inactivity index
-- is. A failed temperature probe and a failed humidity probe on one logger are
-- two independent faults and must be able to hold two open alarms at once —
-- that is the behaviour this feature was asked for. Indexing the instrument
-- alone would let the first failure block the second from ever being recorded.
--
-- PARTIAL, mirroring `alarms_active_instrument_limit_unique` and
-- `alarms_active_inactivity_unique`: many CLEARED rows for one instrument are
-- legitimate, one per failure. Prisma cannot express a partial unique index, so
-- this is hand-authored and `prisma migrate diff` will propose dropping it — do
-- not accept that.
--
-- This is the real guard against two overlapping evaluation passes opening the
-- same failure: a pass reads its open set once and cannot see a row another
-- process inserts mid-cycle. The worker catches P2002 and treats it as "somebody
-- else already opened this one", which is a success for the system.

CREATE UNIQUE INDEX IF NOT EXISTS "alarms_active_rs485_unique"
  ON "alarms" ("instrument_id", "metric")
  WHERE "state" = 'ACTIVE' AND "source" = 'RS485_FAILURE';
