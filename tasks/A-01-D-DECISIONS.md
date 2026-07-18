# A-01 D-Decisions — Concrete Option Analysis

**Status:** ✅ **SIGNED OFF 2026-05-29 — all recommendations accepted by user.**
**Date:** 2026-05-29

## Decisions accepted
- **D1:** C — keep slim `asset_instances` for OTHER-kind only
- **D2:** A — per-kind config defs (extend Filter-Field-Options pattern)
- **D3:** A — re-FK `equipment_groups.block_id` → `blocks(id)`
- **D4(i):** Yes — audit resolver re-anchor
- **D4(ii):** B — archive `asset_template_versions.snapshot` to cold storage then drop
- **D5:** A — drop the 7 empty telemetry tables

**What's now unblocked:**
- `checklist-form/index.tsx` migration (was D2-blocked) — can now build `Checklist-Schema-Per-Kind` config + drop the `entity.template.checklistSchema` read.
- Phase 2 backend write-cutover — can execute per `A-01-PHASE-2-PLAN.md`.
- Phase 4 — `equipment_groups.block_id` reanchor + audit resolver re-anchor.
- Phase 5 — drop legacy tables (after Phase 2/4 complete + asset_template_versions archived).

---

**Purpose:** Five decisions in the A-01 cutover plan that gate Phases 2/4/5. Each has a recommendation, but business / compliance ownership is yours.

> **Why these matter:** the A-01 frontend read-path migration (Wave 5) is well under way (7 of 14 pages done as of commit `3e2251d`). Backend write-path cutover (Phase 2) can start independently. But **dropping the legacy `asset_instances` / `asset_templates` tables (Phase 5 — point of no return)** is blocked until D1–D5 are answered. So is `checklist-form` page migration (D2-blocked) and the equipment-groups schema cleanup (D3-blocked).

Reply with `D1: <option>` etc. for each, or just "all recommended" to take every recommendation.

---

## D1 — What happens to the 53 `OTHER`-kind `asset_instances`?

**Context.** Live DB inventory: BLOCK 9, AREA 10, AHU 19, FILTER 59, **OTHER 53**. Wave 1 typed tables (`blocks`/`areas`/`ahus`/`filters`) cover the four hierarchy kinds only. The 53 OTHER instances have **no typed home** today. Dropping `asset_instances` without addressing OTHER orphans those rows and any soft-FK that points at them.

**What OTHER actually is** (queried live): mostly imported legacy entries + a few test rows. None are wired into cleaning cycles, PM schedules, or audit-targeted operations. Many will turn out to be dead data on close inspection.

| | Option | Cost | Pro | Con |
|---|---|---|---|---|
| **A** | Add an `other_assets` typed table mirroring the schema; migrate the 53 rows. | 1 migration + ~30 lines of resolver code | Clean — `asset_instances` becomes truly droppable | Adds a 5th typed table for ~53 rows; design overhead unjustified by data volume |
| **B** | Audit each OTHER instance manually; migrate to a real kind where possible, hard-delete the rest. | 1 day of manual triage | Most reduction in surface | Manual labor; some rows may be ambiguous |
| **C** ✅ | Keep a slim `asset_instances` table for OTHER only. Drop the FILTER/AHU/AREA/BLOCK rows after Wave 6; leave OTHER + the `template_kind='OTHER'` rows alone. | Zero schema change beyond the legacy-table slimming we'd do anyway | Lowest risk; defers the OTHER question indefinitely; `asset_instances` becomes a thin OTHER-only table | "Concept not fully gone" — but the OPERATOR doesn't see OTHER instances anywhere in the UI; it's effectively dead-storage |

**Recommendation: C.** OTHER is operationally invisible. Keeping a 53-row legacy table for it costs near-zero. We can revisit D1 again later if/when those 53 rows are actually consumed by anything. Critically, this **lets Wave 6 drop the hierarchy rows** (which is the visible benefit) without forcing the unrelated OTHER question.

---

## D2 — What replaces `attributeSchema`?

**Context.** `asset_templates.attribute_schema` is a JSONB column listing the dynamic fields each instance can have (`fieldName`, `dataType`, `dropdownOptions`, `required`, `unit`, ...). It's consumed by:
- **Create/Edit dialogs** — render dynamic form fields from the schema
- **Bulk-upload CSV** — derive CSV columns from the schema
- **Report engine** — `reports/data-sources/attribute-source.ts` resolves historical attribute values
- **Detail pages** — dynamic field labels
- **Checklist form** — `entity.template.checklistSchema` (related — same model)

Dropping `asset_templates` without a replacement breaks all five surfaces. **This is the blocker for `checklist-form/index.tsx` migration.**

| | Option | Cost | Pro | Con |
|---|---|---|---|---|
| **A** ✅ | Per-kind config def. Filter-Field-Options already exists (we shipped it earlier). Add Ahu-Field-Options, Block-Field-Options, etc. as needed. Move `checklistSchema` to per-kind config too. | Several days for full migration; trivial per page once the pattern is wired | Matches the direction this session has already taken; admin-editable lists; per-kind type safety; eliminates the AssetTemplate concept entirely | Several configs to seed/migrate |
| **B** | Hardcode the canonical fields per typed table (`filters.micron_size`, `filters.filter_type`, etc.) as real DB columns. | One migration per added column; rebuild Prisma | Strongest typing; queries get clean WHERE clauses | Loses operator-add-a-field flexibility; every new field is a code change |
| **C** | Keep `asset_templates` as a pure schema-registry — no instances, only schema rows. Drop `asset_instances` but retain `asset_templates`. | Compromise; partial concept removal | Lower-effort | Half-hearted; the "Asset Template" concept lingers and operators still see it for schema editing |
| **D** | Bare-JSONB attributes with no schema enforcement. Anyone can write anything to `attributes`. | Zero migration | Simplest | Loses validation; breaks 21 CFR (no documented field semantics) |

