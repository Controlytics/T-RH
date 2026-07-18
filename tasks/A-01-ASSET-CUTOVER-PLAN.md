# A-01 — Asset → Typed-Table Cutover Plan

**Status:** Planning (executable sequence for a future multi-week engagement)
**Date:** 2026-05-27
**Goal:** Make the typed hierarchy tables (`blocks` / `areas` / `ahus` / `filters`) authoritative, re-anchor every reference off `asset_instances` / `asset_templates`, then drop the generic models — completing the "replace the generic model with typed tables" direction.
**Predecessors:** Wave 1 (typed tables + `fn_mirror_asset_instance` trigger, 2026-05-17), Wave 2 (read-only `hierarchy.service.ts`, 2026-05-17), M-04 (trigger column fix, 2026-05-27).
**Companion docs:** `tasks/ENTITY-REMOVAL-IMPACT-ANALYSIS.md` (why this is hard), `tasks/PENDING-FIXES-2026-05-25.md` §A-01 (the stub this expands).

> **All counts below were measured against the live `digilog_db` on 2026-05-27**, not copied from prior docs. Re-measure before executing — the data drifts.

---

## 0. The crux: typed tables do NOT cover the whole model

This is the single most important fact for scoping. Measured instance distribution:

| `template_kind` | instances | typed home | templates of this kind |
|---|---|---|---|
| FILTER | 59 | `filters` ✅ | 1 |
| **OTHER** | **53** | **none ❌** | **150** |
| AHU | 19 | `ahus` ✅ | 1 |
| AREA | 10 | `areas` ✅ | 1 |
| BLOCK | 9 | `blocks` ✅ | 1 |
| EQUIPMENT | 0 | none | 0 |
| **total** | **150** | 97 mirrored | **154** |

The typed tables mirror **97 of 150 instances**. The remaining **53 OTHER-kind instances** and the **entire `AssetTemplate` blueprint layer** (154 templates, `attributeSchema`, `telemetrySchema`, `expectedIdentifiers`, version snapshots) have **no typed equivalent**.

**Implication — A-01 splits into two very different asks:**

- **A-01a — Hierarchy cutover (tractable).** Re-anchor the BLOCK/AREA/AHU/FILTER paths onto the typed tables. This is the bulk of the filter-management value and is mechanically bounded. **This plan covers A-01a in full.**
- **A-01b — Eliminate `AssetTemplate` + the OTHER catch-all (open question).** Requires a decision (see §1) on what replaces: (1) the 53 OTHER instances, (2) the `attributeSchema`-driven dynamic create/bulk-upload forms, (3) the template-version audit snapshots. Without that decision, `asset_templates` cannot be dropped. **This plan scopes A-01b but gates it behind a decision.**

Anyone who says "remove the Asset/Template concept" is asking for A-01a **and** A-01b. A-01a alone does not let you drop `asset_templates`.

---

## 1. Decisions required before any code (Phase 0 gate)

| # | Decision | Options | Blocks |
|---|---|---|---|
| D1 | What happens to the **53 OTHER instances**? | (a) add a generic `other_assets` typed table; (b) migrate them to a real kind; (c) keep a slim `asset_instances` for OTHER only | dropping `asset_instances` |
| D2 | What replaces **`attributeSchema`** (dynamic field source)? Consumers are broader than they look: create dialogs **+ bulk-upload + the report engine** (`reports/data-sources/attribute-source.ts` resolves historical attribute values for rendered reports) **+ detail-page dynamic field labels**. Option (b) "hardcode columns" would stop historic reports rendering attribute fields for non-FILTER instances. | (a) move field defs into a config def per typed table; (b) hardcode the filter columns *(breaks historic report attr fields)*; (c) keep `asset_templates` as a pure schema-registry with no instances | dropping `asset_templates` |
| D3 | **Equipment groups** FK `equipment_groups.block_id → asset_instances`. Re-point to `blocks(id)`? | yes (re-FK) / keep soft | Phase 4 |
| D4 | **Audit — two separate questions, don't conflate.** (i) *Identity*: UUID-reuse means the 906 asset-targeted + 1,149 filter-targeted `audit_trail.target_id` values still resolve after the resolver re-anchor (Phase 4) — cheap, safe. (ii) *Content*: dropping `asset_template_versions` (200 audit refs) + the other version sidecars **destroys the historic snapshot content** of what changed at each version — UUID-reuse does NOT save this. Each needs its own 21 CFR §11 sign-off; (ii) may force "archive-don't-drop" for the version tables. | confirm (i); decide (ii) | Phase 4 / Phase 5 |
| D5 | Telemetry / device tables (`latest_telemetry`, `connectivity_status`, `data_streams`, `device_credentials`, `dead_letter_queue`, `qr_codes`, `uns_mappings`) — all `entity_id`-keyed, all currently empty. Drop with M-01 or re-anchor? | drop / re-anchor | Phase 4 |

