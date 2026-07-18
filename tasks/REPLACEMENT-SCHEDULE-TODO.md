# Replacement Schedule — Implementation TODO (2026-06-02)

Design: `tasks/REPLACEMENT-SCHEDULE-SCOPE.md` (rev 2). Locked decisions:
± tolerance window · tolerance column-wins-else-config-default · scan-each-filter
qty decrement (multi-session) · reject past-date rows · upload gated by a
permission SUPER_ADMIN grants via Role Privileges · tablet tasks merged into My Tasks.
**Additive only — no change to existing replace/cleaning/PM/filter functionality.**

## Phase 1 — Foundation + web upload
- [x] Prisma: `ReplacementSchedule`, `ReplacementScheduleEntry`, `ReplacementExecution` + `ReplacementEntryStatus` enum (soft AHU refs; FK cascade). Schema valid. **Tables created via direct DDL** (psql) because `prisma db push` is blocked by PRE-EXISTING NotificationType/EventType enum drift from the 2026-05-17 alarm tear-out — unrelated; did NOT touch it. Prisma client generated (required stopping the API to release the query-engine DLL lock on Windows; API restarted + healthy).
- [~] shared: perms `REPLACEMENT_SCHEDULE_VIEW/UPLOAD/EXECUTE` **added + shared rebuilt (tsc clean)**. Still TODO: feature privilege(s) + reauth action(s) + FEATURE_TO_PERMISSION_MAP + seed role grants.
- [x] API module `replacement-schedule/` (template.xlsx, validate dry-run, create, list, due) — registered at `/api/replacement-schedules`. **Verified live**: routes 401 unauth (gated), template returns valid .xlsx (12.5KB, PK zip), list returns empty `data`. (`entries/:id/execute` is Phase 2.)
- [~] config def `replacement-schedule` (tolerance default) — **deferred**: service reads it with a safe default (0) when absent; the def + page is a small follow-up. Tolerance currently column-driven (default 0 when blank).
- [x] web page `routes/filter-management/replacement-schedule.tsx`: Download Template + Upload dialog (dry-run preview + per-row errors + all-or-nothing confirm) + schedule/entry list with status chips. **Verified live** (heading, buttons, empty-state, render). xlsx-only (matches parser + filter bulk-upload).
- [x] sidebar (sidebar.tsx + SIDEBAR_ITEMS + SIDEBAR_PRIVILEGE_MAP) + feature privileges `replacement_schedule.view/upload` + FEATURE_TO_PERMISSION_MAP + main.tsx route guard. **Verified**: sidebar item shows, route guarded, SUPER_ADMIN bypasses backend (rbac.ts) so other roles get access only when granted the privilege. Shared rebuilt.
- [ ] **Follow-ups**: reauth on upload (currently permission-gated + audited only); seed grants for ADMIN; config def/page for tolerance default; CSV support (xlsx-only today); a real-file upload Playwright pass.

## Phase 2 — Tablet tasks + replace-from-task
**Decision (user, 2026-06-02): SEPARATE tile → own page** on the tablet — NOT merged
into My Tasks. Cleaning/filter tasks stay untouched.
- [x] `entries/:id/execute` API: wraps the existing `filterOps.replace` action, increments qtyReplaced, writes ReplacementExecution, marks COMPLETED when qty met. Gated by `REPLACEMENT_SCHEDULE_EXECUTE` perm + **reuses `REPLACE_FILTER` reauth** (replacement stays gated). api tsc clean.
- [x] Tablet **tile** on mobile home (after Replace Filter), badged with due count from `/due`. **Verified live**: tile shows badge "1".
- [x] Tablet dedicated **Replacement Tasks page** (separate from cleaning tasks, per user) listing due entries (AHU + micron/size + qty remaining + due-by). **Verified live**: lists seeded task (AHU-E, micron 0.3 · 610x610x292mm, 2 of 2 left).
- [x] Replace-from-task: tap entry → scoped panel → scan old filter (reuses scan-to-select) → reauth REPLACE_FILTER → `entries/:id/execute` → qty decrement → COMPLETED when met. Wired + tsc-clean (real execution not run in verification — it mutates/creates records + needs reauth). web tsc clean + built.

## Phase 3 — Polish
- [ ] Dashboard "due/overdue replacements" counter.
- [ ] graphile-worker notification job (due/overdue) + MISSED transition.
- [ ] Docs: CLAUDE counts, CHANGELOG, API_REFERENCE.

## Verify each phase
- [ ] prisma validate + migrate; shared build; api tsc; web tsc + build; Playwright UI check; no NEW test failures.
