# Pending Fixes — to ship later

Captured 2026-05-25 at end of an extended session. **19 commits shipped today** (see `git log --since='2026-05-25' --oneline`); the items below are the things we identified as needed but **explicitly did not ship** in this session — either because they're too large for a single sitting, need per-item sign-off, need investigation first, or weren't mine to commit.

Each item includes: **why it's pending** • **what needs to happen** • **estimate** • **reference**.

---

## §1 — Architecture-scale (multi-week, separate engagements)

### A-01 — Complete the `asset_instances` cutover

> **Detailed executable plan drafted 2026-05-27:** `tasks/A-01-ASSET-CUTOVER-PLAN.md` (6 phases, live-measured surface, D1–D5 decision gate, rollback). The summary below stands; the plan supersedes it for execution.

The 2026-05-17 typed-hierarchy migration added `blocks` / `areas` / `ahus` / `filters` sidecar tables but did not migrate the FK references. `cleaning_cycles.filter_id`, `filter_events.filter_id`, `asset_identifiers.asset_id`, `filter_details.asset_instance_id`, and the parent-chain walker all still point at `asset_instances`. **This is the structural blocker for "remove the Asset / Template / Entity concept."**

- **Why pending**: 4–8 weeks of focused work; ~150 query-site cutover; 21 CFR §11 audit-chain re-anchoring; backfill scripts + rollback plan.
- **What needs to happen**:
  1. Migration plan with FK reanchoring sequence
  2. Repository layer rewrite — every `prisma.assetInstance.*` site → `prisma.filter.*` / `prisma.block.*` / etc.
  3. Audit-chain reanchor: `filter_events.filter_id` FK → `filters(id)`
  4. Drop `asset_instances`, `asset_templates`, `asset_template_versions`, `asset_relationships`, `asset_identifiers` (rename to `filter_identifiers`?)
  5. 21 CFR §11 sign-off review before any destructive step
  6. Backfill script + verification harness
  7. Rollback plan
- **Estimate**: 4–8 focused weeks, 1 engineer. Separate engagement.
- **Reference**: `tasks/DB-AUDIT-2026-05-25.md` F-01 / F-03 / §3, `tasks/ENTITY-REMOVAL-IMPACT-ANALYSIS.md`

### A-02 — Repair `_prisma_migrations` table

Prisma's migration history table doesn't exist in this DB. Either it was dropped or migrations were applied via `prisma db push`. **Disaster-recovery requires manual schema repair** because `prisma migrate deploy` against a fresh DB would try to re-apply all 16 migrations and conflict.

- **Why pending**: Manual seed has data-corruption risk; needs DBA sign-off + verified DR backup first.
- **What needs to happen**:
  1. Take a verified backup of `digilog_db`
  2. Manually CREATE the `_prisma_migrations` table per Prisma's schema
  3. INSERT one row per applied migration with the correct `migration_name`, `checksum`, `applied_steps_count`, `finished_at`
  4. Test by running `prisma migrate status` — should report all applied, none pending
  5. Test recovery: restore backup to a scratch DB, run `prisma migrate deploy`, confirm no errors
- **Estimate**: half-day with care.
- **Reference**: `tasks/DB-AUDIT-2026-05-25.md` F-10

---

## §2 — Medium tasks (1–2 days each)

### M-01 — Wave 4: drop the ~20 empty residue tables

Tables identified as empty but ALL have code references (Prisma model definition, type imports, repository methods). Each one needs: grep audit → remove model from `schema.prisma` → remove service / repository methods → remove API routes → migration to DROP TABLE → verify TypeScript compiles → verify tests pass.

