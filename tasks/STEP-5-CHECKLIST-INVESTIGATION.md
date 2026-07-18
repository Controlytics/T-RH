# Step 5 — Investigation: Two Checklist Systems

**Date:** 2026-04-30
**Branch:** `feature/phase5-verification`
**Conclusion:** **Leave both as-is. They are different domains, not duplicates. No schema work needed.** Document the distinction and stop here.

---

## TL;DR

DigiLog has two checklist storage paths because it has two different checklist *use cases*. They look superficially similar but are functionally disjoint:

| | **System A — Inspection** | **System B — Cleaning Pipeline Gate** |
|---|---|---|
| **Definition lives on** | `AssetTemplate.checklistSchema` (JSONB array) | `ChecklistProfile` + `ChecklistQuestion` (relational) |
| **Where it's authored** | Template builder (`/assets/templates`) | Checklist admin (`/checklist-admin/list` + `/detail`) and `/checklists/list` |
| **Where it's answered** | Mobile-style standalone page `/checklist/:entityId` | Auto-popup dialog **inside a cleaning cycle** (`filter-management/components/checklist-dialog.tsx`) |
| **Submit endpoint** | `POST /api/data/checklist` (data-ingestion) | `POST /api/filters/:id/submit-checklist` (filter-operations) |
| **Submit perm** | `CHECKLIST_SUBMIT` | `FILTER_OPERATE` |
| **Storage on submit** | Hot path: `ts_checklist_responses` (TSDB hypertable, immediate write, SHA-256 hash-bound) + `ChecklistReview` (PG, 3-step review workflow: Performed → Checked → Verified with digital signatures per step) | Embedded in `FilterEvent` log of the active cleaning cycle |
| **Lifecycle** | Submit → review workflow (3 e-sig steps for 21 CFR Part 11 attestation) | Submit → unblocks `advance()` for the next stage |
| **Question types** | 14 types: `PASS_FAIL, YES_NO, YES_NO_NA, MCQ, MULTI_SELECT, TEXT, NUMERIC, DROPDOWN, PHOTO, DATE_TIME, SIGNATURE, YES_NO_COMMENT, CALCULATED, CONDITIONAL` (free strings on JSONB) | Same 14-name set, but enforced as a **Prisma enum** `ChecklistQuestionType` so DB-level validation is tighter |
| **Per-instance semantics** | One per *entity instance per submission*, immutable, hash-chained | Many per *cleaning cycle*, one for each CHECKLIST node between two STAGE nodes |
| **References** | None — pure attestation log | Referenced by `FilterPipelineStage.configuration.checklistProfileId` for CHECKLIST nodes in `FilterCleaningProfile` pipelines |
| **Domain meaning** | "Inspect this asset and attest the answers." | "This pipeline says you must answer Q1–Qn before you can move from STAGE A to STAGE B." |

---

## Why this isn't duplication

Three orthogonal facts, any one of which kills the consolidation idea:

1. **Different write contracts.** System A writes to a TimescaleDB hypertable with a SHA-256 of the answers as a regulatory binding, then opens a 3-step ChecklistReview workflow with digital signatures. System B writes to the FilterEvent log embedded in the active cleaning cycle and unblocks the `advance()` gate. There is no single write path that satisfies both.

2. **Different ownership.** System A is owned by an `AssetTemplate` — every entity created from that template inherits the schema. System B is owned by a `FilterCleaningProfile` pipeline — every cycle started against that pipeline inherits the gate.

3. **Different lifecycle.** System A starts a long-running review workflow (3 e-signature steps over hours/days). System B is a synchronous gate inside a cleaning cycle (must be answered now to advance).

You can't consolidate these without either:
- Forcing every cleaning checklist to enter a 3-step review workflow (regulatorily fine, operationally a nightmare), OR
- Stripping the review workflow off System A and downgrading inspection attestation to "answered, done."

Either path damages the operational expectation rule from CLAUDE.md.

---

## Code touchpoints (so the next person doesn't redo this investigation)

### System A — Inspection (template-driven)
- **Schema:** `apps/api/prisma/schema.prisma`
  - `AssetTemplate.checklistSchema` (JSONB) — line ~434
  - `ChecklistReview` (PG) — line ~709 (3-step e-sig workflow, links to `ts_checklist_responses.checklistId`)
