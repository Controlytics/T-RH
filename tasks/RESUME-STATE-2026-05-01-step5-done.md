# Resume State — 2026-05-01 (after Step 5 close-out + checklist pitfall analysis)

**Branch:** `feature/phase5-verification` (worktree at `.worktrees/phase5-verification`)
**Last commit:** `d1ce9f5` (NSSM launcher) — everything since is uncommitted per Q4 rule
**Git state:** ~99 files dirty including the new Step 5 docs. **Do NOT commit until told.**

## First thing to ask tomorrow

> "Read `tasks/RESUME-STATE-2026-05-01-step5-done.md`. Step 5 closed as no-op, Codex review + fixes done. Do I want Step 5b (checklist hardening), or skip to Step 2 (relationshipType enum)?"

## Codex adversarial review + fixes (2026-05-01)

Codex flagged 3 issues against uncommitted diff; audit found 3 more related bugs; all 6 fixed and verified end-to-end.

**Fixed:**
- `instance.routes.ts` — non-admin users with no assignments now default-deny (was: full visibility fallthrough — security regression). Both list + tree endpoints.
- `filter-operations.service.ts:112, 243, 1246` — `getFilterHomeBlock`, `getBatchStates`, `getDashboardStats` now query by `template.templateKind` instead of `template.name`.
- `pm-schedule.service.ts:459, 620, 638` — bulk PM AHU lookup, `listAhuFilterSetConfigs` AHU lookup, and child-filter count all by `templateKind`.

**Verified:**
- Created a Block→AHU→Filter chain with **non-canonically-named** templates ("Renamed Block Tpl", "Renamed AHU Tpl", "Renamed Filter Tpl 5b"). All 4 templateKind lookups work — `dashboard-stats.totalFilters=1`, `batch-states` returns the filter, `current-state.homeBlock` resolves, `pm-schedules/ahu-configs.totalFilters=1`.
- Default-deny on operator `RB0001` (no assignments): list = `{"data":[],"total":0}`, tree = `[]`.

**Side effects this session:**
- OPERATOR `RB0001` password rotated `Test@1234` → `Test@12345`. Cannot revert (policy blocks reuse of last 12). **Use the new password.**
- PM module is now toggled ON in config. Left enabled.

Audit-log entry: `tasks/todo.md` § "2026-05-01 — Codex adversarial review + fixes". CHANGELOG entry: above the MT-removal block.

## What's done since the prior resume doc

1. **Step 5 — Investigation complete, closed as NO-OP.**
   - Two checklist systems are different domains, not duplicates.
   - Findings doc: `tasks/STEP-5-CHECKLIST-INVESTIGATION.md` (full per-system touchpoint inventory)
   - Updated `future/architectural-refactor-9-steps.md` — Step 5 row marked `✅ NO-OP 2026-04-30`
   - Audit-log entry appended to `tasks/todo.md`
   - Task #21 marked completed.

2. **Pitfall analysis surfaced (in conversation, not yet captured in repo).** The user asked for online + offline pitfalls in cleaning-cycle checklist execution. Below is the bundle for tomorrow's decision.

## The Step 5b decision pending

User asked: "what can be improved … both online and offline." Analysis returned 13 online + 8 offline pitfalls. The proposed minimal bundle ("Step 5b") is **5 changes, all in `submitChecklist` + `FilterEvent.attributes`, no schema migration:**

1. **Snapshot resolved question set onto `FilterEvent.attributes.questionsSnapshot`** at submit time (id, text, type, required, options). Audit reproducibility becomes deterministic. Closes profile-drift gap.
2. **Honor `offlinePerformedAt` from client payload, persist as regulatory timestamp** (keep server-receive time separate). Closes 21 CFR Part 11 timestamp gap for offline ops. Aligns with `project_offline_sync_v2` pattern.
3. **Reject extra answer keys on submit** (or accept-with-flag), instead of `console.warn` then silent persist. Stops audit-garbage path.
4. **Tighten `clientOpId` dedup key to `(filterId, clientOpId, stage)`.** Defends against buggy replay reusing opId across stages.
5. **Pretty-print stage names in `CHECKLIST_PENDING` error message.** `WASH_IN` → `Wash In` instead of `WASH IN`.

