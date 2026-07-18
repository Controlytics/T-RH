# Session resume state — 2026-05-04 P0 compliance branch (Part 3)

Cold-start guide. Read this and you have everything to pick up.

## Where we are

**Worktree:** `C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification`
**Branch:** `fix/p0-compliance-2026-05-04`
**HEAD:** `51d3cf3`
**Origin:** branch pushed to `origin/fix/p0-compliance-2026-05-04` — **17 commits deep**.
**Working tree:** clean except `M DigiLog-FilterOps.apk` (carried from prior session, uncommitted).

## What this session accomplished (Part 3)

| Commit | Scope |
|---|---|
| `51d3cf3` | telemetry-batcher O(n+m) requeue + drop counters; queue config dead options pruned; cron overlap protection on dlq_check + connectivity_check |
| `2f38cbd` | UPDATE_CONFIG_PAGE wired on 4 surfaces (BE+FE: dashboard-cards / cleaning-profile-assignment / filter-cleaning-reasons via def / ahu-filter-set-config); RBAC role-perms 5s cache + invalidation hooks |
| `74a9cb3` | docs(resume) Part 2 |
| `8e824dd` | PWA skipWaiting + reload-prompt component; email/SMS reauth wrap; sms-settings.tsx collapsed to re-export; UPDATE_CONFIG_PAGE umbrella declared |

**Branch totals:** 17 commits, 8 of 9 P0 closed, ~50 net new tests added across the branch. Test counts: api **1277 / 0 / 8 skipped** (was 1249), web **104 / 104**.

## What's NOT yet done (still pending)

### Open P0 (1)
- **P0 #5 — UI for /bypass + /terminate-cycle** — UX placement decision needed. Backend ready (POST `/api/filters/:id/{bypass,terminate-cycle}` with reauth gates wired and `offlinePerformedAt` parity in commit `48b1320`).

### Compliance follow-ups
- **notification-rules** (12 mutations across `routes/config/notification-rules/index.tsx:208-810`) — needs product decision: granular `CREATE/UPDATE/DELETE_NOTIFICATION_RULE` keys vs reuse `UPDATE_CONFIG_PAGE` umbrella
- **checklist-form signature flow** — `routes/checklist-form/index.tsx:143-184` lacks `SUBMIT_CHECKLIST_WITH_SIGNATURE` wrap (key already exists in REAUTH_ACTIONS); the entire signature-capture UI is also missing (deferred to product)
- **Audit chain verification cron** — `GET /api/audit/verify-chain` exists but no scheduled invocation. Document a cron entry in operator runbook + add a graphile-worker cron task

### Architectural / deferred
- **Decision-tape `tapeVersion` integer overflow** (api-supporting H8b) — aliases past 1e6 events per cycle. Switch to bigint or design TTL
- **`assertTapeVersionFresh` ok-on-null** (api-supporting H8a) — pre-Wave-2 tablets bypass the freshness check; explicit-reject or document
- **~140 bare-string FKs** (data-layer C3) — schema audit. Add `@relation` to UUID columns currently treated as raw strings. Enables the documented `cwhf0500-01` orphan UnsMapping bug class
- **Reports per-entity-assignment authz** — `service.ts:31` has a TODO; needs product decision on whether operators assigned to BlockA can render reports on BlockB
- **Backup OOM at 100MB upload** (api-supporting H3) — restore reads the whole zip into memory. Streaming refactor needed
- **Telemetry batcher alarm hook** (queue H4 follow-up) — drop counters now exist; needs notification infrastructure decision before wiring

### Pre-existing flags (NOT in scope this branch)
- `pm-schedule-crud.ts:138` blocks delete if any `PmExecution.status === 'IN_PROGRESS'` — schedules effectively lock once a PM has been started
- `apps/api/src/modules/assets/services/instance.service.ts:82` guards on `&& data.attributes` truthy — undefined caller skips validation. Defensive future fix
- `apps/web/CLAUDE.md` "Phase 2 Pages" entry points to `routes/checklists/detail.tsx` (now `checklist-admin/`). Stale doc reference

## Operational

### Open the PR
**gh CLI is installed (per prior session) but not on PATH** for new bash sessions. Either:
- Open new shell with `winget`-refreshed PATH and run `gh pr create`
- OR open in browser: **https://github.com/pankajexa/21cfrlogbook/pull/new/fix/p0-compliance-2026-05-04**

### Codex adversarial re-review
Confirm closure of the 9 P0 + the H/M items addressed:
```
/codex:adversarial-review --base main
```
Or chunked by subtree if ENOBUFS hits again (per prior session's resume).

### Browser smoke
Vite at PID 4816 was unhealthy on :5175 (per prior resume). Restart from this worktree before clicking through to verify the FE wraps interactively.

## Operator runbook (NEW environment + deploy steps from this branch)

Documented in **DEPLOY-WINDOWS.md § 10.3** (commit `17950db`). Quick summary:
1. Set `OFFLINE_REPLAY_SECRET` in `apps/api/.env` (32+ char random; required in production/staging)
2. Apply two new migrations: `20260504180000_audit_hash_chain` + `20260504190000_compliance_invariants`
3. Tablets must re-login once after the APK update — fetches the new offline-replay grant; queue then drains
4. Verify chain integrity post-upgrade: `GET /api/audit/verify-chain` (SUPER_ADMIN). Expect `intact: true`
5. Roles that should review admin requests must be granted the new `ADMIN_REQUEST_REVIEW` permission

## Test counts

| Suite | Branch start | Current |
|---|---|---|
| api (single-fork) | 1249 / 0 / 8 | **1277 / 0 / 8** (+28 net new tests) |
| web | 104 / 104 | 104 / 104 |

## Quick start for next session

```bash
cd C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification

# Pick up from where we left off:
# 1. Open the PR (browser link above; gh isn't on PATH)
# 2. Run /codex:adversarial-review --base main
# 3. Tackle remaining items from "still pending" — most actionable:
#    - notification-rules wraps (12 sites; needs product key decision first)
#    - audit-verify-chain cron task
#    - tapeVersion bigint migration
```
