-- Alarm notification events (project C4).
--
-- Adds ALARM_RAISED / ALARM_CLEARED to NotificationEventType so a notification rule can
-- target a limit excursion. DEVICE_OFFLINE already existed but says something different:
-- that the instrument stopped talking, not that it reported a value outside its limit.
--
-- HAND-AUTHORED. `prisma migrate diff` emitted three further statements, ALL of which are
-- deliberately omitted here — the same three it has emitted since 20260811120000, because
-- they describe objects managed out of band rather than real drift:
--
--   DROP TABLE "instrument_telemetry_history"
--     — partitioned, invisible to the datamodel, and holds live telemetry.
--   ALTER TABLE "audit_trail" ALTER COLUMN "chain_position" DROP NOT NULL
--     — the 21 CFR §11 hash-chain position, sequence-backed outside Prisma.
--   DROP/ADD CONSTRAINT "instrument_credentials_instrument_id_fkey"
--     — unchanged; a drop-and-recreate of an identical FK.
--
-- Read the header of 20260811120000_instrument_floorplans before regenerating anything here.
--
-- Two ADD VALUEs in one migration need PostgreSQL 12+; this deployment is 18. Neither new
-- value is USED in this migration, which is the case Postgres refuses inside a transaction.

ALTER TYPE "NotificationEventType" ADD VALUE 'ALARM_RAISED';
ALTER TYPE "NotificationEventType" ADD VALUE 'ALARM_CLEARED';
