-- One ACTIVE sensor-range alarm per instrument PER METRIC.
--
-- A SEPARATE migration from the enum value on purpose: Postgres refuses to use a
-- newly added enum value in the same transaction that added it.
--
-- ON (instrument_id, metric), like `alarms_active_rs485_unique` and unlike
-- `alarms_active_inactivity_unique`: a saturated temperature probe and a
-- saturated humidity probe on one logger are independent faults and must hold
-- two open alarms at once.
--
-- PARTIAL. Prisma cannot express a partial unique index, so this is hand-authored
-- and `prisma migrate diff` will propose dropping it — do not accept that.

CREATE UNIQUE INDEX IF NOT EXISTS "alarms_active_sensor_range_unique"
  ON "alarms" ("instrument_id", "metric")
  WHERE "state" = 'ACTIVE' AND "source" = 'SENSOR_RANGE';
