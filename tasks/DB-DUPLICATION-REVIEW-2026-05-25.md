# DigiLog — Database Duplication & Consolidation Review (2026-05-25)

**Sibling document to** `tasks/DB-AUDIT-2026-05-25.md` (which covers unused tables / indexes / FK issues). **This document covers duplication, redundancy, normalization, and consolidation opportunities** — same database, different lens.

**Scope**: Production `digilog_db` (PostgreSQL 18, Prisma 6.3, 68 tables). All findings backed by `pg_catalog` + `information_schema` queries that can be re-run at any time.

**Severity** scale: Critical (data integrity at risk), High (architecture debt blocking other work), Medium (cleanup with measurable benefit), Low (cosmetic).

---

## 0. Executive Summary

The DB is **mid-migration** with **substantial structural duplication**. Two patterns dominate:

1. **Hierarchy half-migration** — the 2026-05-17 typed-hierarchy work added `blocks`/`areas`/`ahus`/`filters` sidecar tables that hold the same hierarchy data as `asset_instances`. The sidecars are not authoritative. Result: **the same business entity exists in two tables at once**, and a drift is silent.
2. **Versioning sidecar proliferation** — 6 separate `*_versions` tables (`asset_template_versions`, `checklist_profile_versions`, `equipment_group_versions`, `filter_profile_versions`, `help_article_versions`, `report_template_versions`). Each uses an identical `snapshot` JSONB pattern. Could be one polymorphic `entity_versions` table or — better — `pgmemento`-style row-level audit.

Beyond those, the duplication is at the column-name level (28 tables share `created_by`, 16 share `updated_by`, 8 share `template_id`, etc.) which is **normal for an audit-heavy app**, but several specific cases are real duplication, called out below.

The single most leveraged consolidation is finishing the asset cutover (`A-01` in `tasks/PENDING-FIXES-2026-05-25.md`). After that, the version-sidecar consolidation (`M-04` below) is the next biggest unlock.

---

## 1. Headline finding inventory

| # | Finding | Severity | Type |
|---|---|---|---|
| D-01 | Same hierarchy in `asset_instances` AND `blocks/areas/ahus/filters` sidecars | Critical | Same-entity-in-two-tables |
| D-02 | `filter_details` is 1:1 with `filters` sidecar — could be merged | High | Unnecessary 1:1 split |
| D-03 | Current state mirrored in 3 places (`asset_instances` legacy + `filter_details` + `filters` sidecar) | Critical | Column-level duplication + drift risk |
| D-04 | Six separate `*_versions` tables with identical shape | High | Architectural redundancy |
| D-05 | Two config tables (`system_config` + `ingestion_system_config`) | Medium | Module-level duplication |
| D-06 | Roles permissions stored in 3 places (`roles.permissions` JSON + `role_configs.permissions` JSON + per-permission code constants) | High | Denormalization + drift risk |
| D-07 | Cycle status mirrored: `cleaning_cycles.status` + `filter_details.current_cycle_id` + `filter_details.current_lifecycle_state` | High | Source-of-truth ambiguity |
| D-08 | Audit metadata duplicated (`ip_address`/`user_agent`/`session_id` on 3+ tables) | Low | By design (audit chain — each event needs context). Document, don't dedup. |
| D-09 | `attributes` JSONB column on 6 hierarchy tables (`asset_instances`/`blocks`/`areas`/`ahus`/`filters`/`filter_events`) | Medium | Couples to D-01 |
| D-10 | `custom_attributes` JSONB on 5 tables — separate from `attributes`, purpose unclear | Medium | Schema confusion |
| D-11 | `uns_path` column on 7 tables — should be derived, not stored | Medium | Computed-field-as-stored |
| D-12 | Three "assignment" tables with same shape (`entity_assignments`/`template_assignments`/`dashboard_assignments`) | Medium | Could be polymorphic |
| D-13 | `equipment_group_instruments` vs `equipment_group_versions.snapshot` — instruments stored twice | Medium | Version snapshot + live row drift |
| D-14 | `filter_pipeline_stages` + `filter_pipeline_connections` for a graph that fits cleanly in JSONB | Low | Normalization choice — debatable |
| D-15 | `notification_logs` + `notifications` + `notification_templates` + `notification_rules` + `notification_rule_recipients` (5 tables for one feature) | Medium | Feature over-modelled relative to usage |
| D-16 | `electronic_signatures` + `report_signatures` — separate tables, same shape | Low | Could be one signatures table with FK polymorphism |
| D-17 | `dashboards` + `dashboard_widgets` + `dashboard_assignments` (3 tables, 0 rows each) | Low | Built but unused; not duplication per se, but dead weight |
| D-18 | `audit_trail` + `filter_events` overlap: both are immutable history with `performed_by` / `ip_address` | Low | Different scopes (system vs cycle) — keep both but document |
| D-19 | `password_history` + `audit_trail` (PASSWORD_CHANGED event) — change tracked twice | Low | password_history serves reuse-prevention; audit_trail serves §11 attestation. Different purposes. Don't merge. |
| D-20 | `roles` + `role_configs` — separate tables for the same role data | High | Should be one |
| D-21 | `user_configs` mirrors a subset of `role_configs` for per-user overrides | Medium | Polymorphism opportunity |
| D-22 | 28 tables carry `created_by` (varchar username), but the user record itself lives in `users` (UUID PK) | Low | Audit-chain decision — keeping the snapshot username at the moment of write is intentional |
| D-23 | `ingestion_system_config` has its own audit columns separate from `system_config` | Medium | Couples to D-05 |
| D-24 | Cycle's profile snapshotted as `profile_id` + `profile_version` + `checklist_version_pins` — three columns for what could be one snapshot row | Low | Intentional — denormalized for cheap reads |
| D-25 | Empty `asset_template_versions` (200 rows) tracks template edits the operator may not need — versioning was wired for compliance but no inspector has ever asked | Low | Compliance hedge |

