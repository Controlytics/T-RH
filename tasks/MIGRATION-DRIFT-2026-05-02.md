# Migration Drift Audit — 2026-05-02

**Trigger:** 8.4a flagged "7 unapplied migrations + Phase A schema edits never migrated" as a Phase 8.7 cutover blocker.
**Branch:** `RFID` (worktree: `phase5-verification`).
**Scope:** Prisma schema vs. `apps/api/prisma/migrations/` only — DB state was NOT queried (sandbox blocks `_prisma_migrations` reads). Recommendations assume the team has been running `prisma db push` and applying `apps/api/prisma/sql/invariants.sql` by hand, leaving `_prisma_migrations` empty or stale.

---

## 1. `prisma migrate status` — captured output

```
7 migrations found in prisma/migrations
Following migrations have not yet been applied:
20260225160012_phase_a_data_ingestion_models
20260327133758_sync_schema
20260327141052_audit_fixes
20260328100000_add_equipment_groups
20260403103846_add_admin_requests
20260411000000_sync_drift_phase3
20260411130000_block_change_nullable_org

To apply migrations in development run prisma migrate dev.
```

This means every existing migration is "pending" in `_prisma_migrations` while the live DB clearly has those tables already (the app boots and serves traffic). Conclusion: the DB has been driven by `db push`, not `migrate deploy`. Any remediation has to handle *both* the on-disk migration history being empty *and* the schema-vs-migrations drift below.

## 2. Two distinct kinds of drift

| Kind | Symptom | Cause |
|---|---|---|
| **A. Migration-history-vs-DB drift** | All 7 migrations show as "unapplied" but tables/columns from them exist in the DB | Team uses `db push` for dev iteration; never recorded in `_prisma_migrations` |
| **B. Schema-vs-migrations drift** | Tables and columns exist in `schema.prisma` but in *no* migration file | Same root cause — `db push` skips file generation |

8.7 cutover needs a migration history that produces the current schema from a fresh DB. Both kinds must close.

## 3. Schema-vs-migrations drift inventory (Kind B)

Verified by grep across all 7 migration files. Every item below is in `schema.prisma` but appears in NO migration:

### 3.1 New tables (10)

| Schema model | Backing table | Phase |
|---|---|---|
| `TemplateKind` | `template_kinds` | Step 1 (2026-04-30) |
| `FilterDetails` | `filter_details` | Step 6 (2026-05-01) |
| `FilterCleaningProfile` (re-shape) | `filter_cleaning_profiles` (`lineage_id` UUID + `@@unique([lineageId, version])`) | Phase A.2 (2026-05-01) |
| `FilterProfileVersion` | `filter_profile_versions` | Phase A.3 (2026-05-01) |
| `FilterProfileApplicableTemplate` | `filter_profile_applicable_templates` (replaces JSONB array) | Step 4 (2026-05-02) |
| `EquipmentGroupVersion` | `equipment_group_versions` | Phase A.4 (2026-05-02) |
| `ChecklistProfileVersion` | `checklist_profile_versions` | Phase A.1 (2026-05-01) |

### 3.2 New / changed columns

| Table | Column | Notes |
|---|---|---|
| `filter_cleaning_profiles` | `lineage_id UUID NOT NULL` + drop name-based grouping | Phase A.2 |
| `filter_profiles` | `version INTEGER DEFAULT 1` | Phase A.3 |
| `equipment_groups` | `version INTEGER DEFAULT 1` | Phase A.4 |
| `checklist_profiles` | `version INTEGER DEFAULT 1` | Phase A.1 |
| `cleaning_cycles` | `equipment_group_version_pin INTEGER NULL` | Phase A.4 P1 (2026-05-02) |
| `cleaning_cycles` | `checklist_version_pins JSONB DEFAULT '{}'` | Phase A.1 |
| `cleaning_cycles` | `dryer_readings_submitted BOOLEAN DEFAULT false` | unattributed; not in any migration |
| `filter_profiles` | drop `applicable_templates JSONB` (replaced by join table) | Step 4 |
| `asset_templates` | `template_kind VARCHAR(50) DEFAULT 'OTHER'` + FK to `template_kinds.code` | Step 1 |
| `asset_instances` | drop `filter_profile_id`, `current_lifecycle_state`, `current_cycle_id`, `filter_set` (moved to `filter_details`) | Step 6 |

### 3.3 Multi-tenancy removal (2026-04-30)