- **Backend:**
  - `POST /api/data/checklist` — `apps/api/src/modules/data-ingestion/routes.ts:237` (perm `CHECKLIST_SUBMIT`)
  - Persistence: `saveChecklist()` in `apps/api/src/modules/data-ingestion/ingestion.repository.ts:160` → writes `ts_checklist_responses` (TSDB) + `ChecklistReview` (PG)
  - Template CRUD propagates `checklistSchema` through `apps/api/src/modules/assets/services/template.service.ts` (5 sites)
- **Frontend:**
  - Authoring: template builder dialog `apps/web/src/routes/assets/templates.tsx` + `components/template-form-editor.tsx` + `components/template-view-dialog.tsx`
  - Reading the schema for an entity: `apps/web/src/routes/assets/components/tabs/checklist-history-tab.tsx`
  - Answering: `/checklist/:entityId` → `apps/web/src/routes/checklist-form/index.tsx` (standalone mobile-style page)
- **Tests:**
  - `apps/api/src/e2e/checklist-templates.test.ts` — template CRUD with `checklistSchema`
  - `apps/api/src/e2e/checklist-submission.test.ts` — `POST /api/data/checklist` with all 14 question types
  - `apps/api/src/modules/assets/services/__tests__/template.service.test.ts`
- **TimescaleDB hypertable:** `ts_checklist_responses` (one of 7 hypertables; subject to retention via `apps/api/src/workers/maintenance-retention.ts`)

### System B — Cleaning Pipeline Gate (cycle-driven)
- **Schema:** `apps/api/prisma/schema.prisma`
  - `ChecklistProfile` — line ~1475
  - `ChecklistQuestion` — line ~1490 (Prisma enum `ChecklistQuestionType` for question type)
  - `FilterPipelineStage` (line ~1282) references checklist profiles via `configuration.checklistProfileId` JSON field on CHECKLIST nodes
- **Backend:**
  - Module: `apps/api/src/modules/checklist-profiles/` — full CRUD under `/api/checklist-profiles` (perms `FCP_*` / `CHECKLIST_*`)
    - `?expand=questions` inlines questions for offline cache
  - Pipeline gate enforcement: `apps/api/src/modules/filter-operations/filter-operations.service.ts` — `advance()` blocks if pending checklist not completed
  - Submit endpoint: `POST /api/filters/:id/submit-checklist` in `apps/api/src/modules/filter-operations/routes.ts:201` (perm `FILTER_OPERATE`)
- **Frontend:**
  - Authoring: `apps/web/src/routes/checklist-admin/list.tsx` + `detail.tsx` (admin-grade) and lighter `routes/checklists/list.tsx`+`detail.tsx`
  - Pipeline-builder reference: `apps/web/src/routes/filter-management/cleaning-profile-editor.tsx` (drops `checklistProfileId` into a CHECKLIST node's configuration)
  - Answering: auto-popup in `apps/web/src/routes/filter-management/components/checklist-dialog.tsx` during cycle advance; same dialog reused on mobile in `routes/mobile/mobile-operations.tsx`
  - Offline cache: `apps/web/src/lib/offline-sync-service.ts` (caches `?expand=questions` payload)
- **Tests:** none dedicated; covered transitively by filter-operations cycle tests

---

## Optional cosmetic cleanup (not required, not done)

If clarity later becomes a pain point, three small things worth considering — none of them schema-breaking:

1. **Rename `AssetTemplate.checklistSchema` → `inspectionSchema`** — disambiguates at every call site. Cost: ~25 file touches, 1 migration. Benefit: future readers stop confusing the two systems.
2. **Schema comments** — add explicit comments on both `AssetTemplate.checklistSchema` and `ChecklistProfile` explaining "Inspection (per-entity) — see Step 5 doc" vs "Cleaning gate (per-cycle) — see Step 5 doc."
3. **UI label tweak** — the `/checklists/list` page (System B authoring) sits next to `/checklist-admin/list` (also System B), and the template builder's checklist tab (System A) doesn't visually distinguish itself. A header subtitle on each page would help.

None of these are blocking. Defer until requested.

---

## What this unblocks

- **Step 6 (FilterDetails 1:1 split)** — was waiting on the checklist question. The split touches `AssetInstance` only; neither checklist system blocks it. Step 6 can proceed.
- **No new memory entry** — the investigation result *is* this doc; future sessions can read it directly.

---

## Verdict

**Action: none. Step 5 is closed as a no-op refactor. Documentation written.** Move on to Step 2 (relationshipType enum + bidirectional check) per the recommended order, or Step 6 if you want to attack the bigger structural issue next.
