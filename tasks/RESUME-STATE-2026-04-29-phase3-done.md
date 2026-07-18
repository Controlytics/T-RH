# Session resume — 2026-04-29 (Phase 3 complete, Phase 4+5 pending)

If you're reading this in a NEW or post-compact session, this is your cold-start guide.

## TL;DR

`windows-friendly-rewrite` plan is **3 of 5 phases done**. All tests in the
workspace pass (1279/1279). Next milestone is Phase 4 (tooling cleanup) +
Phase 5 (verification + docs), planned to be executed via the
`superpowers:subagent-driven-development` skill — that workflow was just
loaded and ready to dispatch task-by-task with two-stage review.

## What's done (this session)

**Phase 1 (Mosquitto MQTT swap)** — already completed in prior session.
- Branch `feature/phase1-mosquitto-rewrite` HEAD `059f7a5`.
- One follow-up bug-fix commit landed THIS session as part of windows_dep:
  `0ecc151 fix(mosquitto): make install script produce a service-bootable conf`
  (rewrites relative paths -> absolute, swaps `log_dest stdout` -> file logging,
  because the SCM-managed broker has CWD=System32 and no stdout).

**Phase 2 (BullMQ → graphile-worker)** — already completed.
- Branch `feature/phase2-pg-queue` HEAD `0ecc151` (now includes the Mosquitto
  install fix above).
- Live e2e MQTT round-trip verified during the elevated install:
  `mosquitto_pub` → broker → API → graphile-worker `ingestion` task →
  `ts_pipeline_traces` row in `digilog_tsdb`.

**Phase 3 (Reports module Windows hardening)** — completed THIS session.
- Branch `feature/phase3-reports-edge` HEAD `b2c3b37`.
- 3 feature commits + 2 test-cleanup commits:
  - `79937b7 feat(reports): edge-detector helper for puppeteer-core executablePath`
  - `abdc9dd feat(reports): switch pdf-renderer from puppeteer to puppeteer-core + Edge`
  - `d72d44c feat(reports): replace chartjs-node-canvas with @napi-rs/canvas`
  - `06bcb95 fix(tests): bring apps/api vitest suite back from 30 failed files / 65 failed tests to 11 / 14`
  - `b2c3b37 fix(tests): zero failed tests across the workspace`
- Live-verified end-to-end: `POST /api/reports/generate` against Filter Report
  template produced `e7432d7f-3431-47db-93d6-d86ef9f5cf16.pdf` (59,085 bytes,
  `%PDF-1.4` header, `%%EOF` trailer); GET /pdf served the same bytes.

**Test cleanup (Phase 3 follow-up)** — completed THIS session.
- Brought apps/api Vitest sweep from `30 failed files / 65 failed tests` down
  to `0/0`. Followed deep-fix discipline: matched tests to actual impl
  behaviour, restored a real impl regression in shared/schemas/users.ts +
  assets.ts (unbounded `limit` was a DoS surface — re-added `max(100)` +
  defaults), fixed a real impl bug in `apps/api/src/modules/config/routes.ts`
  where the hardcoded reauth fallback only read `body._currentPassword` but
  the dynamic path and tests use `x-reauth-password` header.

**Branch state on origin (no pushes this session — all local):**

