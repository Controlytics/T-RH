# Sidebar RBAC — Phase 4 Implementation Plan (Per-Page View Granularity — Full Split)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Checkbox (`- [ ]`) steps.

**Goal:** Give each shared-read sidebar page its own **dedicated, deny-capable View permission**, so an admin can grant or withhold access to one page independently — replacing the broad `ASSET_READ` / `CYCLE_READ` / `PM_READ` reads that today expose a whole group at once.

**Approach (user decision 2026-06-30): FULL SPLIT.** Add narrow `*_VIEW` perms, gate each page's route + primary data endpoint on the narrow perm ONLY (not the broad read), and migrate every existing role to the narrow perms so nobody loses access. This is the deny-capable option — and the highest-risk phase in the whole redesign.

---

## ⚠️ SCOPE REALITY CHECK — read before executing

The page-view summary said "every role must be granted the right narrow perms or it loses access." Two things make this **harder than a simple gate swap**, and you should confirm you're OK with them before execution (planning is safe; the destructive part is the migration):

1. **The broad reads are NOT page-private — they back shared sub-resources too.** `ASSET_VIEW`/`ASSET_READ` gates the hierarchy/block/area/AHU **dropdowns** and asset-instance reads used by *many* pages (Filters, Cleaning Record, Lifecycle Report, Equipment Groups…). We canNOT remove `ASSET_VIEW` globally. So the split is: **the page's ROUTE GUARD + its PRIMARY list/report endpoint** move to the narrow `*_VIEW` perm; **shared sub-endpoints (dropdowns) stay on `ASSET_VIEW`**. Consequence: a role granted *only* a narrow perm (e.g. `LIFECYCLE_VIEW`) but not `ASSET_VIEW` would reach the Lifecycle page but its block/area dropdowns would be empty/403. **So "view only this page" realistically means narrow-perm + a baseline `ASSET_VIEW`.** True page-level *deny* still works (withhold the narrow perm → route + primary data blocked); true page-level *grant in isolation* is limited by shared dropdowns. This is inherent to how the pages were built, not a plan choice.

2. **Cleanly-separable vs. dropdown-coupled pages:**
   - **Cleanly separable** (single primary endpoint, client-side export, no shared dropdowns): Retirement List, Replacement List (list tab), RFID Track Record, Deviations. Full split is clean here.
   - **Dropdown-coupled** (primary endpoint + shared `ASSET_VIEW` hierarchy dropdowns): Filter Cleaning Record, Filter Lifecycle Report. The narrow perm gates route + primary data; dropdowns stay `ASSET_VIEW`.

3. **Live-DB migration is mandatory and lockout-risky.** Changing a gate from `ASSET_READ` to `RETIREMENT_VIEW` means every role that sees the page today loses it **unless** its `roles.permissions` row already contains `RETIREMENT_VIEW`. Seed changes only affect fresh installs — the **live `digilog_db` roles must be UPDATEd too** (memory: role perms go stale after seed-only changes). Get the per-role matrix (below) wrong and you lock real users out.

> If after reading this you'd rather do the safer additive-any-of variant (broad read still works, narrow perm adds delegation, zero lockout) or defer to Phase 5, say so before execution. Otherwise this plan implements the full deny-capable split.

**Filters page (`/filter-list`) stays on `ASSET_VIEW`** — it IS the canonical asset list; its "view" permission *is* asset view. Splitting it from `ASSET_VIEW` would be circular (the dropdowns it shares ARE its own data). Equipment Groups already has its own `EG_VIEW` (any-of with ASSET_READ) — left as-is. This phase covers the **6 report/list pages** that have no dedicated view perm today.

## Global Constraints

- **Preserve current default access exactly.** Every role keeps the pages it can reach today (the migration matrix below is derived from the live seed reads). The only *new* capability is the ability to withhold a page independently going forward.
- **New perms are additive to the catalog**, then the gates SWAP from broad→narrow (the behavior-changing step). Do them in that order so the perms exist before anything references them.
- New `*_VIEW` perms must be added to `packages/shared/src/types/permissions.ts`, the `PERMISSION_TREE` nodes (replacing the `enf:'b'` tags with the real perm), `FEATURE_PRIVILEGES` + `FEATURE_TO_PERMISSION_MAP` (so they appear as admin toggles), and `default-roles.ts` (per the matrix). Rebuild `@digilog/shared` after each.
- **Live-DB role sync** required (Task 4.7) — not just seed.
- Runtime curl verification owed (deny-capability must be *proven*: a role without `RETIREMENT_VIEW` gets 403 on the list; with it, 200). git-bash heredoc commits; one commit per task; branch `RFID`.

---

## New permissions (6)

