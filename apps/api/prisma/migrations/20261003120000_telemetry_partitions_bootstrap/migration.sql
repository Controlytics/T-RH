-- Telemetry partitions for the month this migration RUNS in and the three
-- after it (audit 2026-10-03, INGEST-2 / DATA-2).
--
-- `instrument_telemetry_history` is RANGE-partitioned by month and Postgres
-- REJECTS a row that falls outside every partition. The baseline instruments
-- migration created `2026_08` and `2026_09` by name, and the only other
-- creator was the 1st/15th cron (`telemetry_partition_maintenance`) with no
-- backfill — so a customer installed on, say, 2026-10-03 could not store a
-- single reading until 00:05 on the 15th, and only if the machine was up at
-- that minute. The API now also creates partitions at boot
-- (`ensurePartitionsAtBoot`); this migration covers the window between
-- `migrate deploy` and the first boot, and any install path that never boots
-- the API before a device talks to the broker.
--
-- Same SQL as `ensurePartitions()` in
-- apps/api/src/workers/telemetry-partition.worker.ts: UTC-anchored month
-- bounds (`+00`), CREATE TABLE IF NOT EXISTS so it is idempotent on a database
-- that already carries the months (the local dev and test databases do).
-- `now()` here is evaluation time, which is what we want — a migration that
-- named months would go stale the way the baseline's did.
DO $$
DECLARE
  m   timestamptz := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  i   int;
  nm  text;
  lo  timestamptz;
  hi  timestamptz;
BEGIN
  FOR i IN 0..3 LOOP
    lo := m + (i || ' month')::interval;
    hi := m + ((i + 1) || ' month')::interval;
    nm := 'instrument_telemetry_history_' || to_char(lo AT TIME ZONE 'UTC', 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF "instrument_telemetry_history" FOR VALUES FROM (%L) TO (%L)',
      nm,
      to_char(lo AT TIME ZONE 'UTC', 'YYYY-MM-DD') || ' 00:00:00+00',
      to_char(hi AT TIME ZONE 'UTC', 'YYYY-MM-DD') || ' 00:00:00+00'
    );
  END LOOP;
END $$;
