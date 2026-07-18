# Session resume — 2026-04-29 evening (Phase 3 + docs sync done; Phase 4 + 5 pending)

If you're reading this in a NEW or post-compact session, this is your cold-start guide.

## TL;DR

`windows-friendly-rewrite` plan is **3 of 5 phases done, with all docs synced**. All tests in the workspace pass (1279/1279). Phase 4 (tooling cleanup) + Phase 5 (verification + e2e harness) are next, scheduled to be executed via the `superpowers:subagent-driven-development` skill.

## Current branch state

`windows_dep` is at `d6bdd7c`, **9 commits ahead of `main`**:

```
d6bdd7c docs: sync active doc set with Phase 1+2+3 of windows-friendly-rewrite
b2c3b37 fix(tests): zero failed tests across the workspace
06bcb95 fix(tests): bring apps/api vitest suite back from 30 failed files / 65 failed tests to 11 / 14
d72d44c feat(reports): replace chartjs-node-canvas with @napi-rs/canvas
abdc9dd feat(reports): switch pdf-renderer from puppeteer to puppeteer-core + Edge
79937b7 feat(reports): edge-detector helper for puppeteer-core executablePath
0ecc151 fix(mosquitto): make install script produce a service-bootable conf
7832af1 chore(queue): drop BullMQ + Redis; graphile-worker is sole backend  ← Phase 2 boundary
3ea12ba docs(runbook): queue cut-over playbook BullMQ→graphile-worker
```

Nothing pushed to origin this session — all work is local.

## Branch table (no rename needed; ready to push when desired)

| Branch | HEAD | Status |
|---|---|---|
| `main` | (untouched, user instruction) | Production baseline |
| `windows_dep` | `d6bdd7c` | **Integration branch** — Phase 1 + Phase 2 + Phase 3 + test fixes + doc sync |
| `feature/phase1-mosquitto-rewrite` | `059f7a5` | Phase 1 only |
| `feature/phase2-pg-queue` | `0ecc151` | Phase 2 + Mosquitto install fix (carryover) |
| `feature/phase3-reports-edge` | `d6bdd7c` | Phase 3 + tests + docs (= windows_dep) |

**Local-only fact:** the install fix `0ecc151` semantically belongs to Phase 1 but lives on Phase 2's branch. Pragmatic single-commit choice. If a clean Phase-1-only PR is wanted later, cherry-pick `0ecc151` onto `feature/phase1-mosquitto-rewrite` and rebase Phase 2 + 3.

## Worktree layout (active, do NOT delete blindly)