**Recommendation: A.** It matches what we've already started building (Filter Field Options). It admin-extends without code changes. It's the only option that lets `asset_templates` actually drop while preserving operator workflows.

**Practical first step (if A):** I write `Block-Field-Options`, `Ahu-Field-Options`, `Area-Field-Options` config defs the same way as `Filter-Field-Options`. Then `checklist-form/index.tsx` can read the checklist schema from a `Checklist-Schema-Per-Kind` config instead of `entity.template.checklistSchema`.

---

## D3 — Re-FK `equipment_groups.block_id` → `blocks(id)`?

**Context.** Today `equipment_groups.block_id` is a hard FK to `asset_instances(id)` with `ON DELETE RESTRICT`. After Phase 5 drops `asset_instances`, this FK breaks. Need to re-point to the typed `blocks(id)`.

| | Option | Cost | Pro | Con |
|---|---|---|---|---|
| **A** ✅ | Drop the old FK, add new FK to `blocks(id)` with `ON DELETE RESTRICT`. | 1 Prisma migration; ~5 minutes | Clean; preserves the safety constraint | None |
| **B** | Convert to soft FK (no constraint) and rely on app-level checks. | Same migration | Symmetric with other soft FKs in the codebase | Loses DB-level safety net |

**Recommendation: A.** No real downside; preserves the existing safety.

---

## D4 — Audit-trail: identity vs content split (21 CFR §11)

**Context.** The audit_trail has:
- **906 rows** targeting `target_type ∈ {asset_template, asset_instance, asset_template_version, asset_identifier, asset_relationship}`
- **200** of those target `asset_template_version` specifically (immutable snapshot rows of the template at the time of an edit)

**UUID reuse** in the Wave 1 typed tables preserves audit `target_id` validity for the hierarchy kinds — the typed tables reuse `asset_instances.id`, so a row pointed at `<filter_uuid>` continues to resolve after the legacy table drops. That covers **identity**.

But **content** is a separate question. `asset_template_versions.snapshot` JSONB captures *what the template's schema was at version N*. Dropping the table destroys that historic content forever — even if we keep the audit row's `target_id` resolvable, the actual snapshot data is gone.

| Sub-question | Option | Cost | Pro | Con |
|---|---|---|---|---|
| **D4 (i) — Identity** | Re-anchor audit resolver to typed tables when `target_type ∈ {asset_instance, asset_identifier, asset_relationship}`. | ~50 lines in audit-rendering | Audit lookups continue to work | None |
| **D4 (ii) — Content** | Choose what happens to `asset_template_versions.snapshot` data: |
| |  ↳ **Drop with the table** | 0 | Maximum cleanup | Loses 200 historical snapshot bodies — likely violates 21 CFR §11 retention |
| | **B ✅** — **Archive to read-only cold storage** (export to JSON file, archive in tasks/audit-archives/ or external storage) then drop | 1 export script, ~1 hour | Preserves the content for inspector retrieval; DB stays clean | Cold-storage retrieval is slower |
| |  ↳ Keep `asset_template_versions` indefinitely as a read-only legacy table | 0 | Easiest | "Concept not fully gone" |

**Recommendation: D4(i) yes + D4(ii) B.** Re-anchor identity (cheap and necessary), archive content (preserves compliance while letting the live table drop). 21 CFR §11 §11.10(e) — record retention — is satisfied by archive; nothing says the records must remain in the active database.

---

## D5 — Telemetry / device-credential tables fate

**Context.** These tables exist but are **all currently empty** (telemetry ingestion was never wired into production):
- `device_credentials` (0 rows)
- `connectivity_status` (0 rows)
- `data_streams` (0 rows)
- `dead_letter_queue` (0 rows)
- `qr_codes` (0 rows)
- `uns_mappings` (1 orphan row per memory; effectively 0)
- `latest_telemetry` (0 rows)

Each carries a soft `entity_id` UUID column that would orphan when `asset_instances` drops.

| | Option | Cost | Pro | Con |
|---|---|---|---|---|
| **A** ✅ | Drop them. All empty. No data loss. | 1 Prisma migration | Eliminates 7 empty tables + their indexes + their schema models | Removes future telemetry capability — would need to re-add if telemetry ever ships |
| **B** | Reanchor `entity_id` to typed FKs (per table). | 7 migrations + service-side updates | Future-ready | Significant work for no current value; telemetry product was deprioritised |
| **C** | Leave them with the broken FK and rely on app code never writing | Zero now | No work | Latent bug; the next time telemetry is wired up, it'll silently break |

**Recommendation: A.** Drop them. The telemetry product was deprioritised; reintroducing it later is a new feature decision, not a "preserve the option" cost. The M-01 task in `tasks/PENDING-FIXES-2026-05-25.md` already flagged most of these for drop independently.

---

## Decision summary card (sign-off here)

| | Decision | Recommendation | Approve? |
|---|---|---|---|
| D1 | OTHER instances → | C: keep slim asset_instances for OTHER only | _________ |
| D2 | attributeSchema → | A: per-kind config defs (extend Filter-Field-Options pattern) | _________ |
| D3 | equipment_groups.block_id → | A: re-FK to blocks(id) | _________ |
| D4(i) | Audit identity → | Yes: resolver re-anchor | _________ |
| D4(ii) | Audit content → | B: archive `asset_template_versions.snapshot` then drop | _________ |
| D5 | Telemetry tables → | A: drop all 7 | _________ |

Reply "all recommended" or override per item. Once approved, Phase 2 (write-path cutover) and Phase 5 (drop legacy) can proceed without further blockers.
