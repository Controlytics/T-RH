# Queue cut-over runbook — BullMQ → graphile-worker

> Phase 2 of the windows-friendly-rewrite eliminates Memurai/Redis from the
> production Windows stack. This runbook is the prod-side cut-over sequence
> after `feature/phase2-pg-queue` merges. Tasks 2.1–2.8 are flag-gated;
> Task 2.10 deletes the legacy code.

## Pre-cut-over checks

Before flipping the flag on a deployed environment:

1. **Test DB exists and is reachable.** graphile-worker installs its schema in
   the `DATABASE_URL_QUEUE` (defaults to `DATABASE_URL`) database under the
   `graphile_worker` schema. On Windows-local: `digilog_db` works. Verify:
   ```
   psql -U digilog -h localhost -d digilog_db -c "SELECT 1"
   ```

2. **`packages/queue/crontab.txt` is on the production filesystem** at the
   path `app.ts` resolves it to (`<repo-root>/packages/queue/crontab.txt`),
   OR the `MAINTENANCE_CRONTAB_PATH` env var points elsewhere. Without it,
   the maintenance cron schedule won't load and DLQ/connectivity/retention
   never run.

3. **Workspace dist/ is built.** Tests + the runner import from
   `@digilog/queue` (resolves to `packages/queue/dist/index.js`). On a fresh
   checkout the dists may be empty. From repo root:
   ```
   npx tsc -p packages/queue/tsconfig.json
   npx tsc -p packages/db/tsconfig.json
   npx tsc -p packages/shared/tsconfig.json
   ```

4. **`USE_PG_QUEUE` defaults to `false`.** Verify the running process's env:
   no flag set = BullMQ path. No accidental early cut-over.

## Cut-over sequence

