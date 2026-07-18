# Linkage Review Audit — 2026-05-04

Six parallel READ-ONLY review agents (RV1–RV6) audited the codebase for unconnected endpoints, unlinked UI, and end-to-end UI↔backend integration across user management, filter/AHU, checklist, and FilterProfile/EquipmentGroup linkage.

**Coverage:** ~280 backend endpoints, 72 FE routes, 26 sidebar items, 4 subsystems (users / filter+AHU / checklist / profile+equipment). 6 audit reports consolidated below.

**Bottom line:**
- **2 CRITICAL** items requiring code fixes (21 CFR Part 11 risk)
- **5 HIGH-severity** items
- **8 MEDIUM-severity** items
- **6 LOW / informational** items
- Most of the codebase is well-integrated. The flagged items cluster around (a) reauth gates on retire/replace/bulk-upload, (b) offline checklist questions cache, and (c) FE-side dialog completeness.

---

## CRITICAL — must fix before production rollout

### C1. Offline checklist sync omits `?expand=questions`
**File:** `apps/web/src/lib/offline-sync-service.ts:141`
**Source:** RV5
**Symptom:** `GET /api/checklist-profiles?limit=100&isActive=true` is fetched WITHOUT `?expand=questions`. Cached profiles have empty `questions[]` arrays. Mobile page (`mobile-operations.tsx:281`) correctly uses `?expand=questions` but the sync service that hydrates the offline cache does not.
**21 CFR Part 11 risk:** Operator submits a checklist offline; the dialog renders zero questions; the audit trail records an empty submission with no answers visible. This is a regulatory compliance failure.
**Fix:** Add `?expand=questions` to the URL on line 141. ~5 min change. Mirrors the existing pattern.

### C2. Retire / Replace / Bulk-Upload missing reauth gates
**Files:**
- `apps/api/src/modules/filter-operations/routes.ts:364-388` (`POST /api/filters/:id/retire`)
- `apps/api/src/modules/filter-operations/routes.ts:391-420` (`POST /api/filters/:id/replace`)
- `apps/api/src/modules/assets/routes/instance.routes.ts:258-327` (`POST /api/assets/instances/bulk-upload-filters`)
- `apps/web/src/routes/filter-management/filter-list.tsx:450-453, 560` (FE retire/replace handlers — `api.post` directly, no `reauth.execute()` wrapping)
- `apps/web/src/routes/filter-management/filter-list.tsx:863-894` (FE bulk-upload — raw `fetch()` without reauth)

**Source:** RV4
**Symptom:** Three mutating operations bypass the reauth gate. The retire and replace routes have no `enforceReauth(...)` server-side; the FE doesn't wrap them in `reauth.execute(...)` either. Bulk upload (which can create 100+ filters) has the same pattern. Operators can perform these with the JWT alone — no per-action password challenge.
**Additional gap:** The reauth action `REPLACE_FILTER` is NOT defined in `packages/shared/src/types/reauth-actions.ts` (81 actions, but no `REPLACE_FILTER`). So even if the FE wanted to call `reauth.execute('REPLACE_FILTER', ...)`, the action doesn't exist.
**21 CFR Part 11 risk:** Same as C1 — every mutating operation should require electronic-signature re-verification.
**Fix scope:** ~3 files, ~4-6 endpoints, plus 1 new shared reauth action constant. Estimate 1 sequential agent, ~30 min.

---

## HIGH — fix soon

### H1. PUT /api/auth/profile lacks reauth gate
**File:** `apps/api/src/modules/auth/auth.routes.ts:205-240`
**Source:** RV3
**Symptom:** Self-profile update (name/email/department/photoUrl) requires no password re-verification. `POST /api/auth/change-password` correctly gates with current-password verification; profile update does not. An attacker with a stolen JWT could change the user's email to one they control.
**Fix:** Wrap the route in `enforceReauth(...)` with a new or existing reauth action (`UPDATE_PROFILE`).

### H2. /checklist/:entityId standalone page has no offline schema pinning — RECLASSIFIED 2026-05-04 by FX8 investigation
**File:** `apps/web/src/routes/checklist-form/index.tsx:167` area
**Source:** RV5
**Original symptom:** Standalone mobile-optimized checklist page fetches the entity once, reads `entity.template.checklistSchema`, and uses that for validation. If an admin edits the template AFTER the operator went offline, the operator's submission validates against schema A but the server expects schema B.
**FX8 finding (READ-ONLY): MISCLASSIFIED.** The page is purely ONLINE — no `useOffline`, no `executeOrQueue`, no offline-cache import; `apiClient.post` has no offline auto-queue; the `useOffline.executeOrQueue` switch (use-offline.ts:93) doesn't include `/api/data/checklist`; `vite.config.ts:42-43` sets `runtimeCaching:[]` + `navigateFallbackDenylist:[/^\/api\//]` (no SW background-sync queue). Server endpoint `apps/api/src/modules/data-ingestion/routes.ts:237-321` has `responses: {type:'object', additionalProperties:true}` (anything passes); `ingestion.service.ts:543` skips validation for `POST_CHECKLIST`; `ingestion.repository.ts:161-197` (saveChecklist) stores the answers blob verbatim with the question IDs the operator saw + SHA-256 hash. The audit's failure mode is **not reachable** under current code.
**Decision:** No fix. Risk does not exist today.
**Forward-looking note:** If offline support is ever added to this page, `ts_checklist_responses` (init-tsdb.sql:52-62) needs a `template_version` column at the same time. Tracked here as a guardrail for future feature work, NOT an active 21 CFR risk.

