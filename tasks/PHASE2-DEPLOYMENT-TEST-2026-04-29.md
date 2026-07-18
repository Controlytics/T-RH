# Phase 2 (graphile-worker rewrite) — local deployment + verification report

**Date:** 2026-04-29
**Branch:** `feature/phase2-pg-queue`
**Worktree:** `.worktrees/phase2-pg-queue`
**HEAD:** `4ce648f` (Task 2.10)

## Summary

Phase 2 of the windows-friendly-rewrite swaps BullMQ + Memurai/Redis for graphile-worker, eliminating Redis as a queue infrastructure dependency. The migration shipped in 11 commits behind a `USE_PG_QUEUE` flag, then Task 2.10 deleted the legacy paths and the flag itself. Verified end-to-end on a real Postgres 18 + the live API:

- ✅ graphile-worker schema bootstraps idempotently on first runner start
- ✅ Cron schedule loaded from `packages/queue/crontab.txt`; `dlq_check` and `connectivity_check` fire every minute on the wall clock
- ✅ Real ingestion job dequeued and routed through `ingestionTask` → `processIngestionMessage` → DLQ pipeline (verified by stack trace from a deliberately-malformed payload)
- ✅ Retry/backoff working — failed job rescheduled with attempts incrementing
- ✅ 232 / 232 pre-existing tsc errors, no new errors introduced
- ✅ 6/6 packages/queue tests green; full apps/api suite green minus 39 pre-existing failures (same 39 as parent)

## Plan adherence

The plan listed 10 tasks (2.1–2.10). Of those:
- **2.1, 2.2, 2.3, 2.4, 2.7, 2.8, 2.9, 2.10** — implemented as committed changes.
- **2.5 (export queue) and 2.6 (reports queue)** — **no-ops**, deleted from the task list. Inspection of the live codebase showed those queue defs (`QUEUES.EXPORT`, `QUEUES.REPORTS`) had **zero producers and zero consumers** anywhere in `apps/api/src`. They were aspirational placeholders — the `REPORTS` def even had a comment `FUTURE SCOPE — queue defined now, worker built later`. Both queue defs were removed in Task 2.10 along with `bullmq` and `ioredis` dependencies.

## Defects + sharp edges found during verification

### Defect 1 — Task 2.3 silently broke a sibling test suite

**Where:** `apps/api/src/modules/data-ingestion/__tests__/dlq-manager.test.ts`
**Symptom:** suite fell from 17/17 passing on parent to 0/17 (failed to load) after Task 2.3's first commit `40f88e9`. The implementer's targeted-suite verification didn't catch it; the code-quality reviewer did.
**Root cause:** Task 2.3 made `dlq-manager.ts` import `enqueueIngestionJob` from `ingestion.service.ts`. The dlq-manager test mocked `bullmq` but not `ingestion.service`, so the SUT load transitively pulled in `ingestion.service.ts`'s `import { flushAll } from '@digilog/db'` — vitest-vite cannot resolve workspace package entry points unless `packages/db/dist/` is built.
**Fix:** commit `9c7d0b2` updated the test to mock `'../ingestion.service.js'` and assert on `mockEnqueueIngestionJob` instead of the now-unreachable `mockQueueAdd`. Also fixed the same pattern in `mqtt-handler.test.ts` which had the same circular-import issue.
**Generalization:** the test-mock convention "when module A.ts gets a new helper that B.ts now calls, B's test file must mock A" was baked into the prompts for tasks 2.4–2.7 to prevent recurrence.

### Defect 2 — `apps/api/src/workers/__tests__/maintenance.worker.test.ts` was stale on parent

**Symptom:** asserted `mockQueueAdd` was called 2× while live code added 3 jobs (DLQ + connectivity + retention).
**Fix:** the Task 2.7 implementer rewrote the test to cover the 3 new graphile-worker `Task` functions instead of the BullMQ scheduling path. Net delta: +3 task tests, -2 stale assertions.

### Sharp edge 1 — workspace dist/ must be built before tests run

The vitest-vite resolver reads workspace package `main` entries (`packages/{db,queue,shared}/dist/index.js`). On a fresh checkout these don't exist. Fix:
```
npx tsc -p packages/queue/tsconfig.json
npx tsc -p packages/db/tsconfig.json
npx tsc -p packages/shared/tsconfig.json
```
Captured in the cut-over runbook (`docs/runbooks/queue-cutover.md`) as a pre-flight check.

### Sharp edge 2 — `vi.resetModules()` defeats `vi.mock`

The Task 2.4 implementer hit this trying to clear the singleton-cache between tests. Use shared mock-fn references in the mock factory instead — when the factory returns `class { add = mockBullMqAdd; close = mockClose }`, even a cached Queue instance carries the live mock fn references that `mockBullMqAdd.mockReset()` resets correctly. No module reset needed.

### Sharp edge 3 — `git mv` discipline