| Branch | HEAD | Status |
|---|---|---|
| `main` | (untouched, user's instruction) | Production baseline |
| `windows_dep` | `b2c3b37` | **Integration branch** — Phase 1 + Phase 2 + Phase 3 + test fixes |
| `feature/phase1-mosquitto-rewrite` | `059f7a5` | Phase 1 |
| `feature/phase2-pg-queue` | `0ecc151` | Phase 2 + Mosquitto install fix |
| `feature/phase3-reports-edge` | `b2c3b37` | Phase 3 + test fixes |
| `docsCleaned` | `30cb462` | Documentation cleanup (older work) |

**Local-only fact:** the install fix `0ecc151` lives on the Phase 2 branch
even though it semantically belongs to Phase 1 (it's a fix to the Phase 1
Mosquitto install script). Pragmatic choice — minimal-disruption commit
on the integration branch. If you want a clean Phase 1 PR, cherry-pick
`0ecc151` onto `feature/phase1-mosquitto-rewrite` and rebase Phase 2 + 3.

**Worktree layout** (still active, do NOT delete without re-reading what's
in each):

| Path | Branch | HEAD |
|---|---|---|
| `C:\Users\hello\21cfrlogbook-DigitalFMS` | `RFID` | `893c0ec` (user's pre-existing work — has 3 modified + 3 untracked files NOT mine) |
| `.worktrees/phase1-mosquitto` | `feature/phase1-mosquitto-rewrite` | `059f7a5` |
| `.worktrees/phase2-pg-queue` | `feature/phase2-pg-queue` | `0ecc151` |
| `.worktrees/phase3-reports` | `feature/phase3-reports-edge` | `b2c3b37` |

**Mosquitto Windows service:** installed, running, auto-start. PID changes
between sessions but listener at `0.0.0.0:1883` is active. Will survive
reboot.

## Test pass-rate (snapshot 2026-04-29 ~17:55 GMT+5:30)

```
apps/api          83/83 files, 1123/1123 tests   ✅
packages/shared    5/5  files,  150/150 tests    ✅
packages/queue     3/3  files,    6/6   tests    ✅
─────────────────────────────────────────────────────
TOTAL             91/91 files, 1279/1279 tests   ✅
```

Run from worktree root:
```bash
cd .worktrees/phase3-reports/apps/api    && npx vitest run
cd .worktrees/phase3-reports/packages/shared && npx vitest run
cd .worktrees/phase3-reports/packages/queue  && npx vitest run
```

Three structural pieces are in `apps/api/`:
- `vitest.setup.ts` — loads `.env` so PrismaClient construction finds DATABASE_URL
- `vitest.global-setup.ts` — idempotently upserts: `admin`/`Admin@123` (SUPER_ADMIN),
  `RB0001`/`Test@1234` (OPERATOR), and the `VIEWER` system role
- `vitest.config.ts` — `fileParallelism: false` (tests share the `admin` user/session)

These ride along with the test-fix commits and are required to keep the suite
green in any future session.

## What's NOT done — the next milestones

**Phase 4 — Tooling cleanup** (5 sub-tasks). Mostly mechanical file edits.

| Task | File(s) | Summary |
|---|---|---|
| 4.1 | `scripts/install-on-target.ps1` | Drop Memurai + EMQX install blocks; call `install-mosquitto.ps1`; enable LongPathsEnabled; verify msedge.exe present |
| 4.2 | `scripts/package-for-production.ps1` | Drop Chromium download; drop Memurai bundling; verify `npm ci --prefer-offline` works |
| 4.3 | `apps/api/.env.example` | Drop `REDIS_*`, `MQTT_BROKER_*`, `EMQX_ADMIN_PASSWORD`; add `MOSQUITTO_ADMIN_PASSWORD`, `MOSQUITTO_REFRESH_TOKEN`, `MOSQUITTO_DYNSEC_PATH` |
| 4.4 | `windowsIssues.md` | Mark §1 (Puppeteer), §2 (chartjs-node-canvas), §3 (EMQX), §7 (Memurai) as resolved with commit hashes |
| 4.5 | Many root docs | Update `LOCAL_SETUP_WINDOWS.md`, `DEPLOY-WINDOWS.md`, `README.md`, `CLAUDE.md`, `PROJECT_SUMMARY.md`, `PROJECT_ARCHITECTURE.md`, `BACKEND_GUIDE.md`, `future/overview/CODEBASE_SUMMARY.md`, `future/overview/CURRENT_STATUS.md`, `future/qa/KNOWN_ISSUES.md`, `docs/index.md`, `tasks/todo.md`. Run live-count verification first. |

**Phase 5 — Verification & docs finalization** (3 sub-tasks).

| Task | File(s) | Summary |
|---|---|---|
| 5.1 | `tests/integration/windows-server-stack.test.ts` (new) | INTEGRATION_TEST=1-gated suite: boot API, enqueue export, MQTT publish 100 msgs against in-process aedes mocking Mosquitto, generate test PDF, assert TimescaleDB rows |
| 5.2 | `scripts/verify-windows-deployment.ps1` (new) | Smoke-check API health, Mosquitto port, graphile-worker schema, generate 1-page PDF |
| 5.3 | (publish) | `git push origin HEAD:docsCleaned`, open PR `docsCleaned → RFID` |

Full task text lives in `docs/plans/2026-04-29-windows-friendly-rewrite.md`
lines 1568-1645.

## How to resume

The workflow skill `superpowers:subagent-driven-development` was loaded right
before this save. The intended flow:

1. Create a Phase 4 worktree from `windows_dep`:
   ```bash
   git worktree add -b feature/phase4-tooling .worktrees/phase4-tooling windows_dep
   ```
2. Follow the skill: extract Phase 4 tasks → TaskCreate → dispatch implementer
   subagent per task → spec review → code quality review → next task.
3. After Phase 4 → Phase 5 the same way.
4. After both phases pass review, FF `windows_dep` to the new HEAD and
   optionally push to origin.

**Resume prompt to use:**

```
Continue executing the windows-friendly-rewrite plan via
superpowers:subagent-driven-development. Phase 3 + test fixes already
landed on windows_dep at b2c3b37. See
tasks/RESUME-STATE-2026-04-29-phase3-done.md for the full handoff.

Start by creating the Phase 4 worktree
(feature/phase4-tooling from windows_dep), extracting all 5 Phase 4
tasks from docs/plans/2026-04-29-windows-friendly-rewrite.md
(lines 1568-1610), creating TaskCreate entries, and dispatching the
implementer subagent for Task 4.1.
```

## Things to NOT touch in next session

- `main` branch (user explicit: "lets not disturb main for some time")
- The 3 modified + 3 untracked files in the main checkout (`RFID` branch) —
  pre-existing work, NOT related to the rewrite
- `feature/phase1-mosquitto-rewrite` — keep as-is; it's the basis for any
  future Phase-1-only PR
- The Phase 3 worktree's uncommitted `apps/api/uploads/` — runtime artifact
  from the e2e PDF test, gitignored anyway

## Key decisions made this session (worth carrying forward)

- **edge-detector candidate order:** Edge first (preinstalled on Win10+/
  Server 2019+), then Chrome, then Linux/macOS fallbacks. PUPPETEER_EXECUTABLE_PATH
  overrides everything.
- **chart-renderer adds explicit white background fill** because chart.js
  leaves the canvas transparent by default and PDF embedders expect opaque.
- **Mosquitto install script rewrites the deployed conf, not the source.**
  Source `mosquitto.windows.conf` keeps relative paths + stdout (works for dev
  foreground from `mosquitto/` cwd); install script produces an absolute-path
  + file-logging version in `C:\Program Files\mosquitto\mosquitto.conf`.
- **vitest.global-setup.ts is idempotent** — uses upsert semantics. Safe to
  run on every test launch even if dev DB state varies.
- **fileParallelism: false** in vitest config — required because e2e tests
  share the `admin` session row. Don't re-enable parallelism without first
  giving each test file its own login identity.

## Memory updates this session

- `feedback_mosquitto_windows_service_install` — service CWD=System32, no stdout
- `feedback_mosquitto_dynsec_install_dir` — refresh-acl writes to repo, broker reads install dir
- `project_orphan_uns_mapping_cwhf0500` — `cwh-block/cwh-ahu-01/cwhf0500-01` UnsMapping orphaned

## Pre-existing issues NOT addressed this session (informational)

- `ts_telemetry` Stage-9 write loss — pipeline trace shows SUCCESS but no row
  appears in `ts_telemetry`. Pre-existing pattern from before Phase 1; flagged
  in earlier resume note. Not a Phase-1/2/3 regression.
- `digilog/v1/cwh-block/cwh-ahu-01/cwhf0500-01` UNS mapping points at deleted
  AssetInstance `38b69a22-…`. mqtt-handler silently drops messages from that
  device. Worth a single-line "no entity" debug log in mqtt-handler so this
  failure mode is discoverable without code edits.