Candidates with row counts (all 0 unless noted):
- `dashboards`, `dashboard_widgets`, `dashboard_assignments` (multi-tenancy residue)
- `entity_assignments`, `template_assignments` (MT residue)
- `user_groups` (1 row), `user_group_members` (MT residue)
- `notification_logs`, `notification_rule_recipients`, `notification_templates` (1 seed row)
- `connectivity_status`, `latest_telemetry`, `dead_letter_queue` (ingestion never used)
- `qr_codes`, `data_streams`, `device_credentials`, `uns_mappings` (telemetry never wired)
- `electronic_signatures`, `report_signatures`, `report_instances` (reports never generated)
- `checklist_reviews`, `pm_executions` (user-triggered, may stay)
- `filter_profile_versions`, `filter_profile_applicable_templates` (deprecated override layer)

- **Why pending**: per-table grep + Prisma + code refactor + migration = multi-hour each. Cannot be done as a sweep.
- **What needs to happen**: per-candidate audit using `tasks/DB-AUDIT-2026-05-25.md` §3 grep template; then per-table PR.
- **Estimate**: 1–2 days for the safest ~10 tables.
- **Reference**: `tasks/DB-AUDIT-2026-05-25.md` F-02 / F-25 / Wave 2

### M-02 — Consolidate `ingestion_system_config` into `system_config`

Two separate config tables, 30 + 33 rows. Historical split. Should be one table with a config-type column.

- **Why pending**: Touches the ingestion module config readers; needs a careful merge.
- **Estimate**: 1 day.
- **Reference**: `tasks/DB-AUDIT-2026-05-25.md` F-29

### M-03 — Hash `device_credentials.access_token` at rest

Currently the column stores plaintext + has a UNIQUE index for lookup. Table is empty so no live exposure, but if device-ingest ships, tokens should be `bcrypt` or `argon2` at rest with a separate `token_hash_index` column for the lookup.

- **Why pending**: Feature isn't shipping today; no urgency.
- **Estimate**: half day.
- **Reference**: `tasks/DB-AUDIT-2026-05-25.md` F-11

### M-04 — Patch `fn_mirror_asset_instance` to stop writing dropped columns — ✅ DONE 2026-05-27

> **Resolved** in migration `20260527191316_fix_mirror_asset_instance_drop_dead_filter_cols`. `CREATE OR REPLACE` cleaned only the FILTER branch (dropped the 4 dead column refs from INSERT/VALUES/ON CONFLICT + the unused vars + the filter_details SELECT-INTO); BLOCK/AREA/AHU/DELETE branches unchanged. Applied via psql; verified transactionally (FILTER insert + rename/retire UPDATE + BLOCK insert all mirror correctly, rolled back). See CHANGELOG [Unreleased] 2026-05-27.


Companion to today's `fn_mirror_filter_details` drop (migration `20260525223000_drop_filter_details_mirror_trigger`). After commit `97d298c` dropped `filter_profile_id`, `current_lifecycle_state`, `current_cycle_id`, `filter_set` from the `filters` table, `fn_mirror_asset_instance` still references all four in its `INSERT INTO filters (... filter_profile_id, current_lifecycle_state, current_cycle_id, filter_set ...)` upsert. Latent on the cycle-write path (which doesn't touch `asset_instances`), but breaks every filter create / rename / retire / replace flow + bulk-upload because those write `asset_instances` and trip the trigger.

- **Why pending**: I confirmed during tablet E2E on 2026-05-25 that cycle ops are unblocked by dropping the simpler `fn_mirror_filter_details`. Cannot just drop this one — it also routes new rows into the typed sidecar tables (blocks / areas / ahus / filters) per `template_kind`, which is critical for the Wave 2 typed-hierarchy migration.
- **What needs to happen**: `CREATE OR REPLACE FUNCTION fn_mirror_asset_instance()` removing only the four dead column references from the `filters`-branch INSERT/UPDATE list. Keep blocks / areas / ahus branches untouched. Verify with: create a new FILTER asset_instance via the asset routes, confirm a `filters` sidecar row appears with the expected fields.
- **Estimate**: 1–2 hours including a repro test for filter creation + retirement.
- **Reference**: `apps/api/prisma/migrations/20260525223000_drop_filter_details_mirror_trigger/migration.sql` (companion migration shipped today), commit `97d298c`.

