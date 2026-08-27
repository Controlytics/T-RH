-- Alarm webhook annunciator (2026-08-27).
-- Design: docs/superpowers/specs/2026-08-27-alarm-webhook-annunciator-design.md
--
-- HAND-WRITTEN. `prisma migrate diff` in this repo emits three DESTRUCTIVE statements
-- that are NOT part of this change and must never be committed:
--   1. DROP TABLE instrument_telemetry_history  (partitioned; Prisma reads it as stray)
--   2. ALTER audit_trail.chain_position DROP NOT NULL  (the §11 hash-chain position)
--   3. drop/recreate of an unchanged instrument_credentials FK
-- See 20260811120000_instrument_floorplans/migration.sql for the full account.

CREATE TABLE "alarm_webhook_targets" (
  "id"                   TEXT NOT NULL,
  "name"                 VARCHAR(200) NOT NULL,
  "description"          VARCHAR(500),
  "url"                  TEXT NOT NULL,
  "method"               VARCHAR(10) NOT NULL DEFAULT 'POST',
  "headers"              JSONB NOT NULL DEFAULT '{}',
  "content_type"         VARCHAR(100) NOT NULL DEFAULT 'application/json',
  "body_template"        TEXT NOT NULL,
  "success_regex"        TEXT,
  "timeout_ms"           INTEGER NOT NULL DEFAULT 5000,
  "fire_on_raised"       BOOLEAN NOT NULL DEFAULT true,
  "fire_on_cleared"      BOOLEAN NOT NULL DEFAULT true,
  "fire_on_acknowledged" BOOLEAN NOT NULL DEFAULT true,
  "severities"           JSONB,
  "cooldown_seconds"     INTEGER NOT NULL DEFAULT 0,
  "is_active"            BOOLEAN NOT NULL DEFAULT true,
  "scope_location_ids"   JSONB NOT NULL DEFAULT '[]',
  "scope_instrument_ids" JSONB NOT NULL DEFAULT '[]',
  "created_at"           TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMPTZ(3) NOT NULL,
  "created_by"           TEXT,
  "updated_by"           TEXT,
  CONSTRAINT "alarm_webhook_targets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "alarm_webhook_targets_is_active_idx" ON "alarm_webhook_targets"("is_active");

CREATE TABLE "alarm_webhook_deliveries" (
  "id"               TEXT NOT NULL,
  "target_id"        TEXT NOT NULL,
  "alarm_id"         TEXT,
  "event"            VARCHAR(20) NOT NULL,
  "url"              TEXT NOT NULL,
  "request_body"     TEXT NOT NULL,
  "http_status"      INTEGER,
  "response_snippet" VARCHAR(1000),
  "attempt"          INTEGER NOT NULL,
  "status"           VARCHAR(10) NOT NULL,
  "error"            TEXT,
  "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sent_at"          TIMESTAMPTZ(3),
  CONSTRAINT "alarm_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "alarm_webhook_deliveries_target_id_created_at_idx"
  ON "alarm_webhook_deliveries"("target_id", "created_at" DESC);
CREATE INDEX "alarm_webhook_deliveries_alarm_id_idx" ON "alarm_webhook_deliveries"("alarm_id");
CREATE INDEX "alarm_webhook_deliveries_status_idx" ON "alarm_webhook_deliveries"("status");

ALTER TABLE "alarm_webhook_deliveries"
  ADD CONSTRAINT "alarm_webhook_deliveries_target_id_fkey"
  FOREIGN KEY ("target_id") REFERENCES "alarm_webhook_targets"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "alarm_webhook_deliveries"
  ADD CONSTRAINT "alarm_webhook_deliveries_alarm_id_fkey"
  FOREIGN KEY ("alarm_id") REFERENCES "alarms"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