| Path | Branch | HEAD |
|---|---|---|
| `C:\Users\hello\21cfrlogbook-DigitalFMS` | `RFID` | `893c0ec` (user's pre-existing work — has 3 modified + 3 untracked files NOT mine) |
| `.worktrees/phase1-mosquitto` | `feature/phase1-mosquitto-rewrite` | `059f7a5` |
| `.worktrees/phase2-pg-queue` | `feature/phase2-pg-queue` | `0ecc151` |
| `.worktrees/phase3-reports` | `feature/phase3-reports-edge` | `d6bdd7c` ← **work here** |

## Test pass-rate snapshot

```
apps/api          83/83 files, 1123/1123 tests   ✅
packages/shared    5/5  files,  150/150 tests    ✅
packages/queue     3/3  files,    6/6   tests    ✅
─────────────────────────────────────────────────────
TOTAL             91/91 files, 1279/1279 tests   ✅
```

Re-run from the Phase 3 worktree:
```bash
cd .worktrees/phase3-reports/apps/api    && npx vitest run
cd .worktrees/phase3-reports/packages/shared && npx vitest run
cd .worktrees/phase3-reports/packages/queue  && npx vitest run
```

Three structural pieces ride along (required for green):
- `apps/api/vitest.setup.ts` — loads `.env` so `PrismaClient` finds `DATABASE_URL`
- `apps/api/vitest.global-setup.ts` — idempotent upserts: `admin`/`Admin@123` (SUPER_ADMIN), `RB0001`/`Test@1234` (OPERATOR), `VIEWER` system role
- `apps/api/vitest.config.ts` — `fileParallelism: false` (e2e tests share the `admin` user/session)

## What was done this session

### Phase 1 follow-up
- `0ecc151 fix(mosquitto): make install script produce a service-bootable conf` — discovered live during the elevated install: SCM-managed broker has CWD=System32 + no stdout, so `./data/`, `./dynamic-security.json`, `log_dest stdout` silently exited. Install script now rewrites to absolute paths + file logging in the deployed conf.

### Phase 3 (3 feature commits)
- `79937b7` — `apps/api/src/modules/reports/renderers/edge-detector.ts`. Probes `PUPPETEER_EXECUTABLE_PATH` → Edge → Chrome → Linux Chromium → macOS .app bundles. 6 vitest cases.
- `abdc9dd` — `pdf-renderer.ts`: `puppeteer` → `puppeteer-core` + `detectEdgePath()`. Cold-start render 34 s → 1.9 s. Drops the ~150 MB Chromium bundle.
- `d72d44c` — `chart-renderer.ts`: `chartjs-node-canvas` → `@napi-rs/canvas` (prebuilt N-API binaries). Adds `chartjs-adapter-date-fns` for time-axis charts. Renderer adds explicit white background fill.

### Test cleanup (2 commits, brought 30 failed files / 65 failed tests → 0)
- `06bcb95` — vitest infra (env loader, admin-user globalSetup, `fileParallelism: false`) + 11 service/plugin/test mock fixes.
- `b2c3b37` — finishing pass: e2e snippets/UUIDs, RB0001 + VIEWER fixtures, **config-route reauth header fallback** (real impl bug — hardcoded fallback only read body, not `x-reauth-password` header), real-schema in user-id validator, ingestion `alarm.findFirst` mock, plus 4 packages/shared assertion drifts. Also restored `userQuerySchema.limit.max(100).default(20)` and `assetQuerySchema/templateQuerySchema.limit.max(100).default(50)` (unbounded list-endpoint limit was a DoS surface — real impl regression).

### Doc sync (1 commit, today's flagged gap)
- `d6bdd7c` — 16 files. Per `CLAUDE.md` "Documentation Sync Rule" + `docs/CONTRIBUTING.md` "Change → Docs map":
  - `windowsIssues.md` §1 (Puppeteer), §2 (chartjs-node-canvas), §3 (EMQX), §7 (Memurai) marked **RESOLVED** with commit SHAs and detailed migration notes.
  - `CHANGELOG.md` new top-of-file section.
  - `LOCAL_SETUP_WINDOWS.md`, `DEPLOY-WINDOWS.md`, `BACKEND_GUIDE.md`, `apps/api/CLAUDE.md`, `CLAUDE.md` (root), `PROJECT_SUMMARY.md`, `PROJECT_ARCHITECTURE.md`, `README.md` all aligned to the new stack (Mosquitto / graphile-worker / puppeteer-core / @napi-rs/canvas).
  - `PHASE_5_RECENT_WORK.md` new §12.
  - `future/overview/CODEBASE_SUMMARY.md`, `future/overview/CURRENT_STATUS.md`, `future/qa/KNOWN_ISSUES.md` refreshed.
  - `apps/api/.env.example` — `USE_EDGE_PDF` retired, `PUPPETEER_EXECUTABLE_PATH` override documented.
  - `tasks/todo.md` audit entry capturing every code + doc change.

## What's NOT done — Phase 4 + 5

**Phase 4 — Tooling cleanup** (5 sub-tasks, mostly mechanical script + env edits)

| Task | File(s) | Summary |
|---|---|---|
| 4.1 | `scripts/install-on-target.ps1` | Drop Memurai + EMQX install blocks; call `install-mosquitto.ps1`; enable `LongPathsEnabled`; verify msedge.exe present |
| 4.2 | `scripts/package-for-production.ps1` | Drop Chromium download; drop Memurai bundling; verify `npm ci --prefer-offline` works |
| 4.3 | `apps/api/.env.example` (already done in `d6bdd7c`) | ✅ done |
| 4.4 | `windowsIssues.md` (already done in `d6bdd7c`) | ✅ done |
| 4.5 | Cross-doc count verification + final sweep | mostly already done in `d6bdd7c`; remaining: live-count verification on `apps/api/prisma/schema.prisma`, `packages/shared/src/types/permissions.ts`, etc. before any further count-bearing claims |

**Phase 5 — Verification & docs finalization** (3 sub-tasks)

| Task | File(s) | Summary |
|---|---|---|
| 5.1 | `tests/integration/windows-server-stack.test.ts` (new) | INTEGRATION_TEST=1-gated suite: boot API, enqueue export, MQTT publish 100 msgs against in-process `aedes` mocking Mosquitto, generate test PDF, assert TimescaleDB rows |
| 5.2 | `scripts/verify-windows-deployment.ps1` (new) | Smoke-check API health, Mosquitto port, graphile-worker schema, generate 1-page PDF |
| 5.3 | (publish) | `git push origin HEAD:docsCleaned`, open PR `docsCleaned → RFID` |

Full task text: `docs/plans/2026-04-29-windows-friendly-rewrite.md` lines 1568-1645.

## How to resume

Per the `superpowers:subagent-driven-development` skill that was queued:

1. Create the Phase 4 worktree from `windows_dep`:
   ```bash
   git worktree add -b feature/phase4-tooling .worktrees/phase4-tooling windows_dep
   ```
2. Extract Phase 4 tasks 4.1 + 4.2 (4.3, 4.4, 4.5 already done) → TaskCreate.
3. Dispatch implementer subagent per task → spec review → code quality review → next.
4. **End-of-phase doc sync** is now mandatory per `feedback_doc_sync_each_phase` memory — audit changes against `docs/CONTRIBUTING.md` "Change → Docs map" and update CHANGELOG / windowsIssues / setup docs in the **same phase commit chain**, not in a deferred batch.
5. After Phase 4 → Phase 5 the same way.
6. Optionally push `windows_dep` to origin.

**Resume prompt to use:**

```
Continue executing the windows-friendly-rewrite plan via
superpowers:subagent-driven-development. windows_dep is at d6bdd7c
with Phase 1+2+3+test cleanup+doc sync all landed. See
tasks/RESUME-STATE-2026-04-29-phase3-docs-done.md.

Start by creating the Phase 4 worktree (feature/phase4-tooling from
windows_dep). Phase 4.3, 4.4, and most of 4.5 already shipped in
d6bdd7c — only 4.1 (install-on-target.ps1) and 4.2
(package-for-production.ps1) remain. After those, do the matching
doc-sync commit per the per-phase rule before moving to Phase 5.
```

## Mosquitto service state

Installed, running as a Windows service, auto-start enabled. PID changes between sessions; listener at `0.0.0.0:1883` is durable. Will survive reboot. Don't re-run `install-mosquitto.ps1` unless something is actually broken — it's idempotent but the service restart it triggers will briefly drop client connections.

## Things to NOT touch

- `main` branch (user instruction: "lets not disturb main for some time")
- The 3 modified + 3 untracked files in the main checkout's `RFID` branch (not mine)
- `feature/phase1-mosquitto-rewrite` — keep pristine for any future Phase-1-only PR
- `apps/api/uploads/` (untracked, holds the Phase 3 e2e PDF — gitignored anyway)

## Memory entries added this session

- `feedback_mosquitto_windows_service_install` — service CWD=System32, no stdout
- `feedback_mosquitto_dynsec_install_dir` — refresh-acl writes to repo, broker reads install dir
- `project_orphan_uns_mapping_cwhf0500` — `cwh-block/cwh-ahu-01/cwhf0500-01` UnsMapping orphaned
- `feedback_doc_sync_each_phase` — Update docs at end of each phase, not in a deferred batch (today's correction)

## Pre-existing issues NOT addressed (informational, not regressions)

- `ts_telemetry` Stage-9 write loss — pipeline trace shows SUCCESS but no row appears in `ts_telemetry`. Pre-existing pattern from before Phase 1. Worth a separate investigation.
- `digilog/v1/cwh-block/cwh-ahu-01/cwhf0500-01` UNS mapping points at deleted AssetInstance `38b69a22-…`. `mqtt-handler` silently drops messages from that device. Worth a single-line "no entity" debug log in mqtt-handler so this failure mode is discoverable without code edits.

Safe to compact now.