| Perm | Page | Route | Primary endpoint (gate swaps to this perm) | Backed-by-today |
|---|---|---|---|---|
| `RETIREMENT_VIEW` | Retirement List | `/filter-retirements` | `GET /api/filters/retirements` | `ASSET_READ` |
| `REPLACEMENT_VIEW` | Replacement List | `/filter-replacements` | `GET /api/filters/replacements` | `ASSET_READ` |
| `RFID_TRACK_VIEW` | RFID Track Record | `/rfid-track-record` | `GET /api/assets/identifiers/track-record` | `ASSET_VIEW`\|`FILTER_RFID_MANAGE` |
| `CLEANING_RECORD_VIEW` | Filter Cleaning Record | `/cleaning-cycles` | `GET /api/filters/cleaning-record` | `CYCLE_READ` |
| `LIFECYCLE_VIEW` | Filter Lifecycle Report | `/filter-lifecycle-report` | `GET /api/filters/cycles`, `/manual-status-changes` | `CYCLE_READ` |
| `DEVIATIONS_VIEW` | Deviations | `/deviations` | `GET /api/pm-schedules/deviations` | `PM_READ` |

> Dropdown-coupled pages (Cleaning Record, Lifecycle) keep their hierarchy/`ASSET_VIEW` sub-endpoint calls unchanged — only the primary cycle/record endpoints + route guard move to the narrow perm.

## Per-role migration matrix (preserve current access — derived from live seed reads)

SUPER_ADMIN bypasses all gates (no grants needed). Grant each role the narrow perms for pages it reaches **today**:

| Role | has ASSET_READ | has CYCLE_READ | has PM_READ | → grant |
|---|---|---|---|---|
| ADMIN | ✓ | ✓ | ✓ | all 6 |
| SUPERVISOR | ✓ | ✓ | ✓ | all 6 |
| MAINTENANCE | ✓ | ✓ | ✓ | all 6 |
| OPERATOR | ✓ | ✓ | ✓ | all 6 |
| VIEWER | ✓ | ✗ | ✗ | RETIREMENT_VIEW, REPLACEMENT_VIEW, RFID_TRACK_VIEW only |

(VIEWER does NOT get CLEANING_RECORD_VIEW / LIFECYCLE_VIEW / DEVIATIONS_VIEW — it has neither CYCLE_READ nor PM_READ today, so it cannot see those pages now and must not gain them.)

---

## Task 4.1: Add the 6 permission constants + catalog wiring (additive, no gate swaps yet)

**Files:** `packages/shared/src/types/permissions.ts`, `feature-privileges.ts`, `permission-tree.ts`, `default-roles.ts`

