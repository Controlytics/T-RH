# Session resume state — 2026-05-04 P0 compliance branch (Part 2)

Cold-start guide. Read this and you have everything to pick up.

## Where we are

**Worktree:** `C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification`
**Branch:** `fix/p0-compliance-2026-05-04`
**HEAD:** `8e824dd`
**Origin:** branch pushed to `origin/fix/p0-compliance-2026-05-04`
**Working tree:** clean except `M DigiLog-FilterOps.apk` (carried from prior session, uncommitted).

## Branch totals

**14 commits** on this branch. Test counts: api **1277 / 0 / 8 skipped** (was 1249 at branch start), web **104 / 104**.

## Commit chain (newest first)

| Commit | Scope |
|---|---|
| `8e824dd` | PWA skipWaiting + reload-prompt component, email/SMS reauth wrap, sms-settings.tsx collapsed to re-export, declared UPDATE_CONFIG_PAGE umbrella action |
| `5da1292` | doc-sync — CLAUDE.md System Stats refresh + CHANGELOG entry for branch |
| `48b1320` | template-kinds reauth (BE+FE) + useBlockChangeApproval hook + offlinePerformedAt parity for bypass + terminate-cycle |
| `2596196` | 4 sensitive-config reauth gaps (access-matrix / ldap / audit single + bulk delete) + shared cleanup (15 PERMISSION_META + stale organizations + 4 dead files) |
| `679e642` | Reports entitySlots input validation + backup chain-verify on restore |
| `d322fc7` | Centralize JWT refresh — fixes silent no-op on Capacitor APK |
| `d685e1e` | Drop navigator.onLine residue + surface partial-sync failures |
| `389495e` | docs(resume) for end of part 1 |
| `17950db` | Compliance invariants → migration + DEPLOY-WINDOWS § 10.3 runbook |
| `7dc339c` | Tamper-evident audit hash chain |
| `a139fcb` | HMAC-signed offline-replay grant (replaces header bypass) |
| `f6d1282` | Bounded offlinePerformedAt — replay-only + drift caps + cycle floor |
| `b8fb038` | 6 FE reauth.execute skip sites + UPDATE_REAUTH_CONFIG meta-policy gate |
| `7e5839a` | priv escalation (admin_requests) + missing reauth actions + start-cycle race + submit-checklist null-state |

## P0 status (from `tasks/CODE-REVIEW-2026-05-04-summary.md`)

**8 of 9 P0 closed.** Only #5 (UI for /bypass + /terminate-cycle) remains — needs UX placement decision; backend ready.

## What's NOT yet done on this branch (still pending — pick up here)

### Sensitive-config reauth (UPDATE_CONFIG_PAGE declared but not wired)

The `UPDATE_CONFIG_PAGE` umbrella reauth action is declared in `packages/shared/src/types/reauth-actions.ts` (commit `8e824dd`). Apply to these 4 FE pages + add `enforceReauth('UPDATE_CONFIG_PAGE')` to the matching backend routes:

| FE page | BE route | line |
|---|---|---|
| `apps/web/src/routes/config/dashboard-cards.tsx:71` | `PUT /api/config/dashboard-cards` | apply both sides |
| `apps/web/src/routes/config/cleaning-profile-assignment.tsx:148` | `PUT /api/config/cleaning-profile-assignment` | apply both sides |
| `apps/web/src/routes/config/filter-cleaning-reasons.tsx:28` | `PUT /api/config/dynamic/filter-cleaning-reasons` | apply both sides |
| `apps/web/src/routes/config/ahu-filter-set-config.tsx:41` | `PUT /api/pm-schedules/ahu-configs/:ahuId` | apply both sides |

Pattern (mirrors prior commits this branch — same file template as `audit/index.tsx` H4 fix):
1. import `api` + `useReauth` + `ReauthDialog`
2. add `const reauth = useReauth();` to component
3. wrap save handler in `reauth.execute('UPDATE_CONFIG_PAGE', async (password?) => { if (password) api.putWithReauth(...) else apiClient.put(...) }, { onSuccess, onError })`
4. mount `<ReauthDialog ... />` at component root