---

## §3 — Small fixes (hours each)

### S-01 — Drop confirmed-unused indexes

After the asset cutover lands, prune the sidecar-table indexes that currently show `idx_scan = 0`. Doing this before the cutover risks slowing post-cutover queries.

- **What**: `audit_trail.session_id_idx` (120 KB) is safe to drop today. The rest wait.
- **Estimate**: 30 min for the audit + DROP.
- **Reference**: `tasks/DB-AUDIT-2026-05-25.md` F-04 / F-27

### S-02 — True compound-endpoint "combined screen" UX

Currently `mobile-operations.tsx` shows the just-submitted readings as a recap inside the checklist dialog (commit `9a7bcdc`). The operator perceives one screen; under the hood it's still two sequential API calls. The "true" version would be a new `/api/filters/:id/advance-with-checklist` endpoint that runs `advance` + `submit-checklist` in one transaction.

- **Why pending**: Touches: server route, audit-trail handling for partial failure, offline replay contract, FE submit flow. Not a single-session change.
- **Estimate**: 1–2 days.
- **Reference**: see commit `9a7bcdc` body for the design notes I wrote.

### S-03 — Address the four pre-existing uncommitted files

These were modified **before today's session** (per the initial git status) and are not my work:
- `apps/api/src/modules/assets/routes/instance.routes.ts`
- `apps/api/src/modules/assets/services/bulk-upload-filter.service.ts`
- `apps/web/src/routes/filter-management/filter-list/dialogs/BulkUploadDialog.tsx`
- `apps/web/src/routes/filter-management/filter-list/dialogs/CreateFilterDialog.tsx`

- **Why pending**: Only the original author knows whether this is WIP, abandoned, or finished. Not mine to commit.
- **What needs to happen**: Decide: revert? commit? finish?
- **Estimate**: 15 min to decide, however long the actual work is.

### S-04 — Tame the 22 dev scripts in the repo root

`.cdp-*.cjs`, `.cs*.json`, `.idents.json`, `.continue-cycle.sh`, `.replace-*.py`, `.cycles-views-new.txt`, `.home-view-new.txt` — all untracked, all clearly per-session debugging artefacts.

- **What**: move into `tasks/dev-scripts/` (gitignored), or delete if no longer needed.
- **Estimate**: 30 min.

---

## §4 — Investigation tasks (the audit findings that turned out to be non-bugs but warrant verification)

### I-01 — Verify notification dispatch end-to-end

Audit thought F-15 was a "dispatch broken" bug because `notification_logs` is empty. Actually it's working — there's just no `notification_rules` configured by an admin (only 1 seed row exists). Trigger a real notification (e.g., have an admin set up an email rule for `BLOCK_CHANGE_REQUESTED`, fire one, check `notification_logs` got a row).

- **Estimate**: 30 min. Verifies the dispatch pipeline + flushes the F-15 audit concern.

### I-02 — Verify PM "isPmDue" path end-to-end

PM is operator-triggered, not cron'd — so `pm_executions = 0` doesn't mean PM is broken. But the `current-state.isPmDue` flag drives the FE's PM-auto-start prompt. Verify: create a PM schedule with `window_start <= NOW() <= window_end`, scan a filter under its asset, confirm `current-state.isPmDue = true`, confirm the mobile flow prompts a PM cycle start.

- **Estimate**: 30 min. Closes F-18.

### I-03 — Verify report generation end-to-end

`report_instances` empty despite 2 templates + 24 versions. Either nobody's clicked "Generate Report" or it's failing silently. Click it, watch the response, see if a `report_instances` row appears + a PDF gets written to `uploads/`.

- **Estimate**: 30 min. Closes F-22.

---

