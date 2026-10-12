-- Indexes for the notification dispatcher's retry de-duplication lookup
-- (audit 2026-10-12 #9 follow-up).
--
-- A retried notification job asks "what has this event already delivered?" by
-- the event's dedup key, stored in the row's JSONB `metadata`:
--   ... WHERE metadata->>'dedupKey' = $1     (notification-dispatcher.ts)
-- Both tables only grow, so without these that is a sequential scan of every
-- notification ever sent, once per notification job.
--
-- EXPRESSION indexes, which Prisma's datamodel cannot express: a future
-- `prisma migrate diff` will propose DROPPING them — refuse, as for
-- `instruments_code_lower_unique`. The query must keep the exact expression
-- `metadata->>'dedupKey'`, or the planner will not use them (Prisma's JSON
-- `path` filter compiles to `#>` and would not).
--
-- HAND-AUTHORED; the DROP TABLE "instrument_telemetry_history" prisma emits is
-- stripped, as in every migration since 2026-08-08.
CREATE INDEX IF NOT EXISTS "notification_logs_dedup_key_idx"
  ON "notification_logs" ((metadata->>'dedupKey'));
CREATE INDEX IF NOT EXISTS "notifications_dedup_key_idx"
  ON "notifications" ((metadata->>'dedupKey'));