The `Organization` table and `organizationId` columns on roughly 11 tables are still referenced by the *migrations* (the model in earlier migrations creates `organizations`, FK columns, etc.) but are **gone from `schema.prisma`**. The schema retains a single comment on line 25 ("Organization — logical grouping under a tenant") above an unrelated model, but no `Organization` model exists. This is the single biggest drift: the migration history would still try to create `organizations` and 11 FK columns that the live schema rejects.

Affected drops (from `tasks/MT-REMOVAL-TOUCHPOINTS.md` and grep against migrations): `organizations`, `organization_id` columns on `users`, `roles`, `asset_templates`, `asset_instances`, `filter_cleaning_profiles`, `filter_profiles`, `checklist_profiles`, `equipment_groups`, `pm_schedules`, `block_change_requests`, `template_assignments`, `entity_assignments`, plus 2 `org_id` columns. JWT `scope` enum trimmed.

### 3.4 Invariants outside Prisma (informational, not drift per se)

`apps/api/prisma/sql/invariants.sql` adds 3 things Prisma cannot express:
- `idx_cleaning_cycles_one_in_progress_per_filter` partial unique index
- `trg_filter_event_consistency` trigger
- `trg_asset_relationship_pair` deferred constraint trigger + `inverse_relationship_type` function

These currently live in a hand-applied SQL file. The remediation should fold them into a migration so a fresh-DB rebuild reproduces them.

## 4. Schema vs. migrations — model count delta

- `schema.prisma` (today): **69 models, 23 enums** (verified via `grep -cE "^model "` / `^enum`)
- Migrations create roughly **52 tables** plus the dropped `organizations`. Discrepancy of ~17 tables matches the inventory in §3.

## 5. Remediation options

### Option 1 — Single coalesced "baseline" migration (recommended)

```
npx prisma migrate dev --create-only --name option-d-baseline
```

Prisma diffs the empty shadow DB against current `schema.prisma` and emits one large migration file. Review the diff before committing, then `prisma migrate resolve --applied` against the live DB to mark history sane.

**Pros:** cleanest; produces a single source of truth that can rebuild a fresh DB; matches the `option-d-baseline` naming hinted by the task; aligns with the Option D plan in `tasks/PLAN-2026-05-02-step8-OPTION-D.md`.

