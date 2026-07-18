# Session resume state — 2026-04-29 (post-Phase-2, awaiting elevated install)

If you're reading this in a NEW session (especially an elevated one), this is your cold-start guide.

## What's done

**Phase 1 (Mosquitto MQTT swap)** — `feature/phase1-mosquitto-rewrite` HEAD `059f7a5`, pushed.
- 16 commits including the just-cherry-picked `publishClientReceive` fix (originally on `fix/phase1-publish-client-receive-acl`, now in Phase 1 history)
- Generator emits PBKDF2 `$7$` format with 64-byte salt (matches `mosquitto_passwd`)
- `mosquitto.conf` split into `mosquitto.windows.conf` (.dll plugin) + `mosquitto.linux.conf` (.so plugin)
- 13 unit tests + 11 routes tests + 3 aedes integration tests all green
- Live verified: real `mosquitto_pub` device→broker→API delivery confirmed (`Completed task 22 (ingestion, 100.36ms) with success`)

**Phase 2 (BullMQ → graphile-worker)** — `feature/phase2-pg-queue` HEAD `7832af1`, pushed.
- 11 commits, rebased onto Phase 1
- BullMQ + ioredis dropped from `packages/queue`; ioredis stays in `apps/api` for non-queue Redis pub/sub (Phase 4 scope)
- `EXPORT` and `REPORTS` queue defs removed (zero producers/consumers — aspirational placeholders)
- USE_PG_QUEUE flag removed entirely; graphile-worker is the only path
- 6/6 packages/queue tests, 34/34 targeted apps/api suites
- Live verified: graphile-worker schema auto-bootstraps, cron fires every minute, `add_job` round-trip works

**Integration branch:** `windows_dep` HEAD `7832af1`, pushed.
- Created from `origin/main`, fast-forwarded to Phase 2 HEAD
- Contains: docsCleaned + Phase 1 (with publishClientReceive fix) + Phase 2
- `main` untouched

## What's NOT done — the elevated step

**`scripts/install-mosquitto.ps1` end-to-end installation.**

Why deferred to elevated session: install script copies into `C:\Program Files\mosquitto\` and runs `icacls` — needs admin. Idempotence checks (lines 1-50) confirmed working from non-elevated; the failing step is line 51 `Copy-Item` to `Program Files`.

**Run from elevated PowerShell:**
```powershell
Set-Location C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase2-pg-queue
powershell.exe -ExecutionPolicy Bypass -File scripts\install-mosquitto.ps1
```

**Success looks like:**
```
===================================
Mosquitto installation complete.
  Install dir: C:\Program Files\mosquitto
  Service:     Running
  Listener:    tcp://localhost:1883
===================================
```

**After install completes**, next-session checklist:
1. Verify service: `Get-Service mosquitto` → expect `Running` + `Automatic`
2. Verify deployed conf: `Get-Content "C:\Program Files\mosquitto\mosquitto.conf" | Select-String "plugin"` → expect `.dll`
3. Verify dynsec bootstrap: `Test-Path "C:\Program Files\mosquitto\dynamic-security.json"` → True
4. End-to-end MQTT test against the SERVICE-managed broker (not a hand-launched mosquitto.exe):
   - Boot API in Phase 2 worktree with `USE_MOSQUITTO=true`
   - `curl -sk -X POST -H "Authorization: Bearer <MOSQUITTO_REFRESH_TOKEN>" https://localhost:3000/api/internal/mqtt/refresh-acl`
   - `Restart-Service mosquitto` (or `net stop mosquitto && net start mosquitto`) to load new dynsec
   - `mosquitto_pub -u <device-token> -P <device-token> -t digilog/v1/pfi-block/telemetry -m '{"temperature":99.9}' -q 1`
   - Watch API log for `Completed task <N> (ingestion, ...) with success`
   - Confirm `ts_pipeline_traces` row appears in `digilog_tsdb`

## Branches on origin (post-elevated session — these stay the same)

| Branch | HEAD | Status |
|---|---|---|
| `main` | (untouched) | Production baseline |
| `windows_dep` | `7832af1` | **Integration branch** containing docsCleaned + Phase 1 + Phase 2 + publishClientReceive fix |
| `feature/phase1-mosquitto-rewrite` | `059f7a5` | Phase 1 + publishClientReceive fix (cherry-picked in) |
| `feature/phase2-pg-queue` | `7832af1` | Phase 2 (rebased on Phase 1) |
| `docsCleaned` | `30cb462` | Documentation cleanup |
| `fix/phase1-publish-client-receive-acl` | `8a75174` | Original fix branch — now redundant (cherry-picked into Phase 1). Safe to delete: `git push origin --delete fix/phase1-publish-client-receive-acl` |