---

## 2. Critical findings — detailed

### D-01 — Same hierarchy in `asset_instances` AND typed sidecar tables

**The single biggest duplication issue in the database.** Live counts (2026-05-25 18:51):

| Table | Rows | Authoritative? |
|---|---|---|
| `asset_instances` | 149 | **YES** — `cleaning_cycles.filter_id` and `filter_events.filter_id` FK target this table |
| `asset_templates` | 154 | Yes — required by `asset_instances.template_id` NOT NULL FK |
| `asset_relationships` | 136 | Yes — generic relationship graph |
| `asset_identifiers` | 31 | Yes — RFID/barcode mappings FK to `asset_instances` |
| `blocks` | 8 | No (sidecar) |
| `areas` | 10 | No (sidecar) |
| `ahus` | 19 | No (sidecar) |
| `filters` | 59 | No (sidecar) |
| `filter_details` | 59 | Yes — 1:1 with `filters` but FKs `asset_instance_id` |

**Business purpose overlap**: every filter, block, area, AHU exists as BOTH an `asset_instances` row (with `template_id` indicating its type) AND a row in the matching sidecar table. The 2026-05-17 typed-hierarchy migration was the start of a cutover that's not yet complete.

**Drift risk** (real, not hypothetical):
- Insert a filter through a code path that only writes `asset_instances` → it never appears in `filters`. FE views querying `filters` miss it.
- Mutate a filter's name via `asset_instances.name` UPDATE → the `filters.name` shadow stays stale.
- The reverse (write only to `filters`) silently fails because cleaning cycles can't FK to it.

**Frontend impact**: hierarchy view, filter list, cycle history all read from `asset_instances` today. The sidecar tables exist as future-state but no FE component is wired to them.

**Compliance impact**: `filter_events.filter_id → asset_instances(id)` is the audit-chain anchor. Migrating that FK is the hardest part of the cutover and the reason this is multi-week work.

**Cleanup recommendation**: Complete the cutover. See `A-01` in `PENDING-FIXES-2026-05-25.md`. Sequence:
1. Migrate every `prisma.assetInstance.*` query site to the typed table (~150 sites)
2. Re-anchor `cleaning_cycles.filter_id` FK to `filters(id)`
3. Re-anchor `filter_events.filter_id` FK to `filters(id)` — this breaks audit chain by changing event provenance, so requires §11 sign-off
4. Re-anchor `asset_identifiers.asset_id` to `filters(id)` (rename to `filter_identifiers`)
5. Drop the legacy tables