**Risks:**
1. **`FilterCleaningProfile.lineage_id UUID NOT NULL`** — Prisma's auto-diff generates `ADD COLUMN ... NOT NULL` with no default. On a populated DB this aborts. Either (a) apply against an empty/dev DB only, or (b) hand-edit the migration to two-step: `ADD COLUMN lineage_id UUID NULL` → `UPDATE ... SET lineage_id = gen_random_uuid()` → `ALTER COLUMN lineage_id SET NOT NULL`.
2. **Auto-diffs the `organizations` drop alongside 11 FK column drops** — drop ordering matters; review carefully.
3. **The 7 existing `pending` migrations are still in the folder.** Either delete them and replace with the single baseline (loses incremental history), or keep them and append the baseline (then `migrate resolve` all 8 as applied). Cleanest: delete + baseline, since the existing 7 already drift from each other (multi-tenant artifacts in #1 vs. partially-removed in #6).
4. Invariants from §3.4 must be appended manually to the generated SQL — Prisma won't emit triggers.
5. Any `db push`-only column with a non-default name (e.g. `dryer_readings_submitted` history) shows up as expected.

### Option 2 — Reset dev DB and re-run all migrations (destructive locally)

```
npx prisma migrate reset --force          # drop DB
# re-author migrations to match current schema, then:
npx prisma migrate dev --name option-d-baseline
```

**Pros:** verifies migrations actually rebuild the schema; for a single-dev local-Windows-only project (per `CLAUDE.md`: "no live EC2/Linux production"), the "data loss" is local seed data — recoverable by re-running `seed.ts`.
**Risks:** still requires writing the missing migrations (same effort as Option 1); destroys local backups, RFID identifier→filter cache, dev test cycles. Recoverable but annoying.

### Option 3 — Manual squash + create-only with hand-curated SQL

Write the baseline migration `migration.sql` from scratch, hand-curating drops (Organization), additions (sidecars + version columns + pins), and the join-table replacement. Then `migrate resolve --applied`.

**Pros:** maximum control over column-default backfills, drop ordering, and folding invariants.sql into the migration. Catches the `lineage_id NOT NULL` issue cleanly.
**Risks:** most labour; easiest place for a human typo to leak; takes longer to bisect if a fresh `migrate deploy` against a clean DB fails.

## 6. Recommendation

**Option 1 with hand-edits.** Generate the baseline via `--create-only`, then patch:
1. Two-step `lineage_id` add → backfill → `SET NOT NULL`.
2. Drop the 7 superseded migration directories before regenerating.
3. Append `invariants.sql` contents to the bottom of the baseline migration.
4. Smoke-test by `prisma migrate reset` against a *throwaway* DB (e.g. `digilog_db_smoke`) and confirming `migrate deploy` builds clean.

This matches the Option D plan's Phase 8.7 requirement (clean cutover), the task's hinted naming (`option-d-baseline`), and gives 8.7 a defensible production-deploy story.

If field operators have any data on the dev DB worth preserving, run `pg_dump` first — Option 1 still requires `migrate resolve --applied` against the live DB, which doesn't drop data, but the smoke-test step in (4) does.

## 7. Migration filenames that should exist (history-style alternative)

If we ever want incremental history instead of one baseline (e.g. for code-review readability), the missing migrations would be roughly:

| Proposed name | Covers |
|---|---|
| `20260430000000_remove_multi_tenancy` | drop `organizations` + 11 `organization_id` cols + 2 `org_id` cols, trim `RoleScope` enum |
| `20260430010000_step1_add_template_kinds` | new `template_kinds` table + `asset_templates.template_kind` FK |
| `20260501000000_step6_filter_details_split` | new `filter_details` table; drop `asset_instances.filter_profile_id` + `current_lifecycle_state` + `current_cycle_id` + `filter_set` |
| `20260501010000_phase_a1_checklist_versioning` | `checklist_profiles.version`, `checklist_profile_versions` table, `cleaning_cycles.checklist_version_pins JSONB` |
| `20260501020000_phase_a2_cleaning_profile_lineage` | `filter_cleaning_profiles.lineage_id` (with backfill), `@@unique([lineageId, version])`, drop name-based unique |
| `20260501030000_phase_a3_filter_profile_versioning` | `filter_profiles.version`, `filter_profile_versions` sidecar |
| `20260502000000_phase_a4_equipment_group_versioning` | `equipment_groups.version`, `equipment_group_versions` sidecar, `cleaning_cycles.equipment_group_version_pin` |
| `20260502010000_step4_filter_profile_applicable_templates_join` | new `filter_profile_applicable_templates` table; drop `filter_profiles.applicable_templates JSONB` |
| `20260502020000_dryer_readings_submitted` | `cleaning_cycles.dryer_readings_submitted BOOLEAN DEFAULT false` (unattributed; verify origin) |
| `20260502030000_invariants` | partial unique index + `trg_filter_event_consistency` + `trg_asset_relationship_pair` + `inverse_relationship_type` (from `prisma/sql/invariants.sql`) |

10 incremental migrations cover the §3 inventory. Naming convention matches the existing 14-digit-stamp + snake_case pattern.

The recommendation in §6 is still Option 1 (one baseline). The list above is the fallback if reviewers want to see history rather than a snapshot.

## 8. Open questions for the operator

1. **DB state unverified.** Whoever runs the remediation should `SELECT migration_name FROM _prisma_migrations` first to confirm whether the live DB has *any* recorded migration history. The recommendation assumes it's empty/stale (db push); if it isn't, Option 1 needs different `migrate resolve` flags.
2. **`dryer_readings_submitted`** has no plan-document attribution. Worth a 30-second history grep before generating the baseline; if it's a stale column, drop it instead of preserving.
3. **Decision on the 7 existing migration files** — delete (clean) or retain (history). I lean delete; they describe a multi-tenant world that no longer exists.

## 9. Action checklist (do NOT auto-run)

- [ ] Operator: `SELECT * FROM _prisma_migrations;` to confirm the DB state assumption
- [ ] Operator: decide delete-vs-retain for the 7 existing migrations
- [ ] `npx prisma migrate dev --create-only --name option-d-baseline`
- [ ] Hand-edit: `lineage_id` two-step backfill
- [ ] Hand-edit: append `invariants.sql` contents
- [ ] Smoke test against throwaway DB (`createdb digilog_db_smoke && prisma migrate deploy`)
- [ ] `prisma migrate resolve --applied option-d-baseline` against live DB
- [ ] Commit with note referencing this audit + `tasks/PLAN-2026-05-02-step8-OPTION-D.md`
