# Code Review — Data Layer / Queue / Prisma Schema / Migrations

- **Date:** 2026-05-04
- **Branch / worktree:** `feature/phase5-verification` @ `.worktrees/phase5-verification`
- **Reviewer:** Senior Code Reviewer (adversarial pass)
- **Scope:**
  - `packages/db/src/` — Prisma wrapper, TimescaleDB pool, telemetry batcher
  - `packages/queue/src/` — graphile-worker producer / runner / queues / schemas
  - `apps/api/prisma/schema.prisma` (+ `sql/invariants.sql`)
  - `apps/api/prisma/migrations/` (esp. `20260503162127_capture_schema_vs_db_drift`)
  - `apps/api/prisma/seed.ts`
  - `init-tsdb.sql`

## 0. Live count verification

The review prompt cited **64 models / 22 enums / 7 hypertables / 5 queues** — every one of those is stale. Verified against live code today:

| Claim | Prompt | Worktree CLAUDE.md | Code (truth) |
|---|---|---|---|
| Prisma models  | 64 | 69 | **69** (`grep -cE "^model " apps/api/prisma/schema.prisma`) |
| Prisma enums   | 22 | 23 | **23** (`grep -cE "^enum " ...`) |
| TS hypertables | 7  | 7  | **6** (`grep -cE "create_hypertable" init-tsdb.sql`: ts_telemetry, ts_attributes, ts_checklist_responses, ts_device_events, ts_binary_data, ts_pipeline_traces) |
| Queues         | 5  | 3  | **3** in `packages/queue/src/queues.ts` (INGESTION, NOTIFICATION, MAINTENANCE); export/reports schemas exist but no QUEUES entry |

Doc drift on hypertables (worktree CLAUDE.md, root CLAUDE.md, apps/api/CLAUDE.md, OFFLINE_SYNC_ARCHITECTURE.md, et al. all repeat "7 hypertables") is itself a Low/doc finding — see L4.

---

## CRITICAL

### C1 — Drift migration silently destroys data on populated DBs without manual intervention
**File:** `apps/api/prisma/migrations/20260503162127_capture_schema_vs_db_drift/migration.sql:107-112, 144-152`

```sql
ALTER TABLE "asset_instances" DROP COLUMN "current_cycle_id",
DROP COLUMN "current_lifecycle_state",
DROP COLUMN "filter_profile_id",
DROP COLUMN "filter_set",
DROP COLUMN "organization_id";
...
ALTER TABLE "filter_cleaning_profiles" DROP COLUMN "organization_id",
ADD COLUMN "lineage_id" UUID NOT NULL;   -- no DEFAULT, no DO/UPDATE backfill
```

The migration **drops the four filter-state columns from `asset_instances` without copying them into the new `filter_details` sidecar**, and **adds `filter_cleaning_profiles.lineage_id NOT NULL` with no default and no backfill block**. The header comment correctly warns that operators must manually `prisma migrate resolve --applied` and hand-edit the migration before any populated-DB deploy — but **the migration itself does not enforce this**. A junior operator running `npx prisma migrate deploy` against the staging DB, the local dev DB, or a customer's restored backup will:

1. Hit the `lineage_id NOT NULL` failure (loud — recoverable), or
2. If they bypass that, **lose every in-progress filter cycle linkage and lifecycle state** (silent — unrecoverable).

The drift migration also drops indexes and FKs (`asset_instances_current_cycle_id_fkey`, `asset_instances_filter_profile_id_fkey`) before the data is moved — there is no two-pass safe ordering and no transaction.