**Do not start Phase 2 until D1–D5 are signed off.**

---

## 2. Verified surface (the work to be done)

### 2.1 Application call sites (grep, 2026-05-27)
- `prisma.assetInstance.*` — **107 occurrences / 39 files** (incl. tests). Hot spots: `uns.service.ts` (12), `instance.repository.ts` (10), `super-admin/routes.ts` (10), `filter-operations.service.ts` (9), `filter-resolver.ts` (5), `connectivity-tracker.ts` (4), `pm-ahu-config.ts` (4).
- `prisma.assetTemplate.*` — **19 occurrences / 8 files**. Hot spots: `template.repository.ts` (7).
- `prisma.{block,area,ahu,filter}.*` — **14 / 1 file** (only `hierarchy.service.ts`; this is the migrated read surface so far).

### 2.2 Hard FK constraints
**→ `asset_instances` (7):** `entity_assignments.entity_id`, `asset_instances.parent_id` (self), `filter_details.asset_instance_id`, `asset_relationships.source_asset_id`, `asset_relationships.target_asset_id`, `asset_identifiers.asset_id`, `equipment_groups.block_id`.

**→ `asset_templates` (4):** `filter_profile_applicable_templates.template_id`, `template_assignments.template_id`, `asset_template_versions.template_id`, `asset_instances.template_id`.

### 2.3 Soft-FK columns (app-managed UUID, no FK) referencing hierarchy
`cleaning_cycles.{filter_id, ahu_id, cleaning_area_id}`, `filter_events.{filter_id, block_id, cleaning_area_id, equipment_id}`, `block_change_requests.{filter_id, from_block_id, to_block_id}`, `pm_schedules.entity_id`, `pm_executions.entity_id`, `checklist_reviews.entity_id`, `qr_codes.entity_id`, `uns_mappings.entity_id`, `device_credentials.entity_id`, `connectivity_status.entity_id`, `data_streams.entity_id`, `dead_letter_queue.entity_id`, `latest_telemetry.entity_id`, plus `audit_trail.target_id`.

### 2.4 Data volumes to re-anchor (live row counts)
`asset_instances` 150 · `asset_templates` 154 · `filters` 59 · `ahus` 19 · `areas` 10 · `blocks` 9 · `cleaning_cycles` 151 · **`filter_events` 1,409** (largest) · `asset_identifiers` 37 · `filter_details` 59 · `equipment_groups` 5 · `pm_schedules` 7 · `block_change_requests` 1 · `audit_trail` 5,459.

### 2.5 Audit-trail target distribution (immutable, hash-chained — re-anchor by resolver, never delete)
`filter` 1,149 · `asset_template` 244 · `asset_instance` 244 · `asset_template_version` 200 · `asset_identifier` 130 · `asset_relationship` 88 · `report_template` 27.

---

## 3. The UUID-reuse keystone

Wave 1 made the typed tables **reuse `asset_instances.id`** (same UUID in `filters.id`, `blocks.id`, …). This is what makes the cutover survivable:

- Every soft-FK (`cleaning_cycles.filter_id`, `filter_events.filter_id`, …) already holds a UUID that is **valid in both** `asset_instances` and the typed table. Re-anchoring is a *resolver / FK-target* change, **not a data rewrite**.
- Every `audit_trail.target_id` for an asset/filter still points at a row that exists in the typed table. The audit **resolver** must learn to look up typed tables; the **rows are never touched** (21 CFR §11 — D4).

If any future step generates *new* UUIDs for typed rows, this keystone breaks and the plan becomes a full data migration. **Preserve UUID reuse.**

---

## 4. Phased execution sequence

### Phase 0 — Decisions + freeze (1 week)
- Resolve D1–D5 with sign-off.
- Tag `pre-asset-cutover`. Take a verified `digilog_db` + `digilog_tsdb` backup.
- Repair `_prisma_migrations` first (PENDING-FIXES A-02) — DR depends on it.
- Force-complete all `IN_PROGRESS` cleaning cycles (a half-migrated cycle is operator-visible breakage).

### Phase 1 — Parity verification (3–5 days)
- The mirror trigger has been live since 2026-05-17; verify it actually achieved parity: for each kind, assert `count(typed) == count(asset_instances WHERE kind)` and a row-by-row field diff (name/status/parent/uns_path). Write a one-shot `verify-mirror-parity.sql`.
- Fix any drift (e.g., rows created before the trigger existed) with a backfill `INSERT … SELECT` reusing `id`.

### Phase 2 — Write-path cutover (2–3 weeks)
Make typed tables authoritative for the 4 hierarchy kinds. Two viable strategies:
- **(preferred) Reverse the mirror.** New writes go to `prisma.block/area/ahu/filter.*`; a reverse trigger keeps `asset_instances` in sync *during transition* so un-migrated read sites don't break. Rewrite `instance.service.ts` + `bulk-upload-filter.service.ts` + the create/retire/replace paths.
- **(fallback) Dual-write in app code** if trigger-based reverse-sync proves fragile.
- **OTHER (53)** keep flowing to `asset_instances` per D1.