**Migration complexity**: Very High (4–8 weeks). **Rollback risk**: High — partial migration leaves the DB worse than today. Plan for a backup + verify harness.

### D-03 — Lifecycle state mirrored in 3 places

After D-01, the second-biggest source of bugs. Per-cycle state appears in three columns across the schema:

| Table | Column | Purpose |
|---|---|---|
| `asset_instances` | `attributes->>'currentLifecycleState'` (legacy) | Was authoritative pre-Step-6 |
| `filter_details` | `current_lifecycle_state` | Authoritative since Step 6 (2026-05-01) |
| `filters` | `current_lifecycle_state` (sidecar) | Mirror added by the typed-hierarchy migration |

Today's session: I terminated several cycles via SQL and cleared `filter_details.current_lifecycle_state`. The `filters` sidecar was NOT cleared automatically — silent drift.

**Drift risk**: `filter-details.ts` and `filter-resolver.ts` read `filter_details`. The sidecar's column is read by nobody (idx_scan = 0 on the index), but if a future code path starts reading it, it'll see stale data.

**Cleanup recommendation**: Drop the column from the sidecar OR set up a trigger to keep them in sync until the asset cutover completes. Trigger is cheaper; column-drop is safer long-term but couples to D-01.

**Migration complexity**: Low (drop column) or Medium (trigger). **Rollback risk**: Negligible.

---

## 3. High-severity findings — detailed

### D-02 — `filter_details` and `filters` are 1:1 — should be merged

| | |
|---|---|
| Tables | `filters` (59 rows) ↔ `filter_details` (59 rows) |
| Foreign key | `filter_details.asset_instance_id → asset_instances(id)` (legacy FK target) |
| Columns split | `filters` has: name, ahu_id, status, is_active, current_lifecycle_state, current_cycle_id, filter_profile_id, filter_set, custom_attributes, uns_path. `filter_details` has: asset_instance_id, current_lifecycle_state, current_cycle_id, filter_profile_id, filter_set. |
| Overlap | 4 columns are duplicated (`current_lifecycle_state`, `current_cycle_id`, `filter_profile_id`, `filter_set`). |

**Why two tables?** History: `filter_details` was created as a "sidecar of mutable state" off `asset_instances` (Step 6, 2026-05-01). Then the typed-hierarchy work added `filters` with overlapping columns.

**Cleanup recommendation**: When the asset cutover lands (D-01), merge `filter_details` columns into `filters` and drop `filter_details`. Until then, fix the FK so both can coexist:
1. Add a `filter_id UUID NOT NULL UNIQUE REFERENCES filters(id)` column to `filter_details`
2. Backfill from `asset_instance_id` via the 1:1 mapping
3. Make `filter_details.asset_instance_id` nullable; eventually drop it

**Migration complexity**: Medium. **Rollback risk**: Low.

### D-04 — Six identical `*_versions` tables

All follow the same shape: `id, profile_id, version_number, snapshot JSONB, change_notes, created_by, created_at`.

| Versioning table | Parent table | Rows | Live data? |
|---|---|---|---|
| `asset_template_versions` | `asset_templates` | 200 | yes |
| `checklist_profile_versions` | `checklist_profiles` | 12 | yes |
| `equipment_group_versions` | `equipment_groups` | 0 | wired, never used |
| `filter_profile_versions` | `filter_profiles` | 0 | wired, never used |
| `help_article_versions` | `help_articles` | 327 | yes |
| `report_template_versions` | `report_templates` | 24 | yes |

**Consolidation options:**
- **Option A**: One polymorphic table `entity_versions(id, parent_type, parent_id, version_number, snapshot, change_notes, created_by, created_at)`. Pros: 1 table, 1 set of indexes, 1 set of code. Cons: loses FK constraint per parent type (would need application-level enforcement).
- **Option B**: Keep separate tables but extract the boilerplate into a Prisma include / repository pattern. Less DB consolidation, less risk.
- **Option C**: Switch to row-level audit via Postgres triggers (`pgmemento` / `pgaudit`) — eliminates per-entity version tables entirely.