- [ ] **Step 1: Add constants** to `permissions.ts` `PERMISSIONS` (with a comment block "Per-page view permissions (Phase 4)"): `RETIREMENT_VIEW`, `REPLACEMENT_VIEW`, `RFID_TRACK_VIEW`, `CLEANING_RECORD_VIEW`, `LIFECYCLE_VIEW`, `DEVIATIONS_VIEW` (self-mapped string literals, matching the file's convention).
- [ ] **Step 2: Add feature privileges** in `feature-privileges.ts` — a `FEATURE_PRIVILEGES` entry per perm (id e.g. `retirement.view`, label `View Retirement List`, category `Filter Management` / `Reports`, an icon) + a `FEATURE_TO_PERMISSION_MAP` entry (`'retirement.view': ['RETIREMENT_VIEW']`, etc.).
- [ ] **Step 3: Update the tree** in `permission-tree.ts` — the existing `retirement.view`/`replacement.view`/`rfid_track.view`/`cleaning_record.view`/`lifecycle.view`/`deviations.view` nodes: change `permissions` from the broad read to the new narrow perm, and `enforce: 'b'` → `'a'`. Update `visibilityPrivilegeIds` on the affected SidebarGroups so the new privilege ids appear.
- [ ] **Step 4: Seed grants** in `default-roles.ts` per the migration matrix above (add the perms to ADMIN/SUPERVISOR/MAINTENANCE/OPERATOR/VIEWER as specified; NOT SUPER_ADMIN — it bypasses).
- [ ] **Step 5: Build + parity tests** — `npm run build -w @digilog/shared`; `npm test -w @digilog/shared -- permission-tree`. The derive-parity tests (1.2/1.3/1.4) will now FAIL because the tree changed but the legacy oracles (`FEATURE_PRIVILEGES`/`FEATURE_TO_PERMISSION_MAP`/`SIDEBAR_PRIVILEGE_MAP`) were ALSO updated in Steps 2-3 — re-run and confirm they pass (the oracle and tree changed together). If a parity test fails, the mismatch names the node/key to reconcile.
- [ ] **Step 6: CFR invariant** — `npm test -w @digilog/api -- role-effective-permissions` passes (new perms are valid constants; maps agree). Commit `feat(rbac): add 6 per-page view permissions + catalog wiring + seed grants (Phase 4, additive)`.

> After Task 4.1 nothing's behavior has changed yet — the new perms exist and are granted, but no endpoint requires them. Each following task swaps one page's gate (the behavior-changing step), independently shippable.

## Tasks 4.2–4.5: Cleanly-separable pages (one gate swap each)

For each, swap the **route guard** (`main.tsx`) and the **primary data endpoint** from the broad read to the narrow perm. These pages have no shared dropdowns, so this is a clean swap.

### Task 4.2 — Retirement List (`RETIREMENT_VIEW`)
- [ ] Route `main.tsx`: `RequireRole permissions={[ASSET_READ/ASSET_VIEW]}` (the `/filter-retirements` route) → `permissions={[PERMISSIONS.RETIREMENT_VIEW]}`.
- [ ] Endpoint `filter-operations/.../routes.ts` `GET /retirements` (analysis: ~`routes.ts:498`, `requirePermission('ASSET_READ')`) → `requirePermission('RETIREMENT_VIEW')`.
- [ ] Verify (owed): a token with ASSET_READ but not RETIREMENT_VIEW → list 403 + route Access Denied; a token WITH RETIREMENT_VIEW → 200. ADMIN/VIEWER (granted in 4.1) still see it. Commit `fix(rbac): gate Retirement List on RETIREMENT_VIEW (Phase 4 full split)`.

### Task 4.3 — Replacement List (`REPLACEMENT_VIEW`)
- [ ] Route `/filter-replacements` → `REPLACEMENT_VIEW`. (The Schedule sub-tab keeps its `REPLACEMENT_SCHEDULE_*` perms — untouched.)
- [ ] `GET /api/filters/replacements` (`ASSET_READ`, ~routes.ts:514) → `requirePermission('REPLACEMENT_VIEW')`.
- [ ] Verify + commit.

### Task 4.4 — RFID Track Record (`RFID_TRACK_VIEW`)
- [ ] Route `/rfid-track-record` → `RFID_TRACK_VIEW`.
- [ ] `GET /api/assets/identifiers/track-record` (`requireAnyPermission('ASSET_VIEW','FILTER_RFID_MANAGE')`, identifier.routes ~:50) → `requireAnyPermission('RFID_TRACK_VIEW','FILTER_RFID_MANAGE')` (keep FILTER_RFID_MANAGE so RFID managers still see it; swap ASSET_VIEW→RFID_TRACK_VIEW).
- [ ] Verify + commit.

### Task 4.5 — Deviations (`DEVIATIONS_VIEW`)
- [ ] Route `/deviations`: currently `[PM_READ, PM_APPROVE]` → `[DEVIATIONS_VIEW]` (align route to the data perm — fixes the §3.5 route⊋data mismatch too).
- [ ] `GET /api/pm-schedules/deviations` (`requirePermission('PM_READ')`, ~routes.ts:550) → `requirePermission('DEVIATIONS_VIEW')`.
- [ ] Verify (owed): PM_READ-only token → deviations 403; DEVIATIONS_VIEW token → 200. Note VIEWER still cannot see it (not granted). Commit.

## Tasks 4.6: Dropdown-coupled pages (Cleaning Record + Lifecycle Report)

### Task 4.6a — Filter Cleaning Record (`CLEANING_RECORD_VIEW`)
- [ ] Route `/cleaning-cycles`: `[CYCLE_READ, VERSION_HISTORY_VIEW]` → `[CLEANING_RECORD_VIEW, VERSION_HISTORY_VIEW]`.
- [ ] Primary endpoint `GET /api/filters/cleaning-record` (`CYCLE_READ`, events-routes ~:67) → `requirePermission('CLEANING_RECORD_VIEW')`. Also the cycle-detail `GET /api/filters/cycles/:id` used by this page's drill-in — gate `requireAnyPermission('CLEANING_RECORD_VIEW','LIFECYCLE_VIEW','CYCLE_READ')` so it serves both report pages without breaking either (it is shared).
- [ ] **Leave hierarchy dropdown endpoints (`/api/hierarchy/*`) on `ASSET_VIEW`** — they're shared. Document that a CLEANING_RECORD_VIEW role also needs ASSET_VIEW for populated dropdowns (all migrated roles have ASSET_VIEW).
- [ ] Verify (owed): CYCLE_READ-only token (no CLEANING_RECORD_VIEW) → cleaning-record 403; with it → 200 + dropdowns populate (role has ASSET_VIEW). Commit.

### Task 4.6b — Filter Lifecycle Report (`LIFECYCLE_VIEW`)
- [ ] Route `/filter-lifecycle-report`: `[CYCLE_READ]` → `[LIFECYCLE_VIEW]`.
- [ ] Endpoints `GET /api/filters/cycles` + `/manual-status-changes` (`CYCLE_READ`, events-routes ~:38,:101) → `requirePermission('LIFECYCLE_VIEW')`. **Caveat:** `GET /api/filters/cycles` may be consumed by other surfaces — `grep -rn "/api/filters/cycles" apps/web/src` FIRST; if another page (e.g. the cycles list elsewhere) needs it under CYCLE_READ, use `requireAnyPermission('LIFECYCLE_VIEW','CYCLE_READ')` instead of a hard swap, and report the finding. (Do not break a shared endpoint — this is the one task that must verify consumers before swapping.)
- [ ] Lifecycle also reads `/api/filters/retirements` + `/replacements` — those are now `RETIREMENT_VIEW`/`REPLACEMENT_VIEW` (Tasks 4.2/4.3). A LIFECYCLE_VIEW role needs those too, OR gate them `requireAnyPermission(...,'LIFECYCLE_VIEW')`. **Decision point:** simplest is to grant lifecycle-capable roles all three (matrix already grants all 6 to ADMIN/SUPERVISOR/MAINTENANCE/OPERATOR), so no extra any-of needed — VIEWER never had lifecycle anyway. Confirm the matrix covers it (it does).
- [ ] Verify + commit.

## Task 4.7: Live-DB role sync (mandatory — prevents lockout on the running system)

**Context:** Seed changes (4.1) only apply to fresh installs. The live `digilog_db` `roles` rows must gain the new perms or existing users lose the pages the moment the gates swap.

- [ ] **Step 1:** Write a one-off idempotent script (or documented psql `UPDATE`) that, for each existing role, appends the matrix's narrow perms to `roles.permissions` (JSONB array) IF absent — never removing anything. Mirror the seed matrix exactly. Provide it as `apps/api/prisma/migrations-data/phase4-grant-view-perms.sql` (or a `tsx` script) so it's repeatable + reviewable. Example shape (psql): for ADMIN/SUPERVISOR/MAINTENANCE/OPERATOR add all 6; for VIEWER add the 3 asset-backed.
- [ ] **Step 2:** Run it against `digilog_db` (this is a real data change — confirm with the user before running; back up the `roles` table first: `pg_dump -t roles`).
- [ ] **Step 3:** Invalidate the role-perms cache (restart API or call the cache invalidator) and verify each role's `/api/auth/me` now includes the new perms.
- [ ] Commit the script (not the data) `chore(rbac): live-DB role-perm grant script for Phase 4 view perms`.

## Task 4.8: Verify access preservation + deny-capability, docs sync

- [ ] **Step 1 — Preservation:** for each non-SA role, confirm via curl (or the checklist) it still reaches every page it reached before Phase 4 (the matrix pages). ZERO pages lost.
- [ ] **Step 2 — Deny-capability proof (the point of this phase):** create/relabel a test role granted `RETIREMENT_VIEW` but NOT `REPLACEMENT_VIEW` → confirm it sees Retirement List but gets 403/Access-Denied on Replacement List. This proves independent per-page control now works.
- [ ] **Step 3 — Docs:** CHANGELOG Phase 4 entry (6 new perms, full split, migration matrix, deny-capability); analysis §2 (flip the `enf:'b'` view nodes to `'a'` with their new perms) + a Phase 4 status note; `packages/shared/CLAUDE.md` permission count (108 → 114); `tasks/todo.md` audit-log. Commit.

---

## Self-Review

**Spec coverage:** the 6 shared-read pages each get a dedicated deny-capable View perm (full split, user-chosen). Filters stays `ASSET_VIEW` (canonical asset list — rationale in scope check); Equipment Groups already has `EG_VIEW`.

**Risk (highest of any phase):** lockout if the live-DB migration (4.7) is wrong or skipped — gated behind explicit user confirmation + a roles-table backup + an idempotent never-remove script. The dropdown-coupled pages (4.6) keep shared endpoints on `ASSET_VIEW` (documented limitation: isolated grant needs baseline ASSET_VIEW). Task 4.6b must grep `/api/filters/cycles` consumers before a hard swap (shared-endpoint guard).

**Sequencing:** 4.1 (additive: perms + grants, zero behavior change) MUST land + the live DB be synced (4.7) BEFORE any gate swap (4.2–4.6), otherwise the swap locks current users out. Recommend: 4.1 → 4.7 → then per-page swaps. (Reorder noted; the per-page tasks are individually shippable once perms are granted everywhere.)

**Honest recommendation:** this is the riskiest, least-essential phase. If the goal is "make the catalog live + a good admin UI," Phase 5 delivers more. Full-split per-page View is worth it only if you genuinely need to delegate/deny individual report-page access. Reconfirm before executing 4.7 (the irreversible-ish data step).