### Phase 3 — Read-path cutover = Wave 5 (3–4 weeks)
- Behind a feature flag, repoint the **107** `assetInstance` read sites to `hierarchy.service` / `prisma.filter.*`, module by module, highest-traffic first (uns → instance.repository → filter-operations → super-admin → connectivity → pm).
- Frontend: the `/api/assets/instances` endpoints can **keep their response shape** (served from typed tables) so the FE's ~30 entity-bound routes need little change. Verify the filters page, mobile wrapper, AHU dashboard against typed-backed responses.
- Port the visibility-filter (EntityAssignment/TemplateAssignment scoping) onto the typed read path — `hierarchy.service` explicitly skips it today (see its header docblock).

### Phase 4 — Soft-FK + audit resolver re-anchor (2 weeks)
- D3: convert `equipment_groups.block_id` FK to `blocks(id)`.
- Re-point the audit/version-history **resolvers** to look up typed tables for `target_type ∈ {asset_instance, asset_template…, filter}`. Rows unchanged.
- D5: drop or re-anchor the empty telemetry/device tables.
- Regenerate `dynamic-backup.ts` FK-order dependency graph (it walks all tables in FK order; reordering models breaks restore — see impact analysis Risk row).

### Phase 5 — Drop legacy (1 week) — **gated on D1 + D2**
- Drop `asset_relationships`, `asset_identifiers` (or rename → `filter_identifiers`), `template_assignments`, `entity_assignments`, `filter_profile_applicable_templates` once their consumers are re-anchored.
- **`asset_template_versions` (and the other version sidecars) are NOT a plain drop** — per D4(ii) they hold immutable snapshot *content* referenced by 200 audit rows; UUID-reuse preserves only identity, not content. Resolve D4(ii) first: likely **archive (export to cold storage / keep read-only) rather than drop** to satisfy 21 CFR §11 record retention.
- Drop `asset_instances` **only after D1** (OTHER has a home) and all 107 sites are migrated.
- Drop `asset_templates` **only after D2** (`attributeSchema` replaced) — this is the literal "remove the template concept" step.
- Remove `fn_mirror_asset_instance` + trigger (no longer needed once typed tables are authoritative).
- Shared types cleanup: prune the orphaned `ASSET_*`/`TEMPLATE_*` permissions, privileges, reauth actions, sidebar items (counts per impact analysis §2.4).

### Phase 6 — Verify + UAT (2–4 weeks calendar)
- Full regression: telemetry ingest, cleaning cycles, PM, RFID, offline sync, mobile APK, **audit hash-chain verification** (must still pass over rows whose target now lives in a typed table), report re-render.
- Rewrite `tests/integration/windows-server-stack.test.ts` for the typed write path.
- Operator UAT on the tablet.

---

## 5. Rollback plan
- **Within a phase:** every migration is paired with a `down.sql`. The reverse-mirror trigger (Phase 2) means `asset_instances` stays populated through Phase 4, so reverting Phases 2–4 is a code-flag flip, not a data restore.
- **After Phase 5 (legacy dropped):** rollback = restore the `pre-asset-cutover` snapshot. There is no in-place reverse once `asset_instances` is dropped. **Phase 5 is the point of no return** — gate it hard.

## 6. Risks (additions beyond the impact analysis)
- **OTHER/template gap (D1/D2)** — the plan cannot drop `asset_templates` without resolving these; easy to under-scope. **Highest risk.**
- **UUID-reuse regression** — any code that mints new UUIDs for typed rows silently turns a resolver change into a 1,400+-row (`filter_events`) data migration.
- **`filter_events` volume (1,409)** + audit chain (5,459) — verification, not rewrite, but the parity/resolver checks must cover every row.
- **`_prisma_migrations` absent** — Phase 0 must repair it or DR/`migrate deploy` is unsafe.

## 7. Effort (order of magnitude, A-01a + A-01b)
Phase 1 ~1wk · Phase 2 ~2–3wk · Phase 3 ~3–4wk · Phase 4 ~2wk · Phase 5 ~1wk · Phase 6 ~2–4wk calendar. **Total ≈ 4–8 focused engineer-weeks** (matches PENDING-FIXES A-01), longer if D1/D2 require building OTHER/equipment typed homes and replacing `attributeSchema`.

---

## 8. Recommended first executable slice (de-risks the rest)
1. **Phase 1 parity check** — write `verify-mirror-parity.sql`, prove the mirror is sound. Cheap, high-confidence, no production change.
2. **One read-path module behind a flag** (suggest `uns.service.ts`, the densest at 12 sites) — proves the Wave-5 pattern end-to-end on real traffic before committing to all 107.

Everything else waits on the D1–D5 decisions.