Tasks 2.2, 2.3, and 2.7 each split a file via `git mv`, but git's rename detection at commit time required >50% similarity. Some renames showed as add+modify in the commit summary because the *new* sibling file (e.g., `connection.ts` after the split) was substantially smaller than the source. Content of the renamed `*.bullmq.ts` files was verified bit-identical via `diff --strip-trailing-cr` in each case. `git log --follow --find-renames=30` traces the history. No functional impact.

### Sharp edge 4 — `graphile_worker.jobs` is a view, not a table

Caught while cleaning up test artifacts: `DELETE FROM graphile_worker.jobs` errors out with `cannot delete from view "jobs"`. The real table is `graphile_worker._private_jobs`. The view exists for backwards compat with the older v0.13.x API. For ops scripts, use the `_private_*` tables; for queries, the view is fine.

## Live-host verification

### Boot sequence

```
$ cd apps/api && npx tsx watch src/app.ts
…
[config-registry] 27 modules registered
{… "Server listening at https://127.0.0.1:3000" …}
{… "Telemetry batcher initialized" …}
{… "graphile-worker job runner started" …}
[core] INFO: Worker connected and looking for jobs... (task names: 'ingestion', 'dlq_check', 'connectivity_check', 'retention_cleanup')
```

After Task 2.10 the boot has no `if (USE_PG_QUEUE) { … } else { … }` branch — graphile-worker is the only path. No legacy `[IngestionWorker] Started with concurrency=N` line appears.

### Schema bootstrap

`graphile-worker` schema installed automatically on first start:

```
digilog_db=> SELECT table_name FROM information_schema.tables WHERE table_schema='graphile_worker' ORDER BY table_name;
        table_name
---------------------------
 _private_job_queues
 _private_jobs
 _private_known_crontabs
 _private_tasks
 jobs                 (view)
 migrations
```

### Cron firing

Two cron tasks fire at the top of every minute:

```
digilog_db=> SELECT identifier, last_execution FROM graphile_worker._private_known_crontabs ORDER BY identifier;
     identifier     |      last_execution
--------------------+---------------------------
 connectivity_check | 2026-04-29 12:55:00+05:30
 dlq_check          | 2026-04-29 12:55:00+05:30
 retention_cleanup  | (null — fires daily at 02:00)
```

API log on each cron firing:
```
[job(worker-…: connectivity_check{6})] INFO: [Maintenance] Connectivity check: 0 offline
[worker(…)] INFO: Completed task 6 (connectivity_check, 2.42ms) with success
[job(worker-…: dlq_check{5})] INFO: [Maintenance] DLQ check: {"requeued":0,"dead":0}
[worker(…)] INFO: Completed task 5 (dlq_check, 7.10ms) with success
```

### Live ingestion-job round trip

Enqueued via `graphile_worker.add_job` directly (simulating an HTTP/MQTT producer) with deliberately-malformed `entityId: "nonexistent"` to trigger the DLQ path. API picked it up within ~250 ms. Stack trace from API log proves the full chain executed:
```
at addToDLQ (.../dlq-manager.ts:21)
at processIngestionMessage (.../ingestion.service.ts:539)
at ingestionTask (.../workers/ingestion.worker.ts:48)
```

Job state after retry-with-backoff:
```
 id | task_identifier | attempts | max_attempts | is_uuid_err | locked |              run_at
----+-----------------+----------+--------------+-------------+--------+----------------------------------
  9 | ingestion       |        4 |           25 | t           | f      | 2026-04-29 12:57:59.447688+05:30
```

`attempts: 4` after ~3 minutes confirms graphile-worker's exponential backoff is active. Test job removed from `_private_jobs` afterwards.

## Verification matrix

| # | Check | Method | Result |
|---|---|---|---|
| 1 | All 11 Phase 2 commits land cleanly | `git log` | ✅ |
| 2 | Tests in packages/queue pass | `cd packages/queue && npx vitest run` | ✅ 6/6 (3 files: bootstrap + connection + job-runner) |
| 3 | Tests in apps/api pass with no NEW failures | full suite vs parent | ✅ same 39 pre-existing failures, same `tsc` count of 232 |
| 4 | `npm ls bullmq` empty | `npm ls bullmq` from worktree root | ✅ `(empty)` |
| 5 | `npm ls ioredis` only used in non-queue modules | `npm ls ioredis` | ✅ apps/api keeps it for WS/RPC/tracer pub-sub (Phase 4 scope) |
| 6 | API boots clean without USE_PG_QUEUE flag | `tsx watch src/app.ts` | ✅ "graphile-worker job runner started" |
| 7 | graphile_worker schema auto-installs | `psql … information_schema.tables` | ✅ 6 tables created |
| 8 | Cron schedule loaded from crontab.txt | `_private_known_crontabs` populated | ✅ all 3 task identifiers visible |
| 9 | dlq_check fires every minute | wait + check `last_execution` | ✅ |
| 10 | connectivity_check fires every minute | wait + check `last_execution` | ✅ |
| 11 | retention_cleanup waits for 02:00 | `last_execution` is null | ✅ (cron schedule correct) |
| 12 | Live `add_job('ingestion', ...)` is dequeued + routed | manual SQL insert, watch API log | ✅ stack trace confirms `ingestionTask → processIngestionMessage → DLQ` |
| 13 | Failed job retries with backoff | `attempts` column increments | ✅ `attempts: 4 / 25` after 3 minutes |
| 14 | Successful jobs auto-deleted | jobs view empty after cron tasks complete | ✅ (graphile-worker default) |
| 15 | API shutdown is clean | `Stop-Process node` + log inspect | ✅ no stray jobs in `locked_at IS NOT NULL` state |