**Fix:** Wrap in a `DO $$ BEGIN … END $$` that:
1. Inserts a `filter_details` row per `asset_instances` row whose `template_kind = 'FILTER'`, copying the four filter-state columns.
2. Generates `lineage_id = id` (default to row's own UUID) for every existing `filter_cleaning_profiles` row before the `NOT NULL` is enforced — `ALTER TABLE … ADD COLUMN lineage_id UUID; UPDATE … SET lineage_id = id; ALTER TABLE … ALTER COLUMN lineage_id SET NOT NULL;`.
3. Add a guard at the top: `RAISE EXCEPTION` if any `asset_instances.current_cycle_id IS NOT NULL` and the corresponding `filter_details` row is missing.

If the team's stance is "this migration ships as-is, operators must hand-port" — at minimum the file needs an `ABORT;` as line 1 unless an env variable like `ALLOW_DRIFT_MIGRATION=1` is set, so accidental deploys fail fast instead of corrupting silently.

---

### C2 — DB invariants live in `seed.ts` instead of a migration → fresh `migrate deploy` produces a corruption-prone DB
**Files:** `apps/api/prisma/seed.ts:12-38`, `apps/api/prisma/sql/invariants.sql:1-114`

`invariants.sql` carries three production-critical guards that **Prisma cannot express**:

1. `idx_cleaning_cycles_one_in_progress_per_filter` — partial unique index preventing two IN_PROGRESS cycles on the same filter (the comment in the file explicitly calls the transactional re-check in `startCycle` "belt" and this index "suspenders").
2. `trg_filter_event_consistency` — BEFORE INSERT/UPDATE trigger ensuring `FilterEvent.filter_id` matches `cleaning_cycles.filter_id` for the cycle. Catches cross-filter event leakage post Step-6 split.
3. `trg_asset_relationship_pair` — DEFERRED constraint trigger enforcing the bidirectional pair invariant (every `(A→B, CONTAINS)` requires `(B→A, CONTAINED_IN)`).

These are applied **only by `prisma db seed`**. A standard production cutover uses `prisma migrate deploy` (no seed step in 21 CFR Part 11 guidance — seeded users would defeat audit). Result: **deployed DBs ship without the invariants** and rely entirely on application-layer code to maintain them. Combined with C1 (seed.ts is also where INITIAL_ADMIN_PASSWORD lives — see C4), an operator who follows `DEPLOY-WINDOWS.md` literally and skips seed in production gets a DB where two cycles can be IN_PROGRESS on the same filter.

**Fix:** Move `apps/api/prisma/sql/invariants.sql` into a Prisma migration (`apps/api/prisma/migrations/20260504000000_apply_invariants/migration.sql`). Mark it idempotent via `IF NOT EXISTS` / `CREATE OR REPLACE` (already correctly written). Keep `applyInvariants()` in seed for the dev `db push` flow, but it should no longer be the only path.

---

### C3 — Wholesale FK absence — ~140 UUID columns with no Prisma `@relation`
**File:** `apps/api/prisma/schema.prisma`

Counts: 176 `@db.Uuid` columns vs 69 `@relation` declarations (and ~half of those are bidirectional pair sides — so roughly 35 actual FK pairs). Compliance-critical relationships are bare strings:

| Bare UUID column                              | Should reference          | Risk |
|---|---|---|
| `CleaningCycle.filterId`                      | `AssetInstance(id)`       | Orphaned cycles when filter deleted |
| `CleaningCycle.ahuId`                         | `AssetInstance(id)`       | Same |
| `CleaningCycle.cleaningAreaId`                | `AssetInstance(id)` (block) | Same |
| `CleaningCycle.pmExecutionId`                 | `PmExecution(id)`         | Orphan link to PM history |
| `FilterEvent.filterId`                        | `AssetInstance(id)`       | Orphan compliance events (only soft-checked by `trg_filter_event_consistency`, see C2) |
| `FilterEvent.equipmentId`                     | `AssetInstance(id)`       | Orphan |
| `FilterEvent.blockId`                         | `AssetInstance(id)`       | Orphan |
| `BlockChangeRequest.filterId / fromBlockId / toBlockId` | `AssetInstance(id)` | Orphan request rows after asset deletion |
| `RuleChain.firstRuleNodeId`                   | `RuleNode(id)`            | Dangling start-node ref |
| `Alarm.entityId / createdByRuleChain`         | `AssetInstance(id) / RuleChain(id)` | Orphan alarms |
| `LatestTelemetry.entityId`                    | `AssetInstance(id)`       | Stale cache rows |
| `UnsMapping.entityId`                         | `AssetInstance(id)`       | Orphan UNS path (the user-memory record `project_orphan_uns_mapping_cwhf0500` documents this exact failure mode) |
| `DeviceCredential.entityId`                   | `AssetInstance(id)`       | Orphan credentials |
| `ConnectivityStatus.entityId`                 | `AssetInstance(id)`       | Orphan |
| `QrCode.entityId`                             | `AssetInstance(id)`       | Orphan |
| `DataStream.entityId`                         | `AssetInstance(id)`       | Orphan |
| `DeadLetterQueue.entityId`                    | `AssetInstance(id)`       | Orphan |
| `AuditTrail.userId / sessionId / targetId`    | (intentionally string?)   | Acceptable if intentional — flag for audit-trail immutability requirement |
| `EquipmentGroupVersion.createdBy`             | `User(id)`                | Orphan version author |
| `Notification.targetUserId / forUserId`       | `User(id)` (currently VarChar) | Orphan |

**Why this is critical, not just hygiene:** the dynamic backup/restore flow described in `feedback_role_perms_after_restore.md` and `project_dynamic_backup.md` claims a "two-pass fixup for self-referential FKs". If the FKs aren't declared, the restore can't even *detect* dangling references — and the 21 CFR Part 11 audit trail is built on `FilterEvent → CleaningCycle → AssetInstance` traversal that has no schema-level integrity guarantee.

**Fix:** Audit each bare UUID column. For mutable references (LatestTelemetry, ConnectivityStatus, DataStream): cascade-delete. For compliance/audit references (FilterEvent, AuditTrail): `onDelete: Restrict`, force soft-delete on parents. Document the few that are intentional bare strings (e.g., `AuditTrail.userId` may stay as VarChar because users can be hard-deleted but trail must outlive them).

---

### C4 — Seed depends on env var that the docs claim has a hardcoded default
**Files:** `apps/api/prisma/seed.ts:222-262`, root `CLAUDE.md` "Default Login" section

```ts
const defaultPassword = process.env.INITIAL_ADMIN_PASSWORD;
if (!defaultPassword) {
  throw new Error('FATAL: INITIAL_ADMIN_PASSWORD env var must be set for seeding. Cannot use hardcoded default.');
}
```

Both root `CLAUDE.md` and worktree `CLAUDE.md` "Default Login" sections still say:
> **Username:** `superadmin` / **Password:** `Admin@123` (forced change on first login)

A new dev cloning the repo and following the docs runs `npm run prisma:seed`, gets a `FATAL` throw, and bounces. The seed is correct (no hardcoded default in production); the **docs are wrong**. Consequences: every onboarding cycle wastes ~30 min, every Windows-stack verification harness (Phase 5.1/5.2) has to re-establish credentials, and the friction encourages people to put a hardcoded password back in.

**Fix:** Either (a) restore a documented dev-only default behind `if (process.env.NODE_ENV !== 'production')` and write `Admin@123` literally in seed, *or* (b) update both CLAUDE.mds and `LOCAL_SETUP_WINDOWS.md` to say "set `INITIAL_ADMIN_PASSWORD=Admin@123` before seeding" and remove the "Default Login" claim. (a) matches the docs and the user memory — (b) tightens security but requires a doc sweep.

---

## HIGH

### H1 — `QUEUES.*.defaultJobOptions` are partially fictional under graphile-worker
**Files:** `packages/queue/src/queues.ts:1-30`, `apps/api/src/modules/data-ingestion/ingestion.service.ts:72-115`

```ts
QUEUES.INGESTION = {
  name: 'ingestion',
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 500 },   // ← BullMQ shape, NOT read by graphile-worker
    removeOnComplete: 100,                          // ← Same
    removeOnFail: 1000,                             // ← Same
  },
}
```

Verified: ingestion.service.ts reads only `.attempts` and forwards as `addJob(... { maxAttempts })`. The other three fields are **dead BullMQ leftovers** from the Phase 2 graphile-worker swap. Implications:

- **`backoff`**: graphile-worker uses its own retry schedule (default exponential with `task_min_seconds_between_retries` + jitter) and does NOT honour a per-job backoff config the way BullMQ does. The 500ms exponential ramp the constants advertise is never applied.
- **`removeOnComplete: 100` / `removeOnFail: 1000`**: graphile-worker stores completed jobs in `graphile_worker._private_jobs` and cleans via the `cleanup()` cron — these counts are not honoured. **The maintenance crontab does not include any cleanup job** (see `crontab.txt`: only `dlq_check`, `connectivity_check`, `retention_cleanup`). The `graphile_worker._private_jobs` table grows unbounded under failure scenarios.

**Fix:** Either delete the dead fields and document that graphile-worker handles retries / cleanup natively, or wire them through `getProducer().addJob(name, payload, {maxAttempts, priority, jobKey, runAt})` and ship a periodic `VACUUM / DELETE FROM graphile_worker._private_jobs WHERE …` job. Audit task `tasks/AUDIT-2026-05-04-linkage-review.md` does not appear to cover this surface.

---

### H2 — Crontab schedules `dlq_check` and `connectivity_check` every minute with no overlap protection
**File:** `packages/queue/crontab.txt:4-6`

```
* * * * * dlq_check
* * * * * connectivity_check
0 2 * * * retention_cleanup
```

graphile-worker's crontab does NOT skip a tick if the previous run is still executing (it uses `addJob` per scheduled time, not "skip if running"). If `dlq_check` ever takes >60s on a backlog (re-running every failed message), the queue accumulates jobs faster than they drain, creating a feedback loop that blocks `connectivity_check` and `ingestion` from running because the runner concurrency (10) is consumed by stuck dlq_checks.

**Fix:** Use a `jobKey` derived from the cron tick (`dlq_check_${YYYYMMDDHHmm}`) so a queued duplicate becomes a no-op, OR use the `?max=1` modifier in graphile-worker crontab syntax to coalesce, OR convert these to in-process intervals with their own concurrency=1 mutex.

---

### H3 — Telemetry batcher requeue is O(n²)
**File:** `packages/db/src/telemetry-batcher.ts:110-114, 117-122, 162-165`

```ts
for (let i = rows.length - 1; i >= 0; i--) {
  telemetryBuffer.unshift(rows[i]);
}
```

For a flush failure with `batchSize=100` and `maxBufferSize=10_000`, requeue is 100×~5000 = 500k array shifts — fast. But under sustained TSDB outage the buffer fills to 10k; then the 10k requeue is 10k× O(n) unshifts ≈ 50M shifts on a single thread, blocking the event loop for **seconds**. Combined with the 1s default `flushIntervalMs`, the next interval tick fires before the previous requeue finishes, and the whole batcher stalls.

**Fix:**
```ts
telemetryBuffer.splice(0, 0, ...rows);   // single O(n) move
// or:
telemetryBuffer = rows.concat(telemetryBuffer);   // requires `let`
```

Same fix needed in `flushDeviceEvents`. The unit test currently passes because it never triggers the pathological case (mocks succeed; batches stay small).

---

### H4 — Telemetry batcher drops compliance data on backpressure with `console.warn` only
**File:** `packages/db/src/telemetry-batcher.ts:53-56, 67-71, 124, 174`

```ts
if (telemetryBuffer.length >= maxBufferSize) {
  const dropped = telemetryBuffer.splice(0, Math.floor(maxBufferSize * 0.1));
  console.warn(`[TelemetryBatcher] Buffer overflow — dropped ${dropped.length} oldest telemetry rows`);
}
```

There is **no audit trail, no DLQ, no Prometheus counter, no alarm**. A 21 CFR Part 11 deployment that loses 10% of historical telemetry rows because TSDB hiccupped is an undocumented compliance event. The `console.warn` ends up in PM2 / journald / a Windows Service log nobody reads.

**Fix:**
1. Insert dropped rows into `dead_letter_queue` (already exists — `DeadLetterQueue` model) with `messageType='telemetry_batch_overflow'`.
2. Increment a counter exposed via `/api/system-health` so operators can alarm on it.
3. Telemetry is append-only by design; if it can't be persisted, the device should be backpressured (return 503 on HTTP ingest, throttle MQTT) rather than dropping silently.

Same applies to `addDeviceEventRow`. Note that the comment in the file says "device events are connection history" — but `ts_device_events` includes `IP_MISMATCH` and `RATE_LIMITED` events, which ARE security-relevant and must not be silently dropped.

---

### H5 — Sidecar version race window is unenforced at the schema level
**Files:** `schema.prisma` lines 1382 (FilterProfile.version), 1553 (EquipmentGroup.version), 1640 (ChecklistProfile.version), 1316 (FilterCleaningProfile.version)

The Phase A.1–A.4 versioning pattern is **snapshot-then-bump in the same `$transaction`**. The schema enforces this with `@@unique([profileId, versionNumber])`, which catches *duplicate* writes but not *interleaving*:

- Tx A reads `version=5`, snapshots v5 to sidecar, prepares update to v6.
- Tx B reads `version=5`, snapshots v5 to sidecar (OK so far — `versionNumber=5` insert succeeds with same payload), prepares update to v6.
- Tx A commits — live row is v6.
- Tx B commits — live row is v6 *with B's payload, A's snapshot lost*. Whichever sidecar got inserted second wins the unique-constraint race; the other tx rolls back, but only *after* it has potentially returned `200 OK` to the user.

**Without explicit row-level locking (`SELECT … FOR UPDATE` on the live row in the same tx), the snapshot-then-bump pattern is racy.** Schema can't prevent it; only the service layer can. Out of review scope to verify the service layer, but this should be flagged for the original implementor — the schema invites a race.

**Fix:** Add a Phase 5b.6 invariant in `invariants.sql`:
```sql
-- Sidecar snapshot must always equal CURRENT live row version - 1 minimum.
-- Forces serialization via SERIALIZABLE isolation or SELECT FOR UPDATE.
```
Or add a CHECK trigger on `*_versions` insert that validates `version_number = (SELECT version - 1 FROM live_table WHERE id = NEW.profile_id)` after lock. Will reject racy commits.

---

### H6 — `filter_details.filterProfileId` and `currentCycleId` use `ON DELETE SET NULL`
**File:** `apps/api/prisma/migrations/20260503162127_capture_schema_vs_db_drift/migration.sql:427-430`

```sql
ALTER TABLE "filter_details" ADD CONSTRAINT "filter_details_filter_profile_id_fkey"
  FOREIGN KEY ("filter_profile_id") REFERENCES "filter_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "filter_details" ADD CONSTRAINT "filter_details_current_cycle_id_fkey"
  FOREIGN KEY ("current_cycle_id") REFERENCES "cleaning_cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

Cycles are immutable compliance data and shouldn't be deletable in the first place; the SET NULL is a fallback that masks a bug if it ever fires. More importantly: if a `FilterProfile` is deleted, the `filter_details.filterProfileId` silently becomes NULL — the live filter no longer knows which cleaning profile it had assigned, and the historical link is destroyed. Compare to the FilterCleaningProfile pattern (immutable lineage_id + version that survives deletion via the version sidecar).

**Fix:** `ON DELETE RESTRICT`. Filter profiles already have `isActive: false` for soft-delete; force operators to retire instead of hard-delete. Same for `cleaning_cycles` parent — server-side block all DELETEs and add a CHECK constraint preventing deletion when `status != 'TERMINATED'` (ideally never).

---

## MEDIUM

### M1 — Dead enum values in `DashboardScope` post-MT removal
**File:** `schema.prisma:14-18`

```prisma
enum DashboardScope {
  TENANT          // ← multi-tenant relic
  ORGANIZATION    // ← organization model deleted
  USER
}
```

`RoleScope` was correctly trimmed to `GLOBAL`-only in the drift migration; `DashboardScope` was not. `Dashboard.scope` defaults to `TENANT`, which now means nothing. Either drop the enum and use a boolean `isShared` or follow RoleScope's lead and trim to `USER`-only with a soft-default.

### M2 — Test fixture `tenantId` field doesn't exist in production code
**File:** `packages/db/src/__tests__/telemetry-batcher.test.ts:25, 49`

```ts
traceId: 'trace-abc-123', tenantId: null,
```

`tenantId` does not exist in the `TelemetryRow` interface (`telemetry-batcher.ts:3-15`) or the `INSERT INTO ts_telemetry` SQL (line 104). It's also not in `init-tsdb.sql` columns. Either the test is exercising a dead/removed field (MT removal aftermath) or the production code is missing a column. `process` continues because TypeScript object literals are structurally subtyped and excess properties are ignored by spread. Drop the dead field from the test.

### M3 — `getTsdbPool()` recreates pool on error but loses in-flight queries
**File:** `packages/db/src/tsdb.ts:26-30`

```ts
pool.on('error', (err) => {
  console.error('[TSDB] Unexpected pool error:', err.message);
  pool = null; // Force recreation on next getTsdbPool() call
});
```

Setting `pool = null` while the existing pool may still be holding open connections leaks them — `pg.Pool` doesn't auto-`.end()` when its module-level reference is dropped. Under repeated `error` events (TimescaleDB connection blip every few minutes), the process accumulates orphaned pools each owning up to 20 connections. PG ends up rejecting new connections with `too many clients already`.

**Fix:**
```ts
pool.on('error', async (err) => {
  console.error('[TSDB] Unexpected pool error:', err.message);
  const dyingPool = pool;
  pool = null;
  try { await dyingPool.end(); } catch { /* swallow */ }
});
```

### M4 — Telemetry batcher singleton blocks reuse + tests
**File:** `packages/db/src/telemetry-batcher.ts:33-49`

Module-level state (`pool`, `telemetryBuffer`, `flushTimer`, `isInitialized`) means the batcher is a process-wide singleton that **cannot be re-initialized with different settings without `closeTelemetryBatcher()` first** (line 36: `if (isInitialized) return;`). The test acknowledges this with `afterEach(closeTelemetryBatcher)`. In production, this means:

- A unit test can never run a batcher with two different configs in parallel.
- Hot-reload of `pipeline.telemetry_batch_size` config requires a process restart even though the doc says it's hot-reload.

**Fix:** Wrap state in a `class TelemetryBatcher` and instantiate once in `app.ts`. Pass instance to consumers via DI rather than module-level imports. (Larger refactor — flag for future work.)

### M5 — `DeadLetterQueue.entityId` is bare String, breaks orphan cleanup
**File:** `schema.prisma:927-944`

DLQ rows reference an entity that may be deleted before DLQ processing. With no FK + no `entityId` index, a DLQ scan that wants to skip dead-entity rows requires a full table scan + N+1 lookups against `asset_instances`.

**Fix:** Add `@@index([entityId])` and either FK with `onDelete: SetNull` or document the orphan handling.

### M6 — Pool size constants leak through env without validation
**File:** `packages/db/src/tsdb.ts:14-23`

```ts
min: parseInt(process.env.TSDB_POOL_MIN ?? '2', 10),
max: parseInt(process.env.TSDB_POOL_MAX ?? '20', 10),
```

`parseInt('abc', 10)` → `NaN`. `pg.Pool` with `max=NaN` silently accepts any value and the pool behaves erratically. No validation, no error. Use `z.coerce.number().int().min(1).default(20)` from the existing `zod` dep.

### M7 — `TemplateAssignment` cannot assign templates to roles, only users
**File:** `schema.prisma:27-41`

```prisma
model TemplateAssignment {
  ...
  assigneeType AssigneeType @map("assignee_type")
  userId       String?      @map("user_id") @db.Uuid
  // ← no roleValue field
}
```

`EntityAssignment` and `DashboardAssignment` both have `roleValue String?`. `TemplateAssignment` lacks it despite using the same `AssigneeType` enum (USER | ROLE). Setting `assigneeType=ROLE` on a TemplateAssignment is silently impossible — the row would have neither `userId` nor `roleValue`. Either delete the `ROLE` capability from this model (and drop `assigneeType`) or add `roleValue`.

### M8 — Continuous aggregates don't filter for `value_str`/`value_bool`/`value_json`
**File:** `init-tsdb.sql:122-162`

`telemetry_hourly` and `telemetry_daily` aggregate only `value_num`. Telemetry rows with `value_str` (text status, "RUNNING"/"STOPPED") or `value_bool` (alarm flags) are completely invisible to the rollup views. Reports built on `telemetry_hourly` will silently drop string and boolean telemetry. Either document this limitation or add a `count(value_str)`, `last(value_str, time)` parallel aggregate.

### M9 — `applyInvariants()` parses SQL with a hand-written tokenizer that's wrong on `$$`-bodies containing semicolons
**File:** `apps/api/prisma/seed.ts:23-32`

```ts
let inDollar = false;
for (const line of cleaned.split('\n')) {
  if (line.includes('$$')) inDollar = !inDollar;
  ...
}
```

If a single line contains TWO `$$` (e.g. `RETURN '$$' || x || '$$';` or even `$$ ... $$` on one line — graphile-worker generates these), the toggle ends up wrong and the next semicolon splits inside a function body, breaking the statement. `invariants.sql` doesn't currently hit this, but the parser is a footgun for any future invariant file.

**Fix:** Use `pg-query-parser` or call `psql -f invariants.sql` as a child process. The current heuristic only happens to work for the existing file.

---

## LOW

### L1 — `Prisma` log level identical for prod and dev
**File:** `packages/db/src/prisma.ts:5-7`

```ts
log: process.env.NODE_ENV === 'production' ? ['warn', 'error'] : ['warn', 'error'],
```

Trinary collapses to a constant. Either intentionally collapsed (then drop the ternary) or someone meant `['query', 'warn', 'error']` for dev.

### L2 — `init-tsdb.sql` is shipped for "first container start" but the deployment is Windows native (no docker-entrypoint)
**File:** `init-tsdb.sql:3-5`

> Runs automatically on first container start via `/docker-entrypoint-initdb.d/init-tsdb.sql`

Worktree CLAUDE.md says "App runs ONLY on local Windows." The init script is run by the operator manually per `LOCAL_SETUP_WINDOWS.md`. The header comment is misleading. Update or remove.

### L3 — Schema imports `LatestTelemetry` with `entityId String, key String` and `@@unique([entityId, key])` but no `@@index([key])` for cross-entity lookups
**File:** `schema.prisma:818-830`

A query like "give me all entities where `key='alarm_state'` and value='ACTIVE'" requires a sequential scan because the unique index is leading-on `entityId`. Add `@@index([key])` if such queries exist (likely yes for dashboard widgets).

### L4 — Doc drift: "7 hypertables" claim is stale across the active doc set
**Files:** worktree `CLAUDE.md`, root `CLAUDE.md`, `apps/api/CLAUDE.md`, `OFFLINE_SYNC_ARCHITECTURE.md`, `PROJECT_ARCHITECTURE.md`

Code shows 6 `create_hypertable` calls in `init-tsdb.sql`. Per the project's "every numerical claim must be backed by grep/ls against live code" rule (CLAUDE.md Documentation Sync Rule), this is a documented violation. Either restore the 7th hypertable (the original spec may have included `ts_alarms` or `ts_attribute_history` — verify intent) or do a stale-stat sweep.

### L5 — `closeTsdbPool()` swallows errors silently
**File:** `packages/db/src/tsdb.ts:45-55`

```ts
try { await pool.end(); }
catch (err) { console.error('[TSDB] Error closing pool:', err); }
finally { pool = null; }
```

Same pattern as M3 — the `console.error` goes into the void. At least bubble the error to a callback or the process shutdown handler so an init script knows whether teardown succeeded.

### L6 — `JOB_PRIORITY` constants are defined but only nominally honoured
**File:** `packages/queue/src/priorities.ts:1-10`, `apps/api/src/modules/data-ingestion/ingestion.service.ts`

`JOB_PRIORITY.CHECKLIST_SUBMISSION = 1` is the highest priority, but `addJob('ingestion', { msg }, { priority: options.priority })` only forwards the priority IF the caller passes it. `enqueueIngestionJob` does NOT default to `JOB_PRIORITY.TELEMETRY` etc. by message type. Result: every ingestion job runs at graphile-worker default priority. Wire `priority` from `msg.messageType` automatically.

### L7 — `CleaningCycle.profile_version Int` is captured but `FilterCleaningProfile.lineageId + version` is the unique key
**File:** `schema.prisma:1449-1450, 1306-1330`

```prisma
profileId             String  // FK to FilterCleaningProfile.id (one specific row)
profileVersion        Int     // captured separately
```

If `profileId` already points at the exact (immutable) versioned row in the lineage, then `profileVersion` is redundant — it can be derived. If `profileId` was meant to point at the lineage root, then there's no FK to enforce that. The current design points at the row but stores the version anyway, which means the two can drift if the row is ever mutated (which the design says won't happen — but the schema doesn't enforce immutability). Add a check trigger that `cleaning_cycles.profileVersion = (SELECT version FROM filter_cleaning_profiles WHERE id = cleaning_cycles.profileId)`.

### L8 — `electronic_signatures.recordId` is bare String with no FK and no targetType-discriminated index
**File:** `schema.prisma:797-815`

`recordType` + `recordId` are an MTI (multi-table-inheritance) discriminator pair. There's `@@index([recordType, recordId])` so reads are fast, but on `Alarm` or `ChecklistReview` deletion the signature rows are orphaned with no warning. For 21 CFR Part 11 signatures, this is acceptable (signatures must outlive the record), but should be documented explicitly.

---

## DESIGN CHALLENGES (no single fix; need team discussion)

### D1 — The "snapshot-then-bump" sidecar pattern is repeated 4× and growing
ChecklistProfile, FilterCleaningProfile, FilterProfile, EquipmentGroup all implement the same versioning pattern. Each has:
- A monotonic `version Int` on the live row.
- A `*Version` sidecar with `(profileId, versionNumber)` unique.
- Service-side snapshot-then-bump (unverified — out of review scope).

This is a generic pattern. Consider:
- Extracting a single `EntityVersion { entity_type, entity_id, version_number, snapshot, change_notes, created_by, created_at }` table with `@@unique([entity_type, entity_id, version_number])`. Loses Prisma typing benefits but DRYs the pattern.
- Alternatively, a generic `VersioningService` library that wraps the snapshot-then-bump in a single tx with `SELECT FOR UPDATE`, addressing H5.

Also: FilterCleaningProfile uses a different shape (`lineageId + immutable rows`) rather than the live-row + sidecar pattern. Two patterns for "the same thing" is a design smell. The cleaning-profile pattern is actually safer (no race window — every mutation is a fresh INSERT) but more storage. Pick one.

### D2 — graphile-worker swap loses BullMQ's priority queues across queue boundaries
Phase 2 swap moved 5 BullMQ queues to 3 graphile-worker queues. graphile-worker's "queues" are just `queue_name` strings — there's no per-queue concurrency limit, no per-queue rate limit. Heavy ingestion work can starve notifications and maintenance. The existing `JOB_PRIORITY` constant is a workaround but it's per-job, not per-queue.

If Mission Critical: configure `forbiddenFlags`, multiple Runner processes pinned to specific tasks, or move back to a queue tech with first-class per-queue concurrency (graphile-worker advanced options exist but aren't used here).

### D3 — `FilterDetails` 1:1 sidecar has weak invariant: only filters get a row, but nothing prevents non-filter assets from getting one
**File:** `schema.prisma:531-548`

The Step 6 split says "FilterDetails is created eagerly when the instance's template has templateKind='FILTER'". But the schema allows `INSERT INTO filter_details (asset_instance_id, ...)` for any asset. A code bug or restored backup could leave non-filter assets with FilterDetails rows. The pattern needs a CHECK constraint:
```sql
ALTER TABLE filter_details ADD CONSTRAINT chk_filter_details_only_for_filters
CHECK ((SELECT template_kind FROM asset_templates t JOIN asset_instances i ON i.template_id = t.id WHERE i.id = asset_instance_id) = 'FILTER');
```
PG can't subquery-CHECK without a trigger — would need a BEFORE INSERT trigger. Add to invariants.sql.

### D4 — Telemetry hypertable `chunk_time_interval` not specified — defaults to 7 days
**File:** `init-tsdb.sql:26, 47, 63, 76, 93, 116`

```sql
SELECT create_hypertable('ts_telemetry', 'time');
```

No `chunk_time_interval` argument → TimescaleDB default of 7 days. For high-frequency telemetry (1Hz × 100 entities × 7 days = ~60M rows/chunk), chunks become too large to fit in `shared_buffers` and queries slow down dramatically. Compression policy is set at 7 days — meaning the ACTIVE chunk is the entire 7-day window. Should size based on expected ingest rate. For DigiLog's pharmaceutical use case (1 reading per 1-5 sec per entity), recommended `chunk_time_interval => INTERVAL '1 day'` for telemetry, `INTERVAL '7 days'` for slower-changing tables.

### D5 — `DeadLetterQueue` exists, but the maintenance crontab handles `dlq_check` not `dlq_drain` or `dlq_cleanup`
**Files:** `schema.prisma:927-944`, `crontab.txt:4`

DLQ grows monotonically; nothing in the codebase removes resolved DLQ rows. Add `0 3 * * * dlq_cleanup` that deletes `status='RESOLVED' AND updated_at < NOW() - INTERVAL '90 days'`.

---

## OUT OF SCOPE (flagged for awareness)

- **Service-layer correctness** of snapshot-then-bump (H5) — the schema invites a race; the application code may correctly serialize via `$transaction` + `SELECT FOR UPDATE`. Verify in `apps/api/src/modules/{checklist-profiles,filter-profiles,filter-cleaning-profiles,equipment-groups}/`.
- **Backup/restore two-pass FK fixup** — `project_dynamic_backup.md` claims this works; without C3 fixed, "two-pass" is impossible because Prisma doesn't know about the missing FKs. Need to verify the backup module actually walks references via `INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS`.
- **MQTT pipeline retry semantics** in `mqtt-handler.ts` — interacts with H1 (graphile-worker retries) but lives in `apps/api/src/transport/`.
- **Audit trail SHA-256 chain integrity** — `AuditTrail.checksum` references the prior row by hash; not verified that this is enforced server-side or that backup/restore preserves the chain.
- **Reauth seed config** — `applyInvariants` happens after `SystemConfig` upserts; the `action-reauth` config seeds empty `{}`, which the comment says is intentional. Per memory `feedback_remarks_mandatory` and `RESUME-STATE-2026-05-04`, several reauth actions were added 2026-05-04. Verify the upsert merge semantics don't clobber operator-edited reauth config on reseed.
- **Compression / retention** policies in `init-tsdb.sql` (no chunk-level encryption, no audit on compression — fine for non-PII telemetry, problematic if customer asks for "right-to-be-forgotten" deletion mid-compression-window).

---

## 5-Line Summary

1. **Live count audit:** worktree has **69 Prisma models, 23 enums, 6 hypertables, 3 graphile-worker queues** — the prompt's 64/22/7/5 and worktree CLAUDE.md's "7 hypertables" are stale (L4).
2. **Highest blast-radius issue (C1):** the 2026-05-03 drift migration drops `asset_instances` columns and adds `filter_cleaning_profiles.lineage_id NOT NULL` with no backfill or guard — silent data loss on populated DBs without manual `migrate resolve --applied`.
3. **Compliance integrity gaps (C2 + C3):** 3 critical DB invariants live in seed.ts (skipped by `migrate deploy`), and ~140 of ~176 UUID columns have no Prisma `@relation` — orphan-prone schema with the `cwhf0500-01` orphan UnsMapping bug as documented prior art.
4. **Queue layer foot-guns (H1 + H2):** `QUEUES.*.defaultJobOptions.{backoff,removeOnComplete,removeOnFail}` are dead BullMQ leftovers (graphile-worker ignores them); cron `* * * * * dlq_check` overlaps under load with no job-key coalescing.
5. **Telemetry batcher hardening (H3 + H4):** O(n²) requeue stalls the batcher under sustained TSDB outage, and dropped rows on backpressure are logged via `console.warn` only — undocumented compliance loss.