User has NOT yet decided between:
- **(a) Step 5b correction bundle** — those 5 fixes as a follow-up PR before moving on.
- **(b) Skip Step 5b, go to Step 2** — relationshipType enum + bidirectional check (the originally-recommended next step).

The full pitfall inventory (13 online, 8 offline) is in the conversation transcript at `C:\Users\hello\.claude\projects\C--Users-hello-21cfrlogbook-DigitalFMS\` — the most recent jsonl. **If picking option (a) tomorrow, re-derive the inventory by reading that transcript or by re-asking; the conversation summary may be lossy.**

Tier 2 / 3 items deferred regardless of which path is picked:
- Cycle-start gate freeze vs `CHECKLIST_GATE_LIFTED` audit event for soft-delete escape hatch
- Row-level lock on `currentLifecycleState` during `advance()` to close concurrent-advance race
- `CHECKLIST_AMENDED` event type with prev-hash pointer for correction path
- Profile version/ETag on cache + drift detection on submit
- 1-step e-sig parity for cleaning checklists vs inspection's 3-step
- Convert `FilterPipelineStage.configuration.checklistProfileId` JSONB → real FK column (do alongside Step 4 if both touched)
- Memoize `getCurrentState` per (filterId, lifecycleState)

## Context that survives a compact

- **Default execution order (advisor's call from yesterday):** 5 → 2 → 4, then defer 6/7/8/9. Step 5 done; next is 2 unless user picks 5b.
- **Build state at session end:** unchanged from yesterday's resume — prisma valid, api `tsc --noEmit` clean, web `vite build` clean. No new code touched today, only docs.
- **Services:** `DigiLogAPI-Phase5` and `DigiLogWeb-Phase5` likely still running unless user stopped them. Vite is in **preview** mode, not dev — source edits need rebuild + SW unregister.
- **Live counts unchanged:** 64 models, 22 enums, 105 perms, 89 priv, 81 reauth, 25 sidebar, 36 modules, 30 config defs, 27 config pages, 81 routes.
- **JWT scope = GLOBAL.** `/api/organizations` 404. MT removal still verified clean.

## Files written today (uncommitted)

1. `tasks/STEP-5-CHECKLIST-INVESTIGATION.md` — full Step 5 findings doc with per-system touchpoint inventory
2. `future/architectural-refactor-9-steps.md` — Step 5 row + section updated to NO-OP
3. `tasks/todo.md` — appended Step 5 audit-log entry
4. `tasks/RESUME-STATE-2026-05-01-step5-done.md` — this file

## Files NOT written but worth knowing

- No new memory entries written (the findings doc is the canonical record)
- No CLAUDE.md / API_REFERENCE.md / BACKEND_GUIDE.md / etc. touched — both checklist systems were already documented; nothing new to surface
- Pitfall analysis has not been written to repo. If tomorrow's choice is Step 5b, re-derive from transcript or re-ask.

## Pending tasks (unchanged)

- #18 Step 2: relationshipType enum + bidirectional check
- #20 Step 4: applicableTemplates → join table
- #22 Step 6: FilterDetails 1:1 split off AssetInstance
- #23 Step 7: Multi-version pipeline rollout
- #24 Step 8: Decision-tape architecture
- #25 Step 9: Cycle as event fold

(#19 Step 3 obsolete; #21 Step 5 ✅ NO-OP.)

## Default if user says "continue"

Start **Step 2** — relationshipType enum + bidirectional check. Same plan template as Step 1: touchpoint inventory → implementation → e2e test pass → doc sync. ~1-2 hours of work.

If user says "do 5b" or "fix the checklist gaps you found" → re-derive the 5-change bundle (or 13/8 full inventory) from the conversation transcript, then implement against `apps/api/src/modules/filter-operations/filter-operations.service.ts:530` (`submitChecklist`) and `apps/api/src/modules/filter-operations/routes.ts:201` schema.