### H3. PUT /api/pm-executions/:id has no FE caller (orphan endpoint)
**File:** `apps/api/src/modules/pm-schedules/execution-routes.ts:34`
**Source:** RV1
**Symptom:** Backend has POST (create execution) and PUT (update status — `COMPLETED` / `OVERDUE` / `MISSED`). The PUT has zero FE callers. Operators cannot mark a PM execution as completed via the UI. Either the FE was supposed to wire this up and didn't, or the PUT is dead code.
**Fix:** Either (a) add the FE handler in the PM-execution detail flow + un-skip whatever test was for it, or (b) delete the PUT endpoint if the lifecycle is intentionally read-only. Decide by checking with PM-schedules product owner.

### H4. PM Schedule "Create Schedule" button permanently disabled
**File:** `apps/web/src/routes/pm-schedules/detail.tsx:49`
**Source:** RV2
**Symptom:** `<button disabled title="Coming soon">Create Schedule</button>`. Shown exactly when the user has no schedule (so they want to create one). Either implement the create flow or remove the button (and route operators elsewhere).
**Fix:** Product decision — same scope as H3, may be a paired item.

### H5. CreateHierarchyDialog only validates `name.trim()`, not template attributeSchema required fields
**File:** `apps/web/src/routes/filter-management/filter-list/dialogs/CreateHierarchyDialog.tsx:95`
**Source:** RV4
**Symptom:** Block/Area/AHU templates can declare required `attributeSchema` fields (location, capacity, etc.). The create dialog only validates `name`. Backend `createAssetInstanceSchema` may or may not validate (RV4 didn't fully verify). If neither validates, a Block can be created with 5 required attributes left blank.
**Fix:** Mirror the validation already present in `CreateFilterDialog.tsx` (which DOES handle dynamic schema). One ~30 min fix.

---

## MEDIUM

### M1. Admin-request approval reuses CREATE_USER reauth action
**File:** `apps/api/src/modules/admin-requests/routes.ts:216`, FE caller `apps/web/src/routes/admin-requests/index.tsx:52-53`
**Source:** RV3
**Symptom:** Approve/reject of an admin-request fires `enforceReauth('CREATE_USER', ...)`. Conflates "create a user" with "approve a pending creation". Audit trail says CREATE_USER instead of APPROVE_ADMIN_REQUEST.
**Fix:** Add `APPROVE_ADMIN_REQUEST` reauth action; thread through both ends. Cosmetic-only; not a security gap.

### M2. Filter status PATCH reuses generic UPDATE_ASSET reauth action
**File:** `apps/api/src/modules/assets/routes/instance.routes.ts:455` area
**Source:** RV4
**Symptom:** Lifecycle-state changes (Active → Quarantine → Retired) use generic UPDATE_ASSET. A dedicated UPDATE_FILTER_LIFECYCLE would clarify audit trails for inspectors.

### M3. Phase 8.7 dual cache (legacy + tape) intentionally retained, no removal date
**File:** `apps/web/src/lib/offline-cache.ts:26-43`
**Source:** RV5
**Symptom:** Comment says "until 8.7 retires the legacy ones" but 8.7 is now closed and the legacy fields are still written to the cache row. Maintenance burden. **Counter-argument:** the comment in the code says the cache row preserves them deliberately because `local-context.ts:466` reads `pendingChecklist` to synthesize CHECKLIST_COMPLETED — they're load-bearing for the FE-side gate-clear footprint. So this is a misread by RV5; verifying with the commit messages, the cache write side is intentionally preserved.
**Action:** No fix needed; document inline that the dual-write is permanent (the legacy field is now the gate-clear footprint, not a deprecation artifact).

### M4. Missing version-history UI on checklist profile detail page
**File:** `apps/web/src/routes/checklist-admin/detail.tsx`
**Source:** RV5
**Symptom:** Backend supports `GET /api/checklist-profiles/:id/versions` (Phase A.1) but the profile detail page has no UI to view/compare versions. Admins must navigate to the generic `/version-history?entity=checklist-profile&id=X` route.
**Fix:** Add a "Version History" tab or button on the detail page. ~30 min.

### M5. Cleaning-profile version chips missing in cycle timeline
**File:** `apps/web/src/routes/cleaning-cycles/timeline.tsx:255-261` area
**Source:** RV6
**Symptom:** Timeline renders an EquipmentGroup version-chip with deep-link to /version-history but doesn't render the analogous chip for FilterCleaningProfile. Asymmetric UX.
**Fix:** Mirror the equipment-group chip pattern for the cleaning-profile.

### M6. filter-profile-list.tsx is read-only — no FE create/edit dialog for FilterProfile
**File:** `apps/web/src/routes/filter-management/filter-profile-list.tsx`
**Source:** RV6
**Symptom:** End users cannot create or edit FilterProfile via UI. This may be intentional (admin-only ops via direct DB or a tool that doesn't exist yet), but it surfaces as a gap.
**Fix:** Product decision — verify whether FilterProfile CRUD belongs in the operator UI or stays admin-only. If it belongs, add the dialogs.

### M7. Sync endpoint does NOT expose FilterProfileVersion or EquipmentGroupVersion sidecar tables
**File:** `apps/api/src/modules/sync/sync.service.ts:88-163`
**Source:** RV6
**Symptom:** Offline mobile/tablet cannot replay version history without follow-up API calls. Documented limitation per `future/offline-version-sync-contract.md`. Acceptable for current Phase 5 scope.

### M8. Equipment group can be edited while in-use by an active cycle (no soft-lock UI)
**File:** Backend allows it (snapshot-then-bump protects validation); FE lacks warning UI.
**Source:** RV6
**Symptom:** Admin edits an equipment group → cycle's pinned snapshot is preserved (validation safe) but UI shows live row with `equipmentGroupSyncWarning` to operators. Could surface a soft-lock dialog when admin attempts the edit while there are active cycles pinned to it.

---

## LOW / informational

- **L1.** RV5's claim that the desktop batch dialog "needs verification that d660daf applied" is incorrect — commit `d660daf` explicitly fixed both desktop and mobile (verified in commit message + diff stats). False positive.
- **L2.** RV3's claim that `auth.test.ts forgot-password` PASSES contradicts our prior assumption that it's a known pre-existing failure. **Action:** re-verify by running the test in isolation. If it passes, our commit messages have been quoting bad info; CHANGELOG entries since Phase 8.7 should be updated.
- **L3.** equipmentGroupVersionPin lazy first-version warning is logged but not thrown — acceptable per design.
- **L4.** SUPER_ADMIN bypass pattern consistent across the 14 user-management flows. ✅
- **L5.** Single-tab enforcement (BroadcastChannel via localStorage heartbeat) implemented. ✅
- **L6.** Tablet/offline NOT updated for equipmentGroupVersionPin per `future/offline-version-sync-contract.md` (Slice B follow-up bundled with next APK build).

---

## Recommended fix order

1. **C1 (offline expand=questions)** — 5 min, single-line fix, immediate 21 CFR risk
2. **C2 (retire/replace/bulk-upload reauth)** — 1 sequential agent, ~30 min, immediate 21 CFR risk
3. **H1 (profile self-edit reauth)** — small agent, ~15 min
4. **H2 (offline schema pinning for /checklist/:entityId)** — single agent, ~30 min
5. **L2 cross-check** (auth.test forgot-password real status) — ~10 min
6. **H3+H4 paired** (PM execution PUT + Create Schedule button) — needs product decision; can dispatch one agent to investigate + propose
7. **H5 (CreateHierarchyDialog dynamic schema validation)** — single agent, ~30 min
8. **M1+M2** (dedicated reauth actions) — bundled, single agent
9. **M3 (offline-cache comment update)** — 5 min
10. **M4+M5+M6** (FE feature gaps — version-history UI on detail page, cleaning-profile chips, FilterProfile CRUD decision) — product-driven; defer

---

## How this audit was produced

Six parallel agents dispatched 2026-05-04 with READ-ONLY constraint:

- **RV1** — orphan API endpoints
- **RV2** — orphan UI / dead routes / dead actions
- **RV3** — user management end-to-end (14 flows)
- **RV4** — filter+AHU+hierarchy linkage (16 flows)
- **RV5** — checklist subsystem (12 flows)
- **RV6** — FilterProfile + EquipmentGroup + versioning (15 flows)

Each agent enumerated its scope, traced FE↔API↔RBAC↔reauth↔audit for each flow, and reported gaps with file:line + severity classification. Lead consolidated, cross-checked against recent commit history (some agent claims contradicted by recent commits — flagged as L1, L2 above).

No code changes were made during this audit. Fix dispatch is a separate decision.