**Recommended**: Option B short term (no DB change, just code DRY-up). Option A/C as a 2027 architectural decision.

**Migration complexity**: A is High; B is Low; C is High.

### D-06 — Role permissions stored in 3 places

| | Storage | Used by |
|---|---|---|
| 1 | `roles.permissions` JSON array of permission strings | Backend `requirePermission()` middleware |
| 2 | `role_configs.permissions` JSON object `{ [featureKey]: boolean }` | FE feature-flag rendering (`<RequireRole>`) |
| 3 | `packages/shared/src/types/permissions.ts` constants — 97 permission keys | Code-time validation |

The three need to stay in sync. Drift is real — memory `feedback_role_perms_after_restore` documents incidents where DB restore desynced `roles.permissions` and broke RBAC.

**Why this exists**: pre-multi-tenancy-removal, `role_configs` held org-specific overrides. After MT removal (2026-04-30), `role_configs` should have been collapsed back into `roles`. It wasn't.

**Cleanup recommendation**:
1. Move `role_configs.permissions` semantics into `roles.permissions` (extend the JSON object shape)
2. Drop `role_configs` (or rename to `role_ui_config` if it carries `sidebar_items` / `home_widgets` only)
3. Add a Prisma transformer that validates `roles.permissions` against the shared constants on every write

**Migration complexity**: Medium. **Rollback risk**: Medium — RBAC is high-blast-radius.

### D-07 — Cycle status mirrored

Three sources of truth for "is this cycle active":

| Source | Column | Authoritative? |
|---|---|---|
| 1 | `cleaning_cycles.status = 'IN_PROGRESS'` | YES per the model |
| 2 | `filter_details.current_cycle_id IS NOT NULL` | Mirror — set on advance, cleared on terminate/complete |
| 3 | `filter_details.current_lifecycle_state IS NOT NULL` | Mirror — set on stage advance |

If you drop #2 + #3, the FE has to JOIN to `cleaning_cycles` to know the active cycle on every load. That's fine for performance (filters are small N) but breaks offline caching.

**Cleanup recommendation**: Keep all three but enforce sync via a trigger. The trigger writes #2 and #3 on every cycle status change. Manual SQL that touches `cleaning_cycles.status` without updating filter_details has caused multiple bugs today (see commit `93f3f73` for the most recent — `terminated_at` not written).

**Migration complexity**: Low (add a trigger). **Rollback risk**: Negligible.

### D-20 — `roles` and `role_configs` overlap

Same identifier (role name) used as the PK in `roles` and FK in `role_configs`. Couples to D-06.

| | `roles` columns | `role_configs` columns |
|---|---|---|
| | id, name, description, permissions (JSON), is_active, created_at, ... | role, sidebar_items (JSON), home_widgets (JSON), permissions (JSON), ... |

Both hold a `permissions` JSON for the same role. `role_configs.permissions` is the per-feature toggle (`{featureKey: true}`) and `roles.permissions` is the permission-constant array (`["CYCLE_START", ...]`). The mapping is via `FEATURE_TO_PERMISSION_MAP` in shared code.

**Cleanup recommendation**: Merge into one `roles` table with a structured JSON: `{ permissions: [...], features: {...}, sidebar: [...] }`. Drop `role_configs`.

**Migration complexity**: Medium. **Rollback risk**: Medium.

---

## 4. Medium-severity findings — detailed

### D-05 — Two config tables

| Table | Rows | Schema |
|---|---|---|
| `system_config` | 30 | (config_key VARCHAR PK, config_value JSONB, config_type, updated_at, updated_by) |
| `ingestion_system_config` | 33 | Similar shape, separate audit columns |

The split is historical. `ingestion_system_config` came from the data-ingestion module rewrite. They could be one table with a `module` discriminator column.

**Cleanup recommendation**: Add `module VARCHAR` to `system_config`, migrate `ingestion_system_config` rows in with `module = 'ingestion'`, drop the duplicate table.

**Migration complexity**: Medium (touches ingestion module config readers). **Rollback risk**: Low.

