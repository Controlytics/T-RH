# Session resume state — 2026-05-05 (flow-audit + 7 fixes)

Cold-start guide. Read this and you have everything to pick up.

## Where we are

**Worktree:** `C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification`
**Branch:** `fix/p0-compliance-2026-05-04`
**HEAD:** `da4c48e`
**Origin:** **20 commits deep on origin** (everything pushed; working tree clean).
**Open PR URL:** https://github.com/pankajexa/21cfrlogbook/pull/new/fix/p0-compliance-2026-05-04

## What this session accomplished (commit `da4c48e`)

Wrote the master flow-trace doc (`tasks/FLOWS-MASTER.md`, 648 lines) for 6 operator flows: block / area / filter / cleaning-profile creation + filter walk-through online + filter walk-through offline+sync. Found 13 issues in the trace. Fixed 7 confirmed real bugs; 4 confirmed not real on closer reading; 1 deferred (schema migration).

| # | Status | One-line |
|---|---|---|
| 1 | ✅ FIXED | Single-filter create silently dropped `filterSet`+`filterProfileId` (data loss) |
| 2 | ✅ FIXED | REAUTH errors silently queued under the C1 grant (operator's password refusal was overridden on replay) |
| 3 | ✅ FIXED | Optimistic offline state didn't bump cached `tapeVersion` → chained ops STALE_TAPE on replay |
| 4 | ✅ verified sound | C3 `equals: null` cast in submit-checklist is correct |
| 5 | ✅ FIXED | `getBatchStates` N+1 → chunked Promise.allSettled (10x wall time) |
| 6 | ✅ FIXED | Equipment-group snapshot fall-through silently returned wrong dropdowns → now emits `snapshotMissing` flag |
| 7 | ✅ FIXED | Block-change approval consumed OUTSIDE start-cycle tx → moved inside row lock with `BLOCK_CHANGE_RACE` 409 |
| 8 | ✅ not a bug | Phase A.1 ChecklistProfileVersion pinning already handles disabled-mid-cycle |
| 9 | ✅ FIXED | `getFilterHomeBlock` ran on every /current-state poll → skipped mid-cycle |
| 10 | ✅ already OK | Backup self-ref pass-2 already wrapped in $transaction |
| 11 | ✅ FIXED | PWA reload-prompt 60s polling burned cache window on hidden tabs → pauses now |
| 12 | ✅ not a bug | `/api/health` is in PUBLIC_PATHS — no 401 path exists |
| 13 | ⏸ DEFERRED | `tapeVersion` bigint overflow at 1e6 events/cycle — needs schema migration |

## Branch totals (since branch start)

| | |
|---|---|
| Commits on branch | 20 |
| New tests added | ~30 |
| api suite | 1277 / 0 / 8 (was 1249 at branch start) |
| web suite | 104 / 104 |
| P0 audit findings closed | 8 of 9 (only #5 — bypass/terminate UI placement — remains, backend ready) |

## Recent commit chain (newest first)

| Commit | Scope |
|---|---|
| `da4c48e` | 7 flow-audit fixes + tasks/FLOWS-MASTER.md (648 lines) + 2 supporting trace files |
| `1574724` | APK rebuild (8.4 MB) carrying the FE bundle |
| `fa3de2a` | Part 3 resume doc |
| `51d3cf3` | telemetry batcher hardening + queue config cleanup |
| `2f38cbd` | UPDATE_CONFIG_PAGE on 4 surfaces + RBAC role-perms 5s cache |
| `74a9cb3` | Part 2 resume doc |
| `8e824dd` | PWA skipWaiting + reload-prompt + email/SMS reauth + sms-settings collapse |
| `5da1292` | doc-sync — CLAUDE.md + CHANGELOG |
| `48b1320` | template-kinds reauth + useBlockChangeApproval hook + offline-time parity |
| `2596196` | 4 sensitive-config reauth + shared cleanup |
| `679e642` | reports entitySlots authz + backup chain-verify on restore |
| `d322fc7` | centralized JWT refresh |
| `d685e1e` | nav.onLine residue + partial-sync surfacing |
| `389495e` | Part 1 resume doc |
| `17950db` | compliance invariants → migration + DEPLOY-WINDOWS § 10.3 |
| `7dc339c` | tamper-evident audit hash chain + GET /api/audit/verify-chain |
| `a139fcb` | HMAC-signed offline-replay grant (replaces header bypass) |
| `f6d1282` | bounded offlinePerformedAt |
| `b8fb038` | 6 FE reauth.execute skip sites + UPDATE_REAUTH_CONFIG |
| `7e5839a` | priv escalation + missing reauth actions + start-cycle race + submit-checklist null-state |

## Pending (NOT yet done)

### Open code-review items
- **P0 #5** — UI for `/bypass` + `/terminate-cycle` (UX placement decision; backend ready)
- **#13 deferred** — `tapeVersion` bigint overflow (schema migration)
- **notification-rules** (12 mutation sites in `routes/config/notification-rules/index.tsx:208-810`) — needs product key decision
- **checklist-form signature flow** — needs product UI decision
- **~140 bare-string FKs** in Prisma schema (data-layer C3) — schema audit
- **Audit chain verification cron** — `GET /api/audit/verify-chain` exists; need scheduled invocation
- **Reports per-entity-assignment authz** — `service.ts:31` TODO
- **Backup OOM at 100MB upload** — streaming refactor
- **Telemetry batcher alarm hook** — drop counters now exist; needs notification infrastructure decision

### Operational
- **Open the PR** — gh CLI installed but not on PATH; click through:
  https://github.com/pankajexa/21cfrlogbook/pull/new/fix/p0-compliance-2026-05-04
- **Codex adversarial re-review** — `/codex:adversarial-review --base main` (or chunked)
- **Deploy locally for testing** — see start-up steps below

## Operator runbook (P0 branch deploy notes)

DEPLOY-WINDOWS.md § 10.3 has the canonical operator runbook. Quick summary:

1. **Set `OFFLINE_REPLAY_SECRET`** in `apps/api/.env` (32+ char random; required in production/staging):
   ```powershell
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```
2. **Apply two new migrations** (in addition to the prior drift catch-up):
   - `20260504180000_audit_hash_chain` (chain columns)
   - `20260504190000_compliance_invariants` (1-IN_PROGRESS index + 3 triggers)
3. **Tablets must re-login once after the APK update** (fetches the new offline-replay grant)
4. **Verify chain integrity post-upgrade**: `GET /api/audit/verify-chain` (SUPER_ADMIN). Expect `intact: true` on rows written post-migration
5. **Roles that should review admin requests** — manually grant `ADMIN_REQUEST_REVIEW` permission via role-config UI (auto-receive: SUPER_ADMIN + ADMIN)

## Quick start for next session

```bash
cd C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification
git status                            # clean
git log --oneline -5                  # confirm da4c48e at HEAD

# Local dev:
# Terminal 1 — API on :3000 (HTTPS via mkcert)
cd apps/api && npx tsx watch src/app.ts

# Terminal 2 — Vite on :5175 (HTTP, proxies /api to :3000)
cd apps/web && npx vite --host

# Browser:
# - https://localhost:3000  (production-style: API + bundled web)
# - http://localhost:5175   (Vite dev with HMR; calls API at https://localhost:3000)
# - https://localhost:3000/docs (Swagger)

# Login: superadmin / Admin@123 (forced change on first login)
```
