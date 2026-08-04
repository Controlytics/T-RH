-- apps/api/prisma/migrations/20260804120000_instruments_p1/migration.sql
CREATE TABLE "instruments" (
  "id"                    TEXT NOT NULL,
  "name"                  TEXT NOT NULL,
  "code"                  TEXT NOT NULL,
  "transport"             TEXT NOT NULL,
  "is_active"             BOOLEAN NOT NULL DEFAULT true,
  "instrument_type"       TEXT,
  "manufacturer"          TEXT,
  "model"                 TEXT,
  "serial_number"         TEXT,
  "description"           TEXT,
  "expected_interval_sec" INTEGER,
  "created_at"            TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMPTZ(3) NOT NULL,
  "created_by"            TEXT,
  CONSTRAINT "instruments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "instruments_code_key" ON "instruments"("code");

CREATE TABLE "instrument_credentials" (
  "id"            TEXT NOT NULL,
  "instrument_id" TEXT NOT NULL,
  "token_hash"    TEXT NOT NULL,
  "token_prefix"  TEXT NOT NULL,
  "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at"  TIMESTAMPTZ(3),
  "revoked_at"    TIMESTAMPTZ(3),
  CONSTRAINT "instrument_credentials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "instrument_credentials_instrument_id_fkey"
    FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE
);
CREATE INDEX "instrument_credentials_token_prefix_idx" ON "instrument_credentials"("token_prefix");
CREATE INDEX "instrument_credentials_instrument_id_idx" ON "instrument_credentials"("instrument_id");

-- Latest value per (instrument, key) — what the UI reads.
CREATE TABLE "instrument_telemetry_latest" (
  "instrument_id" TEXT NOT NULL,
  "key"           TEXT NOT NULL,
  "value"         JSONB NOT NULL,
  "value_type"    TEXT NOT NULL,
  "ts"            TIMESTAMPTZ NOT NULL,
  CONSTRAINT "instrument_telemetry_latest_pkey" PRIMARY KEY ("instrument_id","key")
);
CREATE INDEX "instrument_telemetry_latest_instrument_id_idx"
  ON "instrument_telemetry_latest"("instrument_id");

-- History: monthly range partitions. Prisma cannot express PARTITION BY, so this
-- is raw SQL. The primary key MUST contain "ts" — PostgreSQL requires a
-- partitioned table's PK to include every partition column.
CREATE TABLE "instrument_telemetry_history" (
  "instrument_id" TEXT NOT NULL,
  "key"           TEXT NOT NULL,
  "value"         JSONB NOT NULL,
  "value_type"    TEXT NOT NULL,
  "ts"            TIMESTAMPTZ NOT NULL,
  PRIMARY KEY ("instrument_id","key","ts")
) PARTITION BY RANGE ("ts");

CREATE INDEX "instrument_telemetry_history_lookup_idx"
  ON "instrument_telemetry_history"("instrument_id","key","ts" DESC);

-- NOT housekeeping: an insert whose ts falls outside every partition is
-- REJECTED ("no partition of relation ... found for row"), so without a future
-- partition ingestion stops dead at midnight on the 1st. Task 8 automates this.
CREATE TABLE "instrument_telemetry_history_2026_08" PARTITION OF "instrument_telemetry_history"
  FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');
CREATE TABLE "instrument_telemetry_history_2026_09" PARTITION OF "instrument_telemetry_history"
  FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');

CREATE TABLE "dead_letters" (
  "id"          TEXT NOT NULL,
  "instrument_id" TEXT,
  "transport"   TEXT NOT NULL,
  "reason"      TEXT NOT NULL,
  "raw_payload" TEXT,
  "received_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "dead_letters_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "dead_letters_received_at_idx" ON "dead_letters"("received_at");
