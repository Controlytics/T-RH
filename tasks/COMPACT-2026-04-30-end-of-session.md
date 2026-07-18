# Session Compaction — 2026-04-30

Session is being compacted. This is the minimum next-session needs to continue.

## State at compact

**Branch:** `feature/phase5-verification` (worktree at `.worktrees/phase5-verification`).
**Uncommitted:** 98 files. Q4 standing rule — do NOT commit until told.
**Build state:** prisma valid ✅, api `tsc --noEmit` exit 0 ✅, web `vite build` exit 0 ✅.
**Verified live:** 23-page Playwright e2e walk completed; 3 bugs found and fixed in same session.

## What's done (do not redo)

1. **Step 1 of 9-step refactor** — admin-editable `TemplateKind` lookup table replaces closed Prisma enum. 6 system kinds (BLOCK/AREA/AHU/FILTER/EQUIPMENT/OTHER) protected, code immutable, in-use rows non-deletable. Inline-edit UX in /config/template-kinds. Create/Edit/Delete on /assets/templates gated on `ASSET_TEMPLATE_*` perms.
2. **Multi-tenancy removal** — single-tenant single-site single-company. Dropped `Organization` model, 11 `organizationId` cols, 2 `orgId` cols, `org-admin`/`tenant-admin` modules, `lib/org-scope.ts`, `routes/tenant/` folder. JWT `scope` always stamps `GLOBAL`. Step 3 of the 9-step plan is OBSOLETE.
3. **3 post-MT-removal bug fixes:** /pm-schedules React-error-#300 hook-order crash, /my-tasks misleading red error toast, blank-page on unknown URLs (added catch-all `<Route path="*">`).
4. **Doc sync (twice):** 14 docs updated. Counts current: 64 models, 22 enums, 105 perms, 89 priv, 81 reauth, 25 sidebar, 36 api modules, 30 config defs, 27 config pages, 81 routes.

## Authoritative restart docs (read these first)

1. `tasks/RESUME-STATE-2026-04-30-mt-removal-done.md` — full file-level diff inventory, verification commands, and known follow-ups.
2. `tasks/MT-REMOVAL-TOUCHPOINTS.md` — the pre-flight inventory used for MT removal.
3. `tasks/RESUME-STATE-2026-04-30-step1-templateKind-done.md` — earlier resume doc for Step 1.
4. `future/architectural-refactor-9-steps.md` — Steps 2/4-9 still pending (3 obsolete).
5. `tasks/todo.md` — audit log entries for everything done 2026-04-30.

## Next sessions's first 30 seconds

```bash
cd /c/Users/hello/21cfrlogbook-DigitalFMS/.worktrees/phase5-verification
cat tasks/RESUME-STATE-2026-04-30-mt-removal-done.md | head -100
# Then run the verification commands in section "How to verify the current state"
```

## Default next-session action if user says "continue"

Step 2 of the 9-step refactor: tighten `AssetRelationship.relationshipType` from free-form `String` to a Prisma enum, add a Postgres CHECK to enforce the bidirectional pair invariant. Small, independent, ~1-2 hours. Same plan template as Step 1: touchpoint inventory → implementation → e2e test pass → doc sync.

## Live credentials (if DB still seeded)

- `superadmin` / `Admin@123`
- `RB0001` / `Test@1234` (test OPERATOR; gone if DB was reset)

## Services

NSSM-managed Windows services (running unless user stopped them):
- `DigiLogAPI-Phase5` — https://localhost:3000
- `DigiLogWeb-Phase5` — https://localhost:5175 (vite **preview** mode, not dev — source edits need `vite build` + SW unregister)

## Pending tasks

- #18 Step 2: relationshipType enum + bidirectional check
- #20 Step 4: applicableTemplates → join table
- #21 Step 5: Investigate two checklist systems
- #22 Step 6: FilterDetails 1:1 split off AssetInstance
- #23 Step 7: Multi-version pipeline rollout
- #24 Step 8: Decision-tape architecture
- #25 Step 9: Cycle as event fold

(#19 Step 3 is OBSOLETE — superseded by MT removal.)

## Known follow-ups (non-blocking)

1. PM module disabled by default (intentional opt-in feature flag) — toggle ON in Configuration → PM Schedule Settings to test full PM/My Tasks flow.
2. Reports `orgName` template variable still populated as empty string — trim once confirmed not used in any report template.
3. DashboardScope enum still has `TENANT | ORGANIZATION | USER` — collapse for hygiene.
4. Single-tab guard interaction with `force: true` curl logins is awkward but pre-existing — not regression.