1. **Set the flag in `apps/api/.env`:**
   ```env
   USE_PG_QUEUE=true
   ```
   (`MAINTENANCE_CRONTAB_PATH` is optional; only set if the default
   `<repo-root>/packages/queue/crontab.txt` won't work.)

2. **Restart the API.** `tsx watch` will reload on env change but the
   workers boot in the startup section, so a clean restart is safer than
   a hot reload. Watch the logs for:
   ```
   graphile-worker job runner started (USE_PG_QUEUE=true)
   ```
   instead of the prior:
   ```
   Ingestion worker started
   Maintenance worker started
   ```

3. **Drain BullMQ in Redis.** Existing in-flight BullMQ jobs are not
   migrated — they finish out in the BullMQ worker that already started
   at boot (the BullMQ workers are in-process — they won't pick up new
   jobs after the API restarts in PG-queue mode, but they will finish
   what was already on `bull:ingestion:active`/`bull:ingestion:waiting`
   before shutdown was triggered).

   Wait for these queue lengths to reach 0 before killing Memurai:
   ```
   redis-cli -p 6379 XLEN bull:ingestion:wait
   redis-cli -p 6379 XLEN bull:notification:wait
   redis-cli -p 6379 XLEN bull:maintenance:wait
   ```

   If anything remains beyond a few minutes, `processIngestionMessage`
   may have a hang. Investigate before proceeding.

4. **Verify graphile-worker is processing.** From the same DB:
   ```sql
   SELECT id, task_identifier, last_error, attempts, locked_at, created_at
   FROM graphile_worker.jobs
   ORDER BY created_at DESC
   LIMIT 20;
   ```
   You should see `task_identifier` rows for `ingestion`,
   `dlq_check`, `connectivity_check`, `retention_cleanup` (the latter
   only after 02:00 daily).

   The cron triggers come from the `crontab` text loaded at runner boot.
   If `dlq_check` and `connectivity_check` aren't appearing every minute
   in `graphile_worker.jobs`, the crontab path resolved wrong — fix
   `MAINTENANCE_CRONTAB_PATH` and restart the API.

5. **Smoke-test each queue type** by exercising real producers:

   - **ingestion** — publish one MQTT telemetry message with a known
     entity. Watch for the message's `entityId` showing up in
     `digilog_tsdb.ts_telemetry`. The graphile-worker job should
     complete in a few hundred milliseconds.

   - **notification** — trigger a rule chain that emits a notification
     (or push an `ALARM` messageType through ingestion). The job lands
     in `graphile_worker.jobs` with `task_identifier='notification'`
     but **stays unprocessed** because the codebase has no
     `notificationTask` handler today (acknowledged limitation; will be
     added in a future phase). For pre-Task-2.10 cut-over, this is
     functionally equivalent to the BullMQ path — neither dequeues
     notification jobs today.

   - **dlq_check** — wait 60 s, then query
     `SELECT * FROM graphile_worker.jobs WHERE task_identifier='dlq_check' ORDER BY created_at DESC LIMIT 1`.
     `attempts` should be `1`, `last_error` `null`, the job marked
     completed (deleted on success).

   - **connectivity_check** — same as dlq_check, every 60 s.

   - **retention_cleanup** — only fires at 02:00 local time. To smoke-
     test, manually enqueue with `quickAddJob` from a Node REPL or
     temporarily change `crontab.txt` to fire it on a near-future
     minute. Revert immediately after.

6. **Stop Memurai (Redis).** Once all the above checks pass:
   ```
   net stop Memurai
   ```
   Then verify the API still serves HTTP and the DLQ/connectivity cron
   jobs continue running (they don't depend on Redis anymore).

7. **Disable Memurai's auto-start.** Once you're confident the
   cut-over is stable (1–2 weeks):
   ```
   sc config Memurai start= disabled
   ```
   Memurai stays installed but inert. Task 2.10's branch will land
   shortly after to delete the BullMQ + ioredis deps and the
   `connection.bullmq.ts` shim.

## Rollback

If something blocks the cut-over (graphile-worker schema fails to install,
runner crashes, DLQ check never fires, etc.):

1. **Set `USE_PG_QUEUE=false`** in `apps/api/.env`. Restart the API.
2. **Restart Memurai:** `net start Memurai`. The API will boot the BullMQ
   workers as before.
3. **Drop the graphile_worker schema** if you want a clean retry:
   ```sql
   DROP SCHEMA IF EXISTS graphile_worker CASCADE;
   ```
   `runMigrations` reinstalls on the next `USE_PG_QUEUE=true` boot.
4. **Inspect the BullMQ Redis state.** During the failed cut-over,
   producers wrote to `graphile_worker.jobs`, NOT to Redis. So Redis
   queue depths should be at whatever they were pre-flag. If you see
   Redis queues growing again after rollback, the API is back on the
   BullMQ path correctly.

## Open issues / known gaps post-Task-2.8

These will be addressed before Task 2.10 closes the migration:

- **No `notificationTask` handler.** `enqueueNotificationJob` produces to
  the queue under both backends, but no worker dequeues. Pre-existing —
  the BullMQ path also produced into a black hole. Not a Phase-2 regression.
- **`graphile_worker.jobs` grows unbounded** until manually pruned. BullMQ's
  `removeOnComplete: { count: N }` had a built-in cap. graphile-worker
  deletes completed jobs by default but failed jobs accumulate in
  `graphile_worker.failed_jobs`. Add a quarterly purge query to ops:
  ```sql
  DELETE FROM graphile_worker.failed_jobs WHERE created_at < NOW() - INTERVAL '90 days';
  ```
- **Schema bootstrap is idempotent but slow on first run.** ~2 s. Boot
  log will show the delay before "graphile-worker job runner started".

## Reference: commits in `feature/phase2-pg-queue`

| SHA       | Task | Title                                                                |
|-----------|------|----------------------------------------------------------------------|
| `1451c35` | 2.1  | feat(queue): install graphile-worker + bootstrap test                |
| `88e04fc` | 2.1  | chore(queue): align vitest version + declare pg + wire test script   |
| `b1e35f8` | 2.2  | feat(queue): graphile-worker producer + runner factories             |
| `65d0c7c` | 2.2  | chore(queue): vitest singleFork pool + plan-doc fix-up               |
| `40f88e9` | 2.3  | feat(queue): migrate ingestion queue to graphile-worker              |
| `9c7d0b2` | 2.3  | fix(queue): address Task 2.3 review feedback before pattern replicates |
| `b389620` | 2.4  | feat(queue): migrate notification queue to graphile-worker           |
| `7762dfa` | 2.7  | feat(queue): migrate maintenance cron to graphile-worker             |
| `453a523` | 2.8  | feat(queue): single graphile-worker Runner for all task types        |

(Tasks 2.5 and 2.6 — export and reports queues — were no-ops: those queue
definitions exist in `packages/queue/src/queues.ts` but had zero producers
and zero consumers in the codebase. They will be removed entirely in Task
2.10 alongside the BullMQ + ioredis dep removal.)