## Working-tree state at session save

| | Path |
|---|---|
| Main checkout | `C:\Users\hello\21cfrlogbook-DigitalFMS` (branch `RFID` at `893c0ec`) |
| Phase 1 worktree | `.worktrees/phase1-mosquitto` (branch `feature/phase1-mosquitto-rewrite` at `059f7a5`) |
| Phase 2 worktree | `.worktrees/phase2-pg-queue` (branch `feature/phase2-pg-queue` at `7832af1`) |

**Main checkout has 3 modified + 3 untracked files** (NOT mine — these are your pre-existing source mods restored from stash):
- M `apps/api/src/modules/filter-operations/filter-operations.service.ts`
- M `apps/web/src/routes/filter-management/filter-operations.tsx`
- M `apps/web/src/routes/mobile/mobile-operations.tsx`
- ?? `apps/android/apps/` (pre-existing stray dir)
- ?? `tasks/PHASE1-DEPLOYMENT-TEST-2026-04-29.md` (Phase 1 deployment report)
- ?? `tasks/PHASE2-DEPLOYMENT-TEST-2026-04-29.md` (Phase 2 deployment report)

## Verification matrix (what's been tested)

| Item | Status | Notes |
|---|---|---|
| Phase 1 unit + integration tests | ✅ 13+11+3 = 27/27 | aedes mocks broker (doesn't exercise dynsec) |
| Phase 2 unit + integration tests | ✅ 6/6 (queue) + 34/34 (api targeted) | real Postgres round-trips |
| Live MQTT pub→ingest pipeline | ✅ | verified via mosquitto_pub against manually-launched broker |
| graphile-worker cron firings | ✅ | dlq_check + connectivity_check at top-of-minute |
| graphile-worker retry/backoff | ✅ | malformed payload → attempts incrementing 1→4 over 3 minutes |
| Production-style `dist/` build + boot | ✅ | `tsc` emitted dist (despite 232 pre-existing errors); `node dist/app.js` boots clean |
| `install-mosquitto.ps1` end-to-end | 🟡 **Awaits elevated session** | Idempotence + non-privileged checks confirmed; privileged copy step blocked |
| HTTP `/api/data-ingestion/telemetry` endpoint | ❌ Pre-existing JWT-auth-precedence issue (NOT Phase 1/2 regression) | MQTT path covers same downstream code |
| `notificationTask` handler exists | ⚪ Out of scope | No consumer in either backend; pre-existing |
| Pre-existing Stage 9 → ts_telemetry write loss | ❌ Pre-existing pattern (April 6: 12 traces → 10 rows) | NOT Phase 1/2 caused; deserves separate investigation |

## After elevated install completes

The "next steps after install" checklist above can be run from a non-elevated Claude session — only the install itself needs admin. Resume me here:

```
Resume Phase 1 e2e against the service-managed Mosquitto. The install
script ran successfully (per the resume note). Verify the service is
managing the broker, then run the end-to-end MQTT publish round-trip
against it. See tasks/RESUME-STATE-2026-04-29-elevated.md for the full
checklist.
```

## Key URLs

- `windows_dep` PR (when ready): https://github.com/pankajexa/21cfrlogbook/compare/main...windows_dep?expand=1
- Phase 2 deployment report: `tasks/PHASE2-DEPLOYMENT-TEST-2026-04-29.md`
- Phase 1 deployment report: `tasks/PHASE1-DEPLOYMENT-TEST-2026-04-29.md`
- Cut-over runbook: `docs/runbooks/queue-cutover.md` (in Phase 2 worktree)

## Things to NOT touch in next session

- `main` branch (user's explicit instruction: "lets not disturb main for some time")
- The 3 modified files in the main checkout — they're pre-existing source mods, not Phase 1 / 2 work
- `fix/phase1-publish-client-receive-acl` branch — keep until merge of Phase 1 to make sure cherry-pick is verified, then delete

## Memory of decisions made

- **Generator format:** kept the PBKDF2 `$7$` rewrite (vs reverting to bcrypt) because it removes a native-compiled dep and matches `mosquitto_passwd` operator output.
- **Conf split:** Option B (two physical files `mosquitto.windows.conf` + `mosquitto.linux.conf`) chosen over Option A (script-rewrites-conf-at-install-time). Cleaner, no install-time mutation magic.
- **Tasks 2.5 + 2.6 deleted:** export and reports queue defs had zero producers/consumers — removed in 2.10 alongside BullMQ.
- **Vitest singleFork:** `packages/queue/vitest.config.ts` forces `pool: 'forks'` + `singleFork: true` to prevent bootstrap-test ↔ connection-test race.
