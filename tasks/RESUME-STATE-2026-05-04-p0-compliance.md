# Session resume state — 2026-05-04 (P0 compliance branch)

Cold-start guide. Read this and you have everything to pick up.

## Where we are

**Worktree:** `C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification`
**Branch:** `fix/p0-compliance-2026-05-04` (off `feature/phase5-verification`)
**HEAD:** `17950db`
**Origin:** **NOT pushed yet** — branch lives only locally.
**Working tree:** clean except `M DigiLog-FilterOps.apk` (rebuilt prior session, uncommitted).

## What this session accomplished

Six commits stacked on `fix/p0-compliance-2026-05-04`. Closed **8 of 9 P0 findings** from the 2026-05-04 adversarial code review (`tasks/CODE-REVIEW-2026-05-04-summary.md`).

| Commit | Findings closed |
|---|---|
| `7e5839a` | priv escalation (admin_requests), missing reauth actions (UPDATE_EMAIL/SMS_CONFIG), start-cycle race, submit-checklist null-state |
| `b8fb038` | 6 FE reauth.execute() skip sites + new UPDATE_REAUTH_CONFIG meta-policy gate |
| `f6d1282` | bounded offlinePerformedAt — replay-only + 5min future-skew + 30day stale + cycle-start floor |
| `a139fcb` | HMAC-signed offline-replay grant — replaces unauthenticated `x-offline-replay: true` header bypass |
| `7dc339c` | tamper-evident audit hash chain — previous_checksum + advisory lock + GET /api/audit/verify-chain |
| `17950db` | compliance invariants moved from seed.ts to dedicated migration; DEPLOY-WINDOWS § 10.3 runbook |

## P0 status (from `tasks/CODE-REVIEW-2026-05-04-summary.md`)

| # | Finding | Status |
|---|---|---|
| 1 | x-offline-replay header bypass | ✅ HMAC grant via `POST /api/auth/offline-grant` |
| 2 | Unbounded offlinePerformedAt | ✅ replay-only + drift caps + cycle floor |
| 3 | Audit hash-chain | ✅ schema + advisory-lock writer + verify endpoint |
| 4 | 6 FE reauth.execute skip sites | ✅ all 6 wrapped + new UPDATE_REAUTH_CONFIG |
| 5 | UI for /bypass /terminate-cycle | ⏸ OPEN — UX placement decision needed |
| 6 | admin_requests.view → USER_CREATE | ✅ new ADMIN_REQUEST_REVIEW perm |
| 7 | UPDATE_EMAIL/SMS_CONFIG missing | ✅ added to REAUTH_ACTIONS |
| 8 | start-cycle race | ✅ SELECT ... FOR UPDATE |
| 9 | submit-checklist null-state false 409 | ✅ equals: null instead of undefined |
| (data C2) | invariants in seed.ts only | ✅ moved to migration |

**Only #5 left** — backend is ready (`POST /api/filters/:id/bypass` + `terminate-cycle` are live with reauth gates); FE just needs UI placement decision (operations page? status page? both?) then the standard reauth.execute wrap.

## Test counts

| Suite | Pre-session | Final |
|---|---|---|
| api (single-fork) | 1249 / 0 failed / 8 skipped | **1277 / 0 / 8** (+28 new tests) |
| web | 104 | 104 (unchanged — no FE behavior changes broke a test) |
| shared | 305 / 306 (1 pre-existing unrelated) | unchanged |

New test files added this session:
- `apps/api/src/lib/offline-time-window.test.ts` (14 unit)
- `apps/api/src/lib/offline-replay-token.test.ts` (6 unit)
- `apps/api/src/e2e/audit-chain.test.ts` (4 e2e)
- 3 new tests added to `apps/api/src/e2e/auth-profile-reauth.test.ts`
- 1 new test added to `apps/api/src/e2e/phase3-rfid-offline.test.ts` (legacy header rejection)
- `apps/api/src/lib/audit.test.ts` rewritten for new chained-write shape

## New files

| Path | Purpose |
|---|---|
| `apps/api/src/lib/offline-time-window.ts` | offlinePerformedAt validator (audit C2) |
| `apps/api/src/lib/offline-replay-token.ts` | HMAC grant sign + verify (audit C1) |
| `apps/api/src/lib/audit-verify.ts` | Hash-chain walker (audit C3) |
| `apps/api/prisma/migrations/20260504180000_audit_hash_chain/migration.sql` | adds previous_checksum + chain_position columns |
| `apps/api/prisma/migrations/20260504190000_compliance_invariants/migration.sql` | installs 1-IN_PROGRESS + 3 triggers |
| `tasks/CODE-REVIEW-2026-05-04-{api-core,api-supporting,web-routes,web-plumbing,shared,data-queue,summary}.md` | Adversarial review reports (committed earlier in session) |

