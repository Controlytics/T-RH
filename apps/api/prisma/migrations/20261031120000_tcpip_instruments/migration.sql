-- TCP/IP (MODBUS) INSTRUMENTS (2026-10-31): a profile is either a Gateway profile
-- (readings pushed in, today's behaviour) or a TCP/IP profile (this server reads
-- the device over Modbus TCP).
-- Spec: docs/superpowers/specs/2026-10-31-tcpip-instruments-design.md §5
--
-- Hand-authored. Every existing profile becomes 'PUSH' (the column default), so
-- nothing changes for any current profile or instrument; the other five columns
-- are nullable and stay NULL until a TCP/IP profile / instrument is created.
-- `connection` is a validated string, not a Postgres enum (MODBUS_CONNECTIONS in
-- @digilog/shared), so the vocabulary can grow without a migration.
--
-- The partial unique index is the authority for "one device per host:port": a
-- race between two creates is closed by the database, not by a pre-check.
--
-- Nothing else: no DROP of the partitioned instrument_telemetry_history (Prisma
-- cannot see it), no audit-chain or FK noise.

ALTER TABLE "instrument_profiles" ADD COLUMN "connection" TEXT NOT NULL DEFAULT 'PUSH';
ALTER TABLE "instrument_profiles" ADD COLUMN "modbus_interval_sec" INTEGER;
ALTER TABLE "instrument_profiles" ADD COLUMN "modbus_unit_id" INTEGER;

ALTER TABLE "instruments" ADD COLUMN "modbus_host" TEXT;
ALTER TABLE "instruments" ADD COLUMN "modbus_port" INTEGER;
ALTER TABLE "instruments" ADD COLUMN "modbus_registers" JSONB;

CREATE UNIQUE INDEX "instruments_modbus_address_key" ON "instruments" ("modbus_host", "modbus_port") WHERE "modbus_host" IS NOT NULL;