### D-09 — `attributes` JSONB column on 6 hierarchy tables

Every hierarchy table has an `attributes JSONB` column that holds the operator-editable values defined by the parent template's `attributeSchema`. After D-01 cutover, each typed table will hold its own typed columns instead. Until then, the JSONB blob is the cost of polymorphism.

**Cleanup recommendation**: Couples to D-01. No standalone action.

### D-10 — `custom_attributes` JSONB on 5 tables — separate from `attributes`

5 tables (`ahus`, `areas`, `asset_instances`, `blocks`, `filters`) have BOTH `attributes` AND `custom_attributes` columns. The intended semantic split is unclear from the schema:
- `attributes` = template-schema-driven attributes
- `custom_attributes` = freeform key-value pairs operators add ad-hoc

In practice both are JSONB. The split adds confusion without clear schema enforcement.

**Cleanup recommendation**: Either:
- Document the semantic distinction clearly and lint-enforce it, OR
- Merge into a single `attributes` JSONB with reserved-key conventions

**Migration complexity**: Low. **Rollback risk**: Low.

### D-11 — `uns_path` on 7 tables — should be derived

`uns_path` (e.g., `"digilog/v1/cwh/ahu-e/01-00"`) appears on `ahus`, `areas`, `asset_instances`, `blocks`, `data_streams`, `filters`, `uns_mappings`. **It's derivable from the parent chain** — walking up the hierarchy and joining names.

Storing it denormalized makes it 7-way drift-prone: rename a parent and every descendant `uns_path` is stale unless the application backfills.

**Cleanup recommendation**: Either:
- Convert all `uns_path` columns to generated columns (`GENERATED ALWAYS AS (derive_path(...)) STORED`) — needs a SQL function for the path derivation, OR
- Drop the columns and compute at query time (cheap for hierarchy depth ≤ 6)

**Migration complexity**: Medium. **Rollback risk**: Low.

### D-12 — Three "assignment" tables with same shape

| Table | Rows | Shape |
|---|---|---|
| `entity_assignments` | 0 | (entity_id, user_id, role_value, permissions, assignee_type, ...) |
| `template_assignments` | 0 | similar |
| `dashboard_assignments` | 0 | similar |

All three are MT-removal residue. All empty. Could be one polymorphic `assignments` table with a `target_type` discriminator — but since none have rows, the right answer is **drop all three after grep verification**.

**Cleanup recommendation**: Drop. See M-01 in `PENDING-FIXES-2026-05-25.md`.

### D-13 — `equipment_group_instruments` vs `equipment_group_versions.snapshot`

Live instruments live in `equipment_group_instruments` (15 rows). When a group is versioned, the whole composite gets snapshotted into `equipment_group_versions.snapshot` JSONB. The snapshot is the audit anchor; the live row is the editable copy.

This is **intentional duplication for audit compliance**. The risk is silent — operator edits live, snapshot stays old (correct! — the snapshot is meant to be frozen).

**Cleanup recommendation**: None needed. Document the contract clearly in `apps/api/src/modules/equipment-groups/CLAUDE.md` (if not already).

### D-15 — 5 tables for the notification feature

`notifications` (95 rows in-app feed) + `notification_logs` (0, email/SMS dispatch log) + `notification_rules` (1 seed) + `notification_rule_recipients` (0) + `notification_templates` (1 seed).

5 tables for one feature. Justifiable architecturally but over-modelled relative to current usage. The feature is built but not configured (per F-15 in the previous audit).

**Cleanup recommendation**: No DB change. Decide whether to USE the rules system or simplify to just `notifications` (in-app bell only) + DROP `notification_rules`/`notification_rule_recipients`/`notification_templates`. Product decision.

### D-21 — `user_configs` mirrors `role_configs`

`user_configs(id, user_id, sidebar_items JSON, home_widgets JSON, permissions JSON, ...)` — 3 rows.

Same shape as `role_configs` but at the per-user level instead of per-role. Used by the per-user UI customisation feature.

**Cleanup recommendation**: Couples to D-20. When `role_configs` merges into `roles`, do the same for `user_configs` → `users.ui_config JSONB`.