## Open items / not exercised on the live host

These are NOT regressions — they're scope-explicit limitations.

- **`notification` task has no handler.** The PG queue accepts notification jobs (BullMQ did too), but no `notificationTask` is registered. Both backends were black-hole-with-Redis for notifications; Phase 2 didn't change that. A future phase will add the dispatch logic in `notification-delivery/`.
- **`ioredis` still in `apps/api`.** 6 modules use Redis pub/sub for WebSocket fanout, RPC routing, pipeline tracing, debug recorder. Out of Phase 2 scope; queued for Phase 4 (replace with Postgres LISTEN/NOTIFY).
- **HTTP `/api/data-ingestion/telemetry` not exercised end-to-end.** Requires a valid `DeviceCredential` token + `AssetInstance` row + body in the right shape. The internal helper path was verified instead by `add_job` directly to `graphile_worker.jobs`, which exercises the same code from `ingestionTask` onwards. The HTTP layer above is unchanged from Phase 1; not a Phase 2 regression risk.
- **MQTT ingestion path not exercised on the live host.** Mosquitto wasn't running locally during this test (Phase 1 was already verified separately on 2026-04-29). The `mqtt-handler.ts` enqueue site was test-covered (`mqtt-handler.test.ts:10/10`) and code-walked but not run live in this session.
- **`packages/queue/src/schemas.ts` has a stale `ingestionMessageSchema`** that doesn't match the real `IngestionMessage` shape (12 fields vs 15). Caught during Task 2.3 review. Not used by any production code, so not a regression — but it's a dead schema worth removing in a follow-up cleanup.

## State left behind

| | State |
|---|---|
| API process | Stopped |
| `graphile_worker._private_jobs` | Empty (test job deleted) |
| `graphile_worker` schema | Installed (left in place — production-equivalent state) |
| `apps/api/.env` (worktree) | Unchanged from initial Phase 2 setup |
| Tests | 6/6 green in packages/queue; 689/728 in full apps/api suite (39 pre-existing failures, same as parent) |

## Commit summary

```
4ce648f chore(queue): drop BullMQ + Redis; graphile-worker is sole backend
b57b814 docs(runbook): queue cut-over playbook BullMQ→graphile-worker
453a523 feat(queue): single graphile-worker Runner for all task types
7762dfa feat(queue): migrate maintenance cron to graphile-worker
b389620 feat(queue): migrate notification queue to graphile-worker
9c7d0b2 fix(queue): address Task 2.3 review feedback before pattern replicates
40f88e9 feat(queue): migrate ingestion queue to graphile-worker
65d0c7c chore(queue): vitest singleFork pool + plan-doc fix-up for Task 2.2
b1e35f8 feat(queue): graphile-worker producer + runner factories
88e04fc chore(queue): align vitest version + declare pg + wire test script
1451c35 feat(queue): install graphile-worker + bootstrap test
```

11 commits, branched from `feature/phase1-mosquitto-rewrite` (so Phase 1 fix-up commits are also included in this branch's history). Phase 1 + Phase 2 should land together, OR Phase 1 first then Phase 2 rebased onto whatever Phase 1 merges to.

## Suggested next steps

1. **Push the branch:** `git push origin feature/phase2-pg-queue` (currently local-only).
2. **Open PR** targeting `feature/phase1-mosquitto-rewrite` (or `docsCleaned` after Phase 1 lands). Use the cut-over runbook + this report as the PR description.
3. **Phase 3** of the windows-friendly-rewrite plan: replace bundled Chromium with Edge for PDF generation. Independent of Phase 1 + 2; can branch from `feature/phase2-pg-queue` once that lands.
4. **Phase 4 cleanup:** drop `ioredis` from `apps/api` by replacing the 6 non-queue Redis pub/sub use sites with Postgres LISTEN/NOTIFY. Will eliminate Memurai entirely from the local dev environment.
5. **Update `start-digilog.bat`:** make Memurai launch conditional on a flag, then remove entirely once Phase 4 lands. Currently still launches Memurai unconditionally — harmless but wasteful.