## Operator runbook (NEW environment + deploy steps)

Documented in **DEPLOY-WINDOWS.md § 10.3**. Quick summary:

1. **Set `OFFLINE_REPLAY_SECRET`** in `apps/api/.env` (32+ char random; server refuses to boot in production/staging without it):
   ```powershell
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```
2. **Apply two migrations** in addition to § 10.1's drift migration:
   - `20260504180000_audit_hash_chain` (adds chain columns)
   - `20260504190000_compliance_invariants` (1-IN_PROGRESS + 3 triggers)
   ```powershell
   cd C:\DigiLog\api; npx prisma migrate deploy
   ```
3. **Tablets must re-login once after the APK update** to fetch the new offline-replay grant. Pre-upgrade queued offline ops will fail on first replay (`OFFLINE_REPLAY_HEADER_DEPRECATED`); operator re-performs each.
4. **Verify chain after upgrade**: `GET /api/audit/verify-chain` (SUPER_ADMIN). Expect `intact: true` on rows written post-migration.
5. **Roles that should review admin requests** must be granted the new `ADMIN_REQUEST_REVIEW` permission (SUPER_ADMIN + ADMIN auto-receive via seed; other roles need manual grant via role-config UI).

## Pending items (carried forward)

### Open P0 (one item only)
- **Add UI for /bypass /terminate-cycle** (web-routes review C2). Backend ready (`POST /api/filters/:id/{bypass,terminate-cycle}` with reauth gates). UX placement decision: operations page vs status page vs both. Standard reauth.execute wrap once placed.

### Architectural / cross-cutting (deferred from review)
- **Tablet/web duplication in approvals** — `web-routes` review H1: extract `useBlockChangeApproval()` hook so `routes/approvals/index.tsx` and `routes/mobile/mobile-wrapper.tsx` don't drift. Both wrap reauth correctly now (this session's commit `b8fb038`); just structural follow-up.
- **8 sensitive-config surfaces lack reauth coverage** (web-routes H — access-matrix, ldap, template-kinds, audit deletion, notification-rules, dashboard-cards, cleaning-profile-assignment, filter-cleaning-reasons, notification-settings, ahu-filter-set-config). Each needs a product/compliance decision on action-key vocabulary (use existing or coin a new key) before code change.
- **Bounded `offlinePerformedAt` not yet wired into bypass + terminate-cycle**. start-cycle, advance, submit-checklist all use it. The other two write paths still use server clock unconditionally — defensive but not strictly wrong; they should match the pattern.
- **Audit chain verification cron** — `GET /api/audit/verify-chain` exists but no scheduled invocation. Document a cron entry in operator runbook.

### Operator-decision-bound
- **Push branch to origin** — `fix/p0-compliance-2026-05-04` is local only. Decide whether to push to `feature/phase5-verification`, `docsCleaned`, or open a fresh PR.
- **Codex adversarial review** — option (per prior resume doc): `--base main` for branch-delta review, OR re-run `tasks/CODE-REVIEW-2026-05-04-*.md` against this branch's fixes to confirm closure.

### Docs to refresh after this lands
- **CLAUDE.md System Stats** still reads 109/91/87/26. Actuals from this session: 106/91/89 (added ADMIN_REQUEST_REVIEW + UPDATE_EMAIL_CONFIG + UPDATE_SMS_CONFIG + UPDATE_REAUTH_CONFIG = 91 total reauth, +1 from prior 88 because ISSUE_OFFLINE_REPLAY_GRANT was added then removed — verify with grep).
- **packages/shared/CLAUDE.md** — same count refresh.
- **CHANGELOG.md** — add a 2026-05-04 P0 audit-fix entry summarizing the 6 commits.

## Constraint violations to remember

- Dev API server (PID 6324) holds the Prisma engine DLL open during `prisma generate`, blocking regeneration. Workaround: use `$queryRaw`/`$executeRaw` for schema additions instead of relying on regenerated types. Was hit when adding chain_position + previous_checksum.
- The prisma `_prisma_migrations` table is empty in this dev DB — `prisma migrate deploy` errors with `P3005 The database schema is not empty`. For new migrations, use `prisma db execute --file <migration>.sql` directly. Production deploy still uses `prisma migrate resolve --applied <name>` followed by `prisma migrate deploy` per DEPLOY-WINDOWS § 10.1.

## To save the cleanup before stopping

```bash
cd /c/Users/hello/21cfrlogbook-DigitalFMS/.worktrees/phase5-verification
git add tasks/RESUME-STATE-2026-05-04-p0-compliance.md
git commit -m "docs(resume): 2026-05-04 P0 compliance end-of-session state"
git push origin HEAD:fix/p0-compliance-2026-05-04
# OR push to existing feature branch if preferred
```

(The APK is intentionally left uncommitted — needs decision whether to track post-fix rebuild.)
