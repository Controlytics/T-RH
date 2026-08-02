-- Telemetry storage for the Data Injection layer (P2).
--
-- No foreign key from either telemetry table to "instruments". Same reasoning as
-- audit_trail: ON DELETE CASCADE would destroy recorded history when an
-- instrument is removed, and ON DELETE RESTRICT would make removal impossible.
-- "instrument_id" is a plain column; resolution happens at ingest.

-- Latest values: one row per (instrument, key). Hot path for the live panel.
CREATE TABLE "instrument_telemetry_latest" (
  "instrument_id" TEXT NOT NULL,
  "key"           TEXT NOT NULL,
  "value"         JSONB NOT NULL,
  "value_type"    TEXT NOT NULL,
  "quality"       TEXT,
  "ts"            TIMESTAMP(3) NOT NULL,
  "received_at"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "instrument_telemetry_latest_pkey" PRIMARY KEY ("instrument_id","key")
);
CREATE INDEX "instrument_telemetry_latest_instrument_id_idx"
  ON "instrument_telemetry_latest"("instrument_id");

-- History: monthly range partitions. Retention becomes a partition DROP rather
-- than a DELETE of millions of rows.
--
-- Prisma cannot express PARTITION BY, so the table is created here in raw SQL.
-- The model IS declared in schema.prisma — including the lookup index below —
-- so `migrate diff` proposes nothing and this adds no drift. Verified against a
-- scratch database 2026-08-02: the diff is byte-identical to the pre-existing
-- baseline.
--
-- The primary key MUST contain "ts": PostgreSQL requires a partitioned table's
-- primary key to include every partition column. A synthetic id would be
-- rejected outright.
CREATE TABLE "instrument_telemetry_history" (
  "instrument_id" TEXT NOT NULL,
  "key"           TEXT NOT NULL,
  "value"         JSONB NOT NULL,
  "value_type"    TEXT NOT NULL,
  "quality"       TEXT,
  "ts"            TIMESTAMP(3) NOT NULL,
  "received_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "instrument_telemetry_history_pkey"
    PRIMARY KEY ("instrument_id","key","ts")
) PARTITION BY RANGE ("ts");

CREATE INDEX "instrument_telemetry_history_lookup_idx"
  ON "instrument_telemetry_history"("instrument_id","key","ts" DESC);

-- Seed the current and next month so inserts work immediately.
--
-- This is not housekeeping. An insert whose ts falls outside every partition
-- does not degrade — it raises
--   ERROR: no partition of relation "instrument_telemetry_history" found for row
-- and the reading is rejected outright. Without a future partition, ingestion
-- stops at midnight on the 1st. The telemetry_partition_maintenance job (Task 12)
-- keeps this rolling forward and is a correctness requirement, not a nicety.
CREATE TABLE "instrument_telemetry_history_2026_08" PARTITION OF "instrument_telemetry_history"
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "instrument_telemetry_history_2026_09" PARTITION OF "instrument_telemetry_history"
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

-- Messages that could not be routed, resolved, parsed, or stored. Kept rather
-- than dropped so a misconfigured site is visible instead of silently lossy.
CREATE TABLE "dead_letters" (
  "id"           TEXT NOT NULL,
  "protocol_key" TEXT NOT NULL,
  "topic"        TEXT NOT NULL,
  "payload"      TEXT NOT NULL,
  "reason"       TEXT NOT NULL,
  "detail"       TEXT,
  "received_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at"  TIMESTAMP(3),
  "resolved_by"  TEXT,
  CONSTRAINT "dead_letters_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "dead_letters_received_at_idx" ON "dead_letters"("received_at");
CREATE INDEX "dead_letters_resolved_at_idx" ON "dead_letters"("resolved_at");