### Backend gates for the 4 surfaces above
Find each route file under `apps/api/src/modules/config/static-routes/*.routes.ts` (or equivalent), import `enforceReauth`, gate the PUT/POST handler:
```ts
const { ok } = await enforceReauth('UPDATE_CONFIG_PAGE', req, reply);
if (!ok) return;
```

### Other pending items (from prior pending list)

- **P0 #5 — UI for /bypass + /terminate-cycle** (UX placement decision; backend has POST `/api/filters/:id/{bypass,terminate-cycle}` with reauth gates already)
- **notification-rules** (12 mutations across `routes/config/notification-rules/index.tsx:208-810`) — needs product decision: granular CREATE/UPDATE/DELETE_NOTIFICATION_RULE keys vs reuse UPDATE_CONFIG_PAGE
- **checklist-form signature flow** — `routes/checklist-form/index.tsx:143-184` — needs `SUBMIT_CHECKLIST_WITH_SIGNATURE` wrap (key already exists in REAUTH_ACTIONS); also missing the entire signature-capture UI (deferred to product)
- **Decision-tape `tapeVersion` integer overflow** — aliases past 1e6 events/cycle. Switch to bigint or design TTL. (api-supporting H8b)
- **RBAC caching** — auth plugin does 3 sequential queries + RBAC does 1 more before every handler. Cache role permissions with 5s TTL or pub/sub invalidation. (api-supporting M11)
- **~140 bare-string FKs** in Prisma schema — data-layer C3. Add `@relation` to UUID columns currently treated as raw strings. Enables the documented `cwhf0500-01` orphan UnsMapping bug class.
- **`entitySlots` per-entity-assignment authz** — service.ts:31 has a TODO comment; needs product decision on whether operators assigned to BlockA can render reports about BlockB.

## Operator runbook (NEW environment + deploy steps from this branch)

Documented in **DEPLOY-WINDOWS.md § 10.3** (commit `17950db`). Quick summary:

1. **Set `OFFLINE_REPLAY_SECRET`** in `apps/api/.env` (32+ char random; server refuses to boot in production/staging without it)
2. **Apply two new migrations** in addition to § 10.1's drift migration:
   - `20260504180000_audit_hash_chain` (chain columns)
   - `20260504190000_compliance_invariants` (1-IN_PROGRESS + 3 triggers)
3. **Tablets must re-login once after the APK update** to fetch the new offline-replay grant. Pre-upgrade queued ops will fail with `OFFLINE_REPLAY_HEADER_DEPRECATED` on first replay
4. **Verify chain after upgrade**: `GET /api/audit/verify-chain` (SUPER_ADMIN). Expect `intact: true` on rows written post-migration
5. **Roles that should review admin requests** must be granted the new `ADMIN_REQUEST_REVIEW` permission (SUPER_ADMIN + ADMIN auto-receive via seed; other roles need manual grant via role-config UI)

## Test counts

| Suite | Branch start | Current |
|---|---|---|
| api (single-fork) | 1249 / 0 / 8 | **1277 / 0 / 8** (+28 net new tests) |
| web | 104 / 104 | 104 / 104 |

## To save the cleanup before stopping

```bash
cd /c/Users/hello/21cfrlogbook-DigitalFMS/.worktrees/phase5-verification
git add tasks/RESUME-STATE-2026-05-04-p0-compliance-PART2.md
git commit -m "docs(resume): 2026-05-04 P0 compliance Part 2 end-of-session state"
git push origin fix/p0-compliance-2026-05-04
```

## Quick start for next session

```bash
# Pick up where we left off — apply UPDATE_CONFIG_PAGE wraps:
cd C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification

# 1. Backend gates (4 routes):
#    - apps/api/src/modules/config/static-routes/dashboard-cards.routes.ts (or wherever the route lives)
#    - same for cleaning-profile-assignment, filter-cleaning-reasons (under config/dynamic)
#    - apps/api/src/modules/pm-schedules/routes.ts for /ahu-configs/:id
# 2. FE wraps (4 pages — see "Sensitive-config reauth" section above)
# 3. Then verify: shared rebuild → web type-check → web tests
# 4. Commit + push

# OR work on P0 #5 (bypass/terminate UI) if UX placement decided
```
