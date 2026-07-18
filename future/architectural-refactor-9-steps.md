# Architectural Refactor — 9 Steps

**Status:** Steps 1, 2, 4, 6 complete (2026-04-30 → 2026-05-02). Step 5 closed as **no-op** (2026-04-30) — investigation found two checklist systems are different domains, not duplicates; see `tasks/STEP-5-CHECKLIST-INVESTIGATION.md`. Step 3 obsolete (superseded by MT removal). Step 7 deprioritized 2026-05-01 per user. Steps 8 + 9 pending. See task list (#18 - #25), `tasks/RESUME-STATE-2026-04-30-step1-templateKind-done.md`, `tasks/STEP-6-FILTERDETAILS-PLAN.md`, `tasks/RESUME-STATE-2026-05-02-phaseA4.md` for full state.

## Why this exists

After Phase 5 of the windows-friendly-rewrite shipped, the user asked an adversarial-review question: "is this architecture good or bad? what would you change to make it the best?" The honest assessment surfaced 10 candidate refactors (filter_events partitioning was skipped per user's call). The remaining 9 are this plan.

Each step is its own deliverable. The user's standing rules:
- "you can delete all data and create again" — DB resets are OK
- "don't worry about migration" — schema-level rebuilds are OK
- "operational expectation and functionality should remain as expected" — features must keep working
- Q4: don't commit until told (work accumulates uncommitted on `feature/phase5-verification`)

## The 9 steps

| Step | Item | Status | Why this position |
|---|---|---|---|
| 1 | templateKind enum → admin-editable lookup table | ✅ DONE 2026-04-30 | Foundational; every other change touches templates |
| 2 | relationshipType Prisma enum + bidirectional check constraint | ✅ DONE 2026-05-01 | Enum + constraint trigger; commit 51e1110 |
| 3 | AssetInstance.organizationId NOT NULL | ❌ OBSOLETE 2026-04-30 | Superseded by MT removal — column dropped entirely instead of made NOT NULL |
| 4 | applicableTemplates JSONB → join table (allowedBlocks stays JSONB per the conditional case) | ✅ DONE 2026-05-02 | New `FilterProfileApplicableTemplate` join table; AssetTemplate delete guarded with 409 IN_USE; A.3 snapshot reads + freezes the IDs |
| 5 | INVESTIGATE the two checklist systems before deciding (AssetTemplate.checklistSchema vs ChecklistProfile) | ✅ NO-OP 2026-04-30 | Different domains (inspection w/ 3-step e-sig review vs cleaning-cycle gate). Findings: `tasks/STEP-5-CHECKLIST-INVESTIGATION.md` |
| 6 | FilterDetails 1:1 split off AssetInstance | ✅ DONE 2026-05-01 | Frontend untouched (API shape preserved); 11 backend files updated; 65 models now |
| 7 | Multi-version pipeline rollout (per-block versioned profiles) | pending | Feature add on FilterProfile |
| 8 | Decision-tape architecture | pending | Biggest contract change (~2-4 weeks) |
| 9 | Cycle as event fold (event-source CleaningCycle) | pending | Depends on step 8 to be useful |

## Per-step pattern

For each step:
1. Enumerate touchpoints (UI, backend, all user types: SUPER_ADMIN / ADMIN / OPERATOR / VIEWER)
2. Implement
3. Reset DB if schema changed; reseed
4. Test all touchpoints across user types
5. Doc-sync the change immediately (this file's parent rule, `feedback_doc_sync_each_phase` memory)

## Step 1 — DONE

**What:** Replaced the closed `TemplateKind` Prisma enum with a `TemplateKind` lookup table so SUPER_ADMIN can add new kinds (PUMP, VALVE, COMPRESSOR, etc.) without a code migration. The 6 system kinds (BLOCK / AREA / AHU / FILTER / EQUIPMENT / OTHER) are protected — codes immutable, rows non-deletable — so Filter Management / Cleaning Operations / Mobile pages keep routing by code.

**Schema:** `model TemplateKind` (id, code unique, label, description, isSystem, isActive, sortOrder). `AssetTemplate.templateKind` is now String FK to `TemplateKind.code`.

**Backend:** new `apps/api/src/modules/template-kinds/` module with full CRUD under `/api/template-kinds`. Permission gate: `CONFIG_UPDATE` for writes, `ASSET_VIEW` for list. System-protect rules enforced server-side with audit-friendly 409 responses.

**Frontend:** new `/config/template-kinds` page (CRUD UI with lock badge for system rows). Template form dropdown SWR-fetches from `/api/template-kinds?isActive=true`. Templates list shows label looked up from kind code.

**Bug caught during verification:** `template.repository.ts` had `templateKind?` in its type signature but didn't pass it through to Prisma's `data: { ... }`. Every created template was landing with default OTHER. Fixed.

**Counts:** 64→65 models, 37→38 API modules, 26→27 config pages.

## Step 2 — relationshipType enum + bidirectional check (✅ DONE 2026-05-01)

**Status:** closed in commit `51e1110` (`feat: Phase A.2 — relationshipType enum + bidirectional check constraint`). Doc summary + table at lines 3 + 20 already reflect this; section header was simply stale until the 2026-05-02 doc audit caught it.

**What landed:** `AssetRelationship.relationshipType` was a free-form `String VarChar(50)`. Now a Prisma enum (closed set, pulled from `INVERSE_RELATIONSHIP_MAP` in `packages/shared`) + Postgres trigger that enforces the bidirectional pair invariant: every `(source, target, CONTAINS)` row requires its mirror `(target, source, CONTAINED_IN)`. `customLabel` handles the CUSTOM case.

**Original plan retained for context:**

**Plan:**
- Convert to a Prisma enum (closed set: CONTAINS, CONTAINED_IN, CONNECTED_TO, FEEDS, FED_BY, DEPENDS_ON, DEPENDED_ON_BY, BACKS_UP, BACKED_UP_BY, MONITORS, MONITORED_BY, CUSTOM — pulled from `INVERSE_RELATIONSHIP_MAP` in `packages/shared`)
- Add a Postgres CHECK or trigger that enforces: for every `(source, target, CONTAINS)` row there must be a `(target, source, CONTAINED_IN)` row, and vice versa
- `customLabel` field handles the CUSTOM case

**Touchpoints:** schema, packages/shared INVERSE_RELATIONSHIP_MAP (already canonical), all services that write relationships (assets/instance.service, filter-operations, hierarchy), entity-detail Relationships tab in UI, link/attach UI dialogs.

## Step 3 — AssetInstance.organizationId NOT NULL (❌ OBSOLETE 2026-04-30)

**Status:** Superseded by **multi-tenancy removal** (2026-04-30). The `organizationId` column was dropped entirely instead of being made NOT NULL. DigiLog is now single-tenant. See CHANGELOG entry "Multi-Tenancy Removal (2026-04-30)" for the full delta.

## Step 4 — applicableTemplates JSONB → join table (✅ DONE 2026-05-02)

**What landed:** New `FilterProfileApplicableTemplate` model (composite-PK `(profileId, templateId)`, both FKs `onDelete: Cascade`); `FilterProfile.applicableTemplates Json` column dropped. API wire shape preserved (`applicableTemplates: string[]`) via a flatten helper, so frontend untouched. `create()` + `update()` rewrite the join set inside transactions; updates verify incoming template IDs exist before opening the transaction so callers get a clean 400 instead of a Prisma constraint exception.

**A.3 snapshot fix:** `snapshotAndBump()` now reads the live join rows inside the same transaction and freezes them as `string[]` in `FilterProfileVersion.snapshot.applicableTemplates`. Historical replay still works byte-correct (verified end-to-end: v1 snapshot has both templates after PUT removed one).

**AssetTemplate delete guard:** Before `softDelete()`, the template service counts join rows for the templateId. If any FilterProfile still binds it, throws `ConflictError` (`409 IN_USE`) listing the binding profiles by name. The cascade FK on the join table is the safety net for hard deletes (super-admin / backup-restore paths) — this guard is the user-facing path. Matches the existing FilterProfile-delete guard pattern.

**Skipped for `allowedBlocks`:** Stays JSONB. Only used when `blockRestriction = SPECIFIC_BLOCKS` — conditional fields don't justify a join table.

**Touchpoints touched:** schema, `filter-profile.service.ts` (create/update/list/getById/snapshotAndBump), `assets/services/template.service.ts` (delete guard). Frontend untouched (no `applicableTemplates` references in `apps/web/src`).

**Counts:** 68 → **69** models. Enums + modules unchanged.

## Step 5 — Investigate two checklist systems (✅ NO-OP 2026-04-30)

**Investigation outcome:** They are different domains, not duplicates. **Closed without schema work.** Full findings: `tasks/STEP-5-CHECKLIST-INVESTIGATION.md`.

- **System A (`AssetTemplate.checklistSchema`)** — generic per-entity inspection. Submitted via `POST /api/data/checklist`, persisted to `ts_checklist_responses` (TSDB hypertable, hash-bound) and opens a 3-step `ChecklistReview` (Performed → Checked → Verified) e-sig workflow for 21 CFR Part 11 attestation. *(Note added later: System A was entirely removed after this 2026-04-30 investigation — `/api/data/checklist` + `ts_checklist_responses` went 2026-06-17 with the data-ingestion/TimescaleDB tear-out, and the `ChecklistReview` table was dropped 2026-07-04. Only System B below survives.)*
- **System B (`ChecklistProfile`+`ChecklistQuestion`)** — synchronous gate inside a cleaning cycle. Referenced by `FilterPipelineStage.configuration.checklistProfileId` for CHECKLIST nodes. Submitted via `POST /api/filters/:id/submit-checklist`, embedded in `FilterEvent` log, must be answered to unblock `advance()`.

You cannot consolidate them without either forcing every cleaning checklist through a 3-step e-sig review (operationally a nightmare) or stripping the review workflow off System A (regulatorily damaging). Optional cosmetic cleanups documented in the findings doc; none are required.

**No schema change. No code change. Investigation closed.**

## Step 6 — FilterDetails 1:1 split off AssetInstance (✅ DONE 2026-05-01)

**What landed:** Filter-specific cycle state (`filterProfileId`, `currentLifecycleState`, `currentCycleId`, `filterSet`) split off `AssetInstance` into a 1:1 `FilterDetails` sidecar. AssetInstance is now generic again — non-filter rows (BLOCK / AHU / AREA / EQUIPMENT / OTHER) no longer carry meaningless nullable cycle columns.

**Strategy:** API response shape preserved via repository flatten. Frontend code untouched (saved 99 frontend touchpoints out of the 223-site total inventory). Eager FilterDetails creation when `templateKind === 'FILTER'`; no rows for other kinds.

**Files changed (backend, 11):** schema.prisma, instance.repository.ts, instance.service.ts, filter-operations.service.ts, pm-schedule.service.ts, cleaning-profile.service.ts, filter-profile.service.ts, bulk-upload-filter.service.ts, super-admin/routes.ts, plus the new helper `apps/api/src/lib/filter-details.ts`. Plan + verification doc: `tasks/STEP-6-FILTERDETAILS-PLAN.md`.

**Counts:** 64 → **65** models. Enums unchanged at 22. Modules unchanged at 36.

## Step 7 — Multi-version pipeline rollout (deprioritized 2026-05-01)

**Original idea:** Add per-block target version on FilterProfile so a new cleaning recipe could be rolled out to one block first, evaluated, then propagated.

**Status (2026-05-01):** Per-block override is **explicitly out of scope** — user confirmed FilterProfile is uniform across all blocks (regulatory caveat below was the operative one). The "FilterProfile is the per-block mapping" framing was wrong; FilterProfile policies bind a cleaning profile to filter templates with optional `blockRestriction`, but mapping itself is global. **Phase A.3 (2026-05-01)** added per-FilterProfile version history (snapshot-then-bump sidecar) which delivers the audit-replay half of this step. The "rollout one block at a time" piece is deferred indefinitely and should not be revived without a fresh customer ask.

**Original touchpoints (preserved for context only):** schema (FilterProfile.targetCleaningProfileVersion + per-block override table), startCycle service to read the right version per block, FilterProfile UI rollout panel, audit table for version-rollout history.

**Regulatory caveat (the deciding factor):** Pharma SOPs require uniform recipe across all blocks. Confirmed with user.

## Step 8 — Decision-tape architecture (pending; biggest)

**What:** Server emits ordered action tape per filter: `GET /api/filters/:id/current-state` returns `{ state, actions: [{type, params, validations}] }`. Tablet renders buttons/dialogs from `actions`; client has zero pipeline logic. Eliminates the entire client/server pipeline-drift bug class that haunted Phase 3 + Phase 5.

**Touchpoints:** server tape generator (new), frontend renderer (rewrite), offline replay (validate against cached tape), APK rebuild + versioned tape contract.

**Effort:** 2-4 weeks.

## Step 9 — Cycle as event fold (pending; depends on #8)

**What:** Make `CleaningCycle.status` derived from `FilterEvent` log via materialized projection. The hash-chained event log already IS the source of truth for inspection; cycle row becomes a triggered/computed projection.

**Touchpoints:** schema, every status-mutation site in filter-operations.service, all reads that compute cycle status, audit/reporting projections.

**Why after #8:** Decision-tape moves business logic to the server; #9 then makes cycle state purely derivable.

## Out-of-band tracks

These are NOT part of the 9 steps but were discussed during the same conversations:

- **Multi-tenancy removal** — ✅ DONE 2026-04-30. Single-tenant deployment. Step 3 retired. See CHANGELOG.
- ~~**AWS SNS spawn-aws-CLI**~~ — ✅ **DONE 2026-05-02 (P3).** Per user direction the AWS SNS path was dropped entirely (no `@aws-sdk/client-sns` swap). MSG91 / Twilio / Plivo / AfricasTalking / Kaleyra all run through the existing generic `http-gateway` provider — configurable URL + headers map + body template with `{phone}` / `{message}` placeholders. AWS-related fields removed from `SmsConfig` interface, route enum, sensitive-key masks, and FE config page. Compiled dist contains zero AWS references. Rule-chain `aws-sns` / `aws-sqs` / `aws-lambda` nodes (stub no-ops, no real AWS deps) left in place — out of scope.
- ~~**Phase 5+ proper Windows-service launcher**~~ — ✅ **DONE 2026-05-02** in Batch 6 commit `d31ed37`. The partial NSSM scripts in `d1ce9f5` (`scripts/install-services-phase5.ps1` + `scripts/uninstall-services-phase5.ps1`) were tied together by `scripts/install-windows.ps1` (top-level orchestration: tooling sanity → build shared / api / web → Mosquitto setup → NSSM-managed DigiLog API + Web services → start → /health probe) and `scripts/uninstall-windows.ps1` (stop + remove DigiLog services; Mosquitto + logs are opt-in via flags). Idempotent. Both AST-parse-validated.

## Memory entries that informed this plan

- `feedback_doc_sync_each_phase` — per-step doc-sync rule
- `feedback_filter_data_mgmt_mirrors_pages` — preserve operational expectation
- `feedback_dynamic_template_fields` — template-driven UI
- `feedback_remarks_mandatory` — audit-friendly defaults
- `feedback_no_auto_sync_config` — config tabs are independent