### D-23 — `ingestion_system_config` separate audit columns

Couples to D-05.

---

## 5. Low-severity findings — detailed

### D-08 — Audit metadata duplicated (by design)

`ip_address`, `user_agent`, `session_id`, `performed_by` columns appear on:
- `audit_trail` (4,399 rows) — system audit log
- `filter_events` (699 rows) — per-cycle event log
- `sessions` (904 rows) — session metadata
- `report_signatures` (0 rows) — signature provenance

This is **intentional** — each audit event needs its own copy of the context because the source rows (sessions, etc.) can be deleted/rotated. Same pattern in every 21 CFR §11 audit chain implementation.

**No action**. Document the intent in `tasks/AUDIT-CHAIN-DESIGN.md` if not already.

### D-14 — Pipeline modelling

`filter_pipeline_stages` (165) + `filter_pipeline_connections` (155) is a normal relational graph. For a graph this small, JSONB inside the parent `filter_cleaning_profiles.graph` would work fine and reduce two tables to one. But the current schema gives queryability (e.g., "find every profile that uses CHECKLIST node X") that JSONB would lose.

**No action recommended** — the current normalisation is correct.

### D-16 — Two signatures tables

`electronic_signatures` + `report_signatures`. Both 0 rows. Could be one. Couples to drop in M-01 since both are empty.

### D-18 — `audit_trail` + `filter_events` overlap

Both are immutable history tables with `performed_by`, `ip_address`, etc. They serve different audit chains:
- `audit_trail` = system-wide compliance log, hash-chained per §11.10(e)
- `filter_events` = per-cycle pipeline events, used for cycle reconstruction

Schema duplication is real but **business purpose is different**. Don't merge.

### D-22 — `created_by` carries usernames (varchar) not user UUIDs

This is the standard audit-chain pattern: snapshot the username at the moment of write so the audit row stays intelligible even if the user is later renamed/deleted. Comes at the cost of an extra column per audit-relevant table.

**No action**.

---

## 6. Consolidation opportunities — ranked

| # | Opportunity | Effort | Value | Notes |
|---|---|---|---|---|
| 1 | Finish asset cutover (D-01) | 4–8 weeks | Eliminates the single biggest duplication | Track via `A-01` |
| 2 | Merge `roles` + `role_configs` (D-06 + D-20) | 1 week | Removes drift risk in RBAC | Highest practical ROI today |
| 3 | Add sync trigger for `filter_details` ↔ `filters` (D-03) | 0.5 day | Mitigates drift until cutover | Cheap interim measure |
| 4 | Consolidate `*_versions` tables OR move to pg trigger audit (D-04) | 2-3 weeks | Less code, simpler reads | Couples to D-01 |
| 5 | Merge `system_config` + `ingestion_system_config` (D-05) | 2 days | One fewer config surface | Touches ingestion |
| 6 | Generated-column `uns_path` everywhere (D-11) | 2 days | Eliminates rename-drift | Needs SQL function |
| 7 | Drop the 3 empty assignment tables (D-12) | 1 hour | Schema noise reduction | Tied to M-01 sweep |
| 8 | Merge `electronic_signatures` + `report_signatures` (D-16) | 0.5 day | Schema noise reduction | After feature ships |
| 9 | Wave 4 empty-table sweep (covers D-12, D-16, etc.) | 1–2 days | -10 tables visible win | Per-table sign-off |
| 10 | Document audit-chain duplication is intentional (D-08, D-18, D-22) | 1 hour | Prevents future "let's dedup this!" PRs | Just write the doc |

---

## 7. Execution waves

### Wave 1 — Low-risk reversible cleanups (1 day)

- Add trigger to sync `filter_details` ↔ `filters` (D-03)
- Drop the dead `audit_trail.session_id_idx` and other 0-scan indexes from previous audit
- Document the audit-chain intentional duplications (D-08, D-18, D-22)

**Verification**: existing test suite passes; no behaviour change.

### Wave 2 — Configuration consolidation (3 days)

- Merge `ingestion_system_config` into `system_config` with `module` discriminator (D-05)
- Drop `ingestion_system_config`

**Verification**: API smoke test against ingestion module config endpoints.