## §5 — Compliance / one-time follow-ups

### C-01 — Rotate operator passwords that hit reauth-gated config pages

The `_currentPassword` security leak (fixed in commit `204316e` today) means any DB backup taken between the day someone first PUT a reauth-gated config and 2026-05-25 contains plaintext passwords in `system_config.config_value`. Anyone with backup-file access can read those passwords.

- **What to do**:
  1. Identify which operators hit a reauth-gated config page before today
  2. Force-rotate their passwords (force_password_change = true on next login)
  3. Audit backup-retention: anything older than 2026-05-25 with `system_config` data should be considered compromised
- **Estimate**: 1 hour.

### C-02 — Write a HARD-DELETE proposal if needed

Operator asked twice today: "remove the data which deleted in application that data should be delete from the dbs also." The audit doc `tasks/UNUSED-TABLES-AUDIT.md` lays out the 21 CFR §11 trade-off. If facility inspection posture allows reduced audit retention, write a per-entity-type hard-delete proposal listing exactly what would be lost (e.g., "deleting a user orphans 1,200 audit_trail rows where they were the actor").

- **Estimate**: 1 day.

---

## §6 — UX items raised this session that ARE shipped vs deferred

**Shipped** (don't re-do):
- Hierarchy canvas with zoom / pan / fullscreen + safe-center scroll fix → `5034cca`
- Conditional Filters table columns based on hierarchy scope → `5034cca`
- DRY_IN time column = temperature-submission time only → `0418cb0`
- Dryer-readings gate before leaving DRY_IN → `63fbc67`
- Justification gate (≥10 chars when required) → `aa46220`
- Default cleaning-profile fallback → `00f9c78`
- Combined-screen UX (readings recap inside checklist dialog) → `9a7bcdc`
- All cleaning messages → toast popups → `3a8af60`
- Stage-scoped checklist gate (no more stuck-cycle hijack) → `d88d8b0`
- Block-change notifications to approval-role + requester → `cd5e018`
- Persistent OFFLINE_REPLAY_SECRET + needs-reauth banner → `af3005b`
- Password expiry derives from live policy + SUPER_ADMIN exempt → `11a74e0`
- Cleaning-profile-assignment duplicate-rule prevention → `8d934d4`
- Terminate-cycle writes `terminated_at` → `93f3f73`
- `_currentPassword` config leak fix → `204316e`
- DB audit report → `fd98633`

**Deferred** (S-02 above — true compound endpoint version of combined-screen).

---

## §7 — Final state at session end

- Branch: `RFID`, 19 new commits 2026-05-25
- API: running (`/api/health` returns 200), latest code loaded
- APK: built 2026-05-25 18:49 — **does NOT include the hierarchy canvas commit `5034cca`** since I never rebuilt after that. **Sideload requires a fresh build.**
- DB: 4 orphan filters deleted, 2 active filters re-parented (68-cycle MUPS preserved), 1 dup CWHH block deleted, 7 historic TERMINATED cycles backfilled, leaked password overwritten, config dedup'd + complete coverage added
- Compliance posture: preserved (no audit-chain breakage)
- Uncommitted: 4 pre-existing files (not mine — listed in S-03), 22 dev scripts (S-04)

---

## §8 — Quick-reference checklist for the next session

If resuming work, this is the suggested order:

1. **First 30 min** — Rebuild the APK so the hierarchy canvas + conditional columns reach the tablet (`vite build && cap copy android && gradlew assembleDebug`)
2. **Next 1 hour** — Run I-01, I-02, I-03 to close out the audit's "never fires" suspicions
3. **Then pick one of**:
   - M-01 Wave 4 (drop empty residue tables) if you want visible schema cleanup
   - A-02 `_prisma_migrations` repair if you're worried about DR
   - C-01 password rotation if you're prepping for an audit
4. **Save A-01 for a multi-week scheduled effort**.

End of pending list.
