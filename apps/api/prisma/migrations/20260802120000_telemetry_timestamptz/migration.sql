-- Telemetry timestamps: TIMESTAMP -> TIMESTAMPTZ.
--
-- The original telemetry migration used TIMESTAMP(3) (without time zone). All
-- telemetry access is raw SQL, and a naive column leaves the write and read
-- paths free to disagree by the server's UTC offset. Found in the browser: a
-- reading published seconds earlier rendered with a NEGATIVE age of -19790s,
-- i.e. 5h30m in the future — exactly Asia/Kolkata's offset.
--
-- On a UTC host this is invisible, which is what makes it dangerous. The
-- deployment target is ap-south-1 (IST), so every telemetry timestamp on a
-- regulated system would have been wrong by 5.5 hours while every test passed.
--
-- audit_trail already uses `timestamp with time zone` for exactly this reason;
-- telemetry now matches it.
--
-- RECREATE rather than ALTER: `ts` is the partition key, and PostgreSQL refuses
-- to change the type of a column the table is partitioned by. Safe here because
-- the feature is unreleased — these tables were created in the immediately
-- preceding migration and no deployed environment has ever written to them.

DROP TABLE IF EXISTS "instrument_telemetry_history" CASCADE;
DROP TABLE IF EXISTS "instrument_telemetry_latest";
DROP TABLE IF EXISTS "dead_letters";

CREATE TABLE "instrument_telemetry_latest" (
  "instrument_id" TEXT NOT NULL,
  "key"           TEXT NOT NULL,
  "value"         JSONB NOT NULL,
  "value_type"    TEXT NOT NULL,
  "quality"       TEXT,
  "ts"            TIMESTAMPTZ(3) NOT NULL,
  "received_at"   TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "instrument_telemetry_latest_pkey" PRIMARY KEY ("instrument_id","key")
);
CREATE INDEX "instrument_telemetry_latest_instrument_id_idx"
  ON "instrument_telemetry_latest"("instrument_id");

CREATE TABLE "instrument_telemetry_history" (
  "instrument_id" TEXT NOT NULL,
  "key"           TEXT NOT NULL,
  "value"         JSONB NOT NULL,
  "value_type"    TEXT NOT NULL,
  "quality"       TEXT,
  "ts"            TIMESTAMPTZ(3) NOT NULL,
  "received_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "instrument_telemetry_history_pkey"
    PRIMARY KEY ("instrument_id","key","ts")
) PARTITION BY RANGE ("ts");

CREATE INDEX "instrument_telemetry_history_lookup_idx"
  ON "instrument_telemetry_history"("instrument_id","key","ts" DESC);

-- Partition bounds are now timestamptz. They are written as explicit UTC
-- instants so the boundaries do not shift with the server's timezone — a
-- bare '2026-08-01' would be interpreted in TimeZone and put the month edge
-- 5.5 hours out in IST.
CREATE TABLE "instrument_telemetry_history_2026_08" PARTITION OF "instrument_telemetry_history"
  FOR VALUES FROM ('2026-08-01T00:00:00Z') TO ('2026-09-01T00:00:00Z');
CREATE TABLE "instrument_telemetry_history_2026_09" PARTITION OF "instrument_telemetry_history"
  FOR VALUES FROM ('2026-09-01T00:00:00Z') TO ('2026-10-01T00:00:00Z');

CREATE TABLE "dead_letters" (
  "id"           TEXT NOT NULL,
  "protocol_key" TEXT NOT NULL,
  "topic"        TEXT NOT NULL,
  "payload"      TEXT NOT NULL,
  "reason"       TEXT NOT NULL,
  "detail"       TEXT,
  "received_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at"  TIMESTAMPTZ(3),
  "resolved_by"  TEXT,
  CONSTRAINT "dead_letters_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "dead_letters_received_at_idx" ON "dead_letters"("received_at");
CREATE INDEX "dead_letters_resolved_at_idx" ON "dead_letters"("resolved_at");