### Wave 3 — RBAC consolidation (1 week)

- Extend `roles.permissions` to carry the feature-toggle shape currently in `role_configs.permissions` (D-06 + D-20)
- Migrate all 7 active `role_configs` rows
- Drop `role_configs` (and consolidate `user_configs` similarly per D-21)
- Update FE `<RequireRole>` to read from the new shape

**Verification**: Login as every role; verify each user sees the same sidebar/permissions as before.

### Wave 4 — Empty residue table drops (1–2 days)

Already specified as `M-01` in pending-fixes. Drops D-12, D-16, and the rest of the MT-removal residue.

### Wave 5 — Asset cutover (4–8 weeks)

The big migration. Already specified as `A-01`. Eliminates D-01, D-02, D-03 (and the column-level mirrors), partially D-09, D-10.

### Wave 6 — Optional cleanups (deferred)

- Generated `uns_path` columns (D-11)
- Version-sidecar consolidation (D-04 Option A or C)
- Pipeline-graph JSONB consolidation (D-14, if anyone misses the queryability)

---

## 8. What the duplication is COSTING right now

Concrete numbers from live `pg_stat_*`:

| Cost | Estimate |
|---|---|
| Storage waste from sidecar tables | ~480 KB across `blocks`/`areas`/`ahus`/`filters` (negligible) |
| Wasted INSERTs per write (asset_instance + sidecar) | 2× write amplification on hierarchy mutations |
| Wasted reads (hierarchy walker fetches both representations in some code paths) | 1–2 extra queries per cycle start |
| Engineering debt from `roles` ↔ `role_configs` | The reason `feedback_role_perms_after_restore` exists — recurring desync incidents |
| Engineering debt from D-04 versioning duplication | 6 separate code paths to maintain when one would do |
| Compliance audit complexity | Inspector has to understand both `asset_instances` AND `filters` to trace a filter's history |

These costs are real but **manageable**. The DB is operational. The duplication is a maintenance / future-velocity tax, not a today-fires-are-burning emergency.

---

## 9. What this document does NOT do

- Does not execute any DROPs
- Does not propose changes that break `cleaning_cycles.filter_id` or `filter_events.filter_id` without a full cutover plan (which lives in `A-01`)
- Does not assume any duplication is "obviously unintentional" — every finding has a rationale section

For destructive cleanups, refer to:
- `tasks/DB-AUDIT-2026-05-25.md` — the general audit
- `tasks/PENDING-FIXES-2026-05-25.md` — the deferred-work tracker (A-01, A-02, M-01, etc.)
- `tasks/UNUSED-TABLES-AUDIT.md` — soft-delete vs hard-delete trade-off with 21 CFR §11 framing

---

## 10. Single-page summary for non-technical readers

The database has two main duplication sources:

1. **The hierarchy is stored in two parallel sets of tables** because a migration started in May was never finished. Filters, blocks, areas, and AHUs all exist in BOTH the old `asset_instances` table AND new typed tables (`filters`, `blocks`, etc.). The old table is still the source of truth; the new tables are dormant. Finishing this migration is a 4–8 week project and is the single biggest cleanup opportunity.

2. **Six separate "history" tables follow the same pattern.** Templates, profiles, equipment groups, etc. each have their own `*_versions` table that snapshots changes for compliance. They could be consolidated into one polymorphic history table, but the current setup works correctly and the consolidation is more aesthetic than functional.

Beyond those two, the duplication is column-level — things like `created_by` appearing in 28 tables (this is normal for an audit-heavy app), and a few specific cases where the same logical data appears in 2–3 places (role permissions, current cycle state). Those have actual drift risks that have caused real bugs (see commit history for the role-permission desync incidents).

**Bottom line**: no immediate catastrophe, but ~3 weeks of consolidation work would meaningfully simplify the schema and remove maintenance hazards. The asset-cutover work is the biggest item by far and needs to be scheduled as a dedicated engagement.

---

*End of duplication review. Written 2026-05-25 in response to operator's "deep duplication audit" request. Companion to `tasks/DB-AUDIT-2026-05-25.md`. All counts from live `digilog_db` at audit time.*
