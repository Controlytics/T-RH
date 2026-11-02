-- TCP/IP (MODBUS) INSTRUMENTS, change request CR-1 (operator, 2026-11-02): the
-- Modbus Slave ID (unit ID) and the "Read every" interval belong to each
-- INSTRUMENT, not to its profile. The profile only says Gateway or TCP/IP.
-- Spec: docs/superpowers/specs/2026-10-31-tcpip-instruments-design.md
--
-- Hand-authored, in three steps, data moved BEFORE the profile columns go:
--   1. two nullable columns on `instruments` (NULL on every Gateway-profile
--      instrument, as the address columns are);
--   2. every instrument of a TCP/IP profile takes its profile's values, copied
--      as stored — a profile value the Reader refused (a hand-edited unit ID of
--      300) stays refused on the instrument rather than being silently replaced
--      by a default the operator never chose;
--   3. the two profile columns are dropped.
--
-- Nothing else: no DROP of the partitioned instrument_telemetry_history (Prisma
-- cannot see it), no audit-chain or FK noise.

ALTER TABLE "instruments"
  ADD COLUMN "modbus_unit_id" INTEGER,
  ADD COLUMN "modbus_interval_sec" INTEGER;

UPDATE "instruments" AS i
   SET "modbus_unit_id" = p."modbus_unit_id",
       "modbus_interval_sec" = p."modbus_interval_sec"
  FROM "instrument_profiles" AS p
 WHERE i."profile_id" = p."id"
   AND p."connection" = 'MODBUS_TCP';

ALTER TABLE "instrument_profiles"
  DROP COLUMN "modbus_interval_sec",
  DROP COLUMN "modbus_unit_id";
