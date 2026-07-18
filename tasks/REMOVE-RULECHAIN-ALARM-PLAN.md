# Remove Rule Chains + Alarms — Phased Removal Plan

**Branch:** `RFID` (current)
**Created:** 2026-05-17
**Scope:** Full tear-out + hard delete (per user direction). No history archive.
**Sequencing:** User opted "both in parallel" with the 6 open CRITICAL audit items (acknowledged merge-conflict risk in notification-delivery / super-admin / queries paths).
**Commit cadence:** Single bundle commit at the end (after phase 8 verifies). `pre-rulechain-alarm-drop` tag created in phase 0 is the rollback anchor.

## Scope summary

- 5 Prisma models deleted: `RuleChain`, `RuleChainVersion`, `RuleNode`, `RuleNodeConnection`, `Alarm`
- 3 columns dropped from existing tables:
  - `asset_templates.default_rule_chain_id` (UUID + relation)
  - `asset_templates.alarm_rules` (JSONB)
  - `notification_logs.rule_chain_id` (UUID + index)
  - `notification_logs.alarm_id` (UUID + index)
- ~22 source files in `apps/api/src/modules/rule-chain/` deleted (whole directory)
- ~14 source/route/test files surgically refactored
- ~12 source files in `apps/web/src/routes/rule-chains/` deleted
- ~6 frontend touchpoints (sidebar, route registry, filter-data-management helpers, alarm pages)
- Shared package: 7 permissions, 7 privileges, 5 reauth actions, 2 sidebar items, 2 categories
- Seed: 6 role permission arrays trimmed, 11 alarm field IDs removed, 7 help articles removed
- 1 destructive Prisma migration

## Phase 0 — Branch + baseline + safety tag

1. Stay on `RFID` (this is current trunk per memory). No new worktree; commits are phase-scoped.
2. **Tag the pre-removal state now** for clean reset point:
   ```bash
   git tag pre-rulechain-alarm-drop
   ```
   (If anything goes sideways in phases 1-8, `git reset --hard pre-rulechain-alarm-drop` restores the world.)
3. Record current test baseline:
   ```bash
   cd apps/api && npx vitest run --pool=forks --poolOptions.forks.singleFork=true 2>&1 | tail -20
   ```
   Save the pass/fail counts. Expected: ~1231 pass / 2 known fail / 9 skip per CLAUDE.md.

## Phase 0.5 — DB safety verification (DONE 2026-05-17)

FK check + row counts already run against local DB. Findings:

| Check | Count | Implication |
|-------|-------|-------------|
| FKs from retained tables → alarms/rule_chains | 0 (only `asset_templates.default_rule_chain_id` which we drop in phase 5) | Hash chain stays intact. No cascade hazards. |
| `audit_trail.target_type` = alarm/rule_chain | 0 | No audit rows directly point at these. |
| `audit_trail.action` matches ALARM_*/RULE_CHAIN_* | 0 | No historic emission of these actions. |
| `audit_trail` JSON details with alarm/rulechain UUIDs | 4 | Inert UUID strings; orphan after drop. Accepted per "hard delete" decision. |
| `alarms` / `rule_chains` / `rule_nodes` row counts | 0 / 0 / 0 | DROP TABLE is instant on empty tables. |
| `roles.permissions` containing ALARM_*/RULE_CHAIN_* | 3 | Cleanup SQL in phase 6. |
| `role_configs.sidebar_items` containing alarm/rule-chain | 1 | Cleanup SQL in phase 6. |
| `system_config` rows with config_key starting `alarm` | 1 | Cleanup SQL in phase 6. |
| `notification_rules.event_types` with `RULE_CHAIN_TRIGGERED` | 0 | Nothing to clean. |
| `dashboard_widgets` with widget_type containing `alarm` | 0 | Nothing to clean. |
| `notification_logs.alarm_id` or `.rule_chain_id` set | 0 | Column drop in phase 5 is safe. |
| `asset_templates.default_rule_chain_id IS NOT NULL` | 0 | Column drop safe. |
| `asset_templates.alarm_rules` non-empty | 0 | JSONB column drop safe. |

**Verdict:** All-clear to proceed with hard-delete destructive migration. No 21 CFR hash-chain risk; only 4 historic audit rows hold inert UUIDs in JSON.

## Phase 1 — Frontend tear-out

**Goal:** No more UI surface for rule chains or alarms. Backend still works; routes become dead but reachable.

### Delete (whole files / dirs)
- `apps/web/src/routes/rule-chains/` (entire directory — 12 files: editor/, dialogs/, components/, types.ts, constants.ts, chain-to-flow.ts, index.tsx)
- `apps/web/src/routes/alarms/index.tsx`
- `apps/web/src/routes/config/alarm-columns.tsx`

### Refactor
- `apps/web/src/main.tsx`
  - Remove imports: `AlarmColumnsConfigPage`, `AlarmDashboardPage` (lazy), any rule-chain page imports
  - Remove `<Route>` entries: `/alarms`, `/config/alarm-columns`, `/rule-chains`, `/rule-chains/editor` (and any nested rule-chain routes)
- `apps/web/src/components/layout/sidebar.tsx`
  - Remove the alarms sidebar item (id `alarms`)
  - Remove the rule-chains sidebar item if present in this nav file
- `apps/web/src/routes/config/filter-data-management.tsx`
  - Delete helpers (~lines 46-90): `ALARM_SEVERITY_COLORS`, `ALARM_SEVERITY_DOT`, `ALARM_STATUS_COLORS`, `ALARM_STATUS_LABELS`, `getAlarmHighLimit`, `getAlarmLowLimit`, `extractAlarmValue`, `getAlarmGeneratedValue`, `getAlarmClearedValue`
  - Remove the alarms tab / panel if rendered
- `apps/web/src/routes/config/index.tsx` (config card grid)
  - Remove the alarm-columns config card
- Any other frontend file that imports from `routes/alarms` or `routes/rule-chains` — search and clear

### Build state expected
- `npx vite build` should succeed once dead imports are gone
- Backend untouched; APIs `GET /api/alarms`, `GET /api/rule-chains` still return data

### Commit message
`refactor(web): remove rule-chain + alarm UI pages (phase 1/8 of tear-out)`

### Rollback
`git revert <commit>` — backend unaffected.

---

## Phase 2 — Shared package surgery

**Goal:** Permissions, privileges, reauth actions, sidebar items, FEATURE_TO_PERMISSION_MAP all cleared. Audit-actions and audit-templates explicitly retained.

### Files to edit
- `packages/shared/src/types/permissions.ts`
  - Remove (lines ~54-62): `RULE_CHAIN_VIEW`, `RULE_CHAIN_CREATE`, `RULE_CHAIN_UPDATE`, `RULE_CHAIN_DELETE`, `ALARM_VIEW`, `ALARM_ACKNOWLEDGE`, `ALARM_CLEAR`
- `packages/shared/src/types/permission-categories.ts`
  - Remove the `ALARM_*` entries (~lines 60-62) and any `RULE_CHAIN_*` entries
- `packages/shared/src/types/feature-privileges.ts`
  - Remove privilege entries: `rulechains.view/create/edit/delete` (~lines 55-58), `alarms.view/acknowledge/clear` (~lines 60-63)
  - Remove FEATURE_TO_PERMISSION_MAP entries (~lines 228-237) for both sets
- `packages/shared/src/types/reauth-actions.ts`
  - Remove `ACKNOWLEDGE_ALARM`, `CLEAR_ALARM`, `CREATE_RULE_CHAIN`, `UPDATE_RULE_CHAIN`, `DELETE_RULE_CHAIN`
  - Remove `'Alarms'` and `'Rule Chain'` from `REAUTH_ACTION_CATEGORIES`
- `packages/shared/src/types/sidebar-items.ts`
  - Remove `{ id: 'rule-chains' ... }` and `{ id: 'alarms' ... }`
- `packages/shared/src/types/sidebar-privilege-map.ts`
  - Remove the two entries for `rule-chains` and `alarms` (~lines 66-78)

### Files to LEAVE ALONE (intentional)
- `packages/shared/src/types/audit-actions.ts`
  - KEEP: `RULE_CHAIN_CREATED/UPDATED/DELETED/SET_ROOT/IMPORTED`, `ALARM_CREATED/ACKNOWLEDGED/CLEARED/ESCALATED`
  - These are 21 CFR Part 11 inspector contracts per memory `reference_audit_trail_keep_unemitted_actions.md`. They become unemitted but stay in the registry. Add an inline `// retained per 21 CFR §11 — no longer emitted as of 2026-05-17` next to them.
- `packages/shared/src/types/audit-templates.ts`
  - KEEP the alarm and rule-chain entries (templates for historical audit rows).

### Build state expected
- `npx nx build shared` succeeds
- API will fail to compile (still references `PERMISSIONS.ALARM_VIEW` etc.) — that's phase 3+4's job

### Commit message
`refactor(shared): remove rule-chain + alarm permissions/privileges/reauth/sidebar (phase 2/8)`

### Rollback
Revert commit, rebuild shared.

---

## Phase 3 — Backend route + module deletion

**Goal:** Remove the route surface entirely. The modules go away. The compiler will scream about cross-module refs — phase 4 fixes those.

### Delete (whole dirs / files)
- `apps/api/src/modules/rule-chain/` (entire directory — engine, nodes, types, routes, default-chain-builder, debug-recorder, tests)
- `apps/api/src/modules/queries/alarm.routes.ts`
- `apps/api/src/modules/config/static-routes/alarm-columns.routes.ts`
- `apps/api/src/modules/config/defs/alarm-columns.def.ts`
- `packages/shared/src/types/alarm-columns.ts`
- `apps/api/src/e2e/rule-chains.test.ts` (if present)

### Refactor registrations
- `apps/api/src/app.ts`
  - Remove imports: `ruleChainRoutes`, `initializeNodes` (~lines 33, 45)
  - Remove `app.register(ruleChainRoutes, { prefix: '/api/rule-chains' })` (~line 275)
  - Remove `initializeNodes()` call (~line 303)
- `apps/api/src/modules/queries/index.ts`
  - Remove `alarmRoutes` import (line 7) and registration (line 13)
- `apps/api/src/modules/queries/export.routes.ts`
  - Remove `app.get('/alarms', ...)` handler (~line 250)
- `apps/api/src/modules/config/routes.ts`
  - Remove `alarmColumnsRoutes` import (line 19) and `await alarmColumnsRoutes(app)` (line 43)
- `apps/api/src/modules/config/config.service.ts`
  - Remove `getAlarmColumns()`, `updateAlarmColumns()`, `getMyAlarmColumns()` methods (~lines 300-330)
- `apps/api/src/modules/super-admin/routes.ts`
  - Remove `GET /data/alarms`, `PUT /data/alarms/:id`, `DELETE /data/alarms/:id` (~lines 373-395)
- `apps/api/src/modules/dashboards/routes.ts`
  - Remove `'alarm_table'` from widget enum (~line 234)
  - Remove the `case 'alarm_table': ...` branch (~lines 474-484)
  - Remove the widget registry entry (~line 511)

### Build state expected
- `tsc -p apps/api/tsconfig.json` will FAIL due to:
  - `executeRuleChain` import in ingestion.service.ts (phase 4 fixes)
  - `AlarmAction` type refs in ingestion.repository.ts (phase 4 fixes)
  - `RULE_CHAIN_TRIGGERED` event type in notification-dispatcher.ts (phase 4 fixes)
  - etc.

### Commit message
`refactor(api): delete rule-chain + alarm route modules (phase 3/8)`

### Rollback
Revert. API can't start until phase 4 lands if this is in.

---

## Phase 4 — Cross-module ref cleanup

**Goal:** API compiles clean. Every cross-module reference to rule-chain / alarm symbols is excised.

### Data ingestion pipeline
- `apps/api/src/modules/data-ingestion/ingestion.service.ts`
  - Remove imports of `executeRuleChain` and `AlarmAction`/`NotificationAction` types from rule-chain
  - Delete Stage 7 (Rule Chain Resolution & Execution, ~lines 246-328)
  - Delete Stage 8 (Rule Chain Output Processing, ~lines 330-430)
  - Remove `evaluateTemplateAlarmRules()` function and its call site
  - In whatever stages remain that referenced `msg.ruleChainId` / `ruleChainAlarms` / `ruleChainNotifications`, drop those branches
- `apps/api/src/modules/data-ingestion/ingestion.repository.ts`
  - Delete `createAlarm()` function entirely (~lines 202-252)
  - Remove `ruleChainId` from function param interfaces and notification var building
- `apps/api/src/modules/data-ingestion/entity-resolver.ts`
  - Remove `ruleChainId: string | null` from `ResolvedEntity`
  - Remove `ruleChainId: entity.template.defaultRuleChainId` from resolved object
- `apps/api/src/modules/data-ingestion/message-normalizer.ts`
  - Remove `ruleChainId: string` from `IngestionMessage`
  - Remove `ruleChainId?: string | null` from `normalizeMessage` param
  - Remove assignments at ~lines 122, 157
- `apps/api/src/modules/data-ingestion/routes.ts`
  - Remove `ruleChainId: string | null` from fastify device property
  - Remove `ruleChainId` from `enqueueMessage` normalization (~line 68) and inline normalization (~line 93)
- `apps/api/src/modules/data-ingestion/dlq-manager.ts`
  - Delete the DLQ-overflow alarm creation try/catch (~lines 94-116)
  - Update header comment to remove "creates CRITICAL alarm" claim

### MQTT transport
- `apps/api/src/transport/mqtt-handler.ts`
  - Remove `ruleChainId: entity.template.defaultRuleChainId` from telemetry message object (~line 201)
  - Remove same from connectivity event message (~line 280)

### Notification delivery
- `apps/api/src/modules/notification-delivery/notification-dispatcher.ts`
  - Remove `RULE_CHAIN_TRIGGERED` from `EVENT_LABELS`, `EVENT_FIELDS`, email templates, `SMS_TEMPLATES` (~lines 32, 46, 388-391, 461)
- `apps/api/src/modules/notification-delivery/types.ts`
  - Remove `ruleChainId?: string` from `NotificationPayload` (~line 74)
- `apps/api/src/modules/notification-delivery/delivery.service.ts`
  - Remove `ruleChainId: payload.ruleChainId` from template variables (~line 48)
- `apps/api/src/modules/notification-delivery/template-engine.ts`
  - Delete `buildAlarmVariables()` (~lines 37-48)
- `apps/api/src/modules/notification-rules/routes.ts`
  - Remove `RULE_CHAIN_TRIGGERED` from `EVENT_TYPE_META` (~line 21)

### Assets
- `apps/api/src/modules/assets/routes/template.routes.ts`
  - Remove `defaultRuleChainId` from GET /templates response schema (~line 57)
  - Remove `alarmRules` from response schema if present
- `apps/api/src/modules/assets/repositories/template.repository.ts`
  - Remove `defaultRuleChainId` from create params (~line 59) and Prisma create (~line 85)
  - Remove `alarmRules` if explicitly listed
- `apps/api/src/modules/assets/services/template.service.ts`
  - Remove `defaultRuleChainId` from create call (~line 84), version snapshot (~line 111), updateable fields loop (~line 158), update snapshot (~line 190)
  - Remove `alarmRules` from same

### Roles + permissions
- `apps/api/src/modules/roles/role.service.ts`
  - Remove the RULE_CHAIN_* permission metadata block (~lines 79-82)
  - Remove ALARM_* permission metadata block

### Sync service
- `apps/api/src/modules/sync/sync.service.ts`
  - Audit for alarm ack/clear sync — if there's an `acknowledgeAlarm` / `clearAlarm` offline-replay path, remove it
- `apps/api/src/modules/sync/__tests__/sync.service.test.ts`
  - Remove related test fixtures

### Workers
- `apps/api/src/workers/notification.worker.ts`
  - Remove `rule_chain_notification` task type comments / handlers (~lines 19, 41)
- `apps/api/src/workers/__tests__/ingestion.worker.test.ts`
  - Remove `ruleChainId` from mock data

### Misc
- `apps/api/src/lib/config-discovery.ts` — confirm no `alarm-columns.def.ts` import
- `apps/api/src/modules/deployment-check/routes.ts` — remove any rule-chain schema-health check (~line 100+)
- `apps/api/src/modules/uns/uns-path-builder.ts` — audit for alarm refs

### Tests to repair (refactor mocks, don't delete)
- `apps/api/src/modules/data-ingestion/__tests__/ingestion.service.test.ts`
- `apps/api/src/modules/data-ingestion/__tests__/ingestion.repository.test.ts`
- `apps/api/src/modules/data-ingestion/__tests__/entity-resolver.test.ts`
- `apps/api/src/modules/data-ingestion/__tests__/dlq-manager.test.ts`
- `apps/api/src/modules/data-ingestion/__tests__/enqueue-notification.test.ts`
- `apps/api/src/modules/data-ingestion/__tests__/checklist-answers.test.ts`

For each: strip `ruleChainId` from fixtures, delete alarm-related assertions, delete `mockPrisma.alarm.create.mockResolvedValue(...)` setups.

### Build state expected
- `tsc -p apps/api/tsconfig.json` clean
- `vitest run --pool=forks --poolOptions.forks.singleFork=true` should be ≥1200 pass, no NEW failures vs baseline (some skipped tests acceptable)

### Commit message
`refactor(api): excise rule-chain + alarm refs from ingestion/notification/assets/sync (phase 4/8)`

### Rollback
Revert commits — but at this point the API depends on phase 1-4 being a coherent set. Easier to roll forward.

---

## Phase 5 — Prisma schema + destructive migration

**Goal:** Drop tables and columns from the database. Schema reflects code reality.

### Schema edits — `apps/api/prisma/schema.prisma`
1. Delete `model Alarm` (lines 720-754)
2. Delete `model RuleNode` (lines 683-701)
3. Delete `model RuleNodeConnection` (lines 704-717)
4. Delete `model RuleChainVersion` (lines 666-680)
5. Delete `model RuleChain` (lines 642-663)
6. On `model AssetTemplate`:
   - Delete `defaultRuleChainId` field (line 450)
   - Delete `defaultRuleChain` relation (line 455)
   - Delete `alarmRules` field (line 433)
7. On `model NotificationLog`:
   - Delete `ruleChainId` field (line 1001)
   - Delete `alarmId` field (line 1002)
   - Delete `@@index([ruleChainId])` (line 1011)
   - Delete `@@index([alarmId])` (line 1012)
   - Update the `triggeredBy` comment to drop "rule-chain, alarm" terms

### Migration — create `apps/api/prisma/migrations/<ts>_remove_rule_chain_and_alarms/migration.sql`

```sql
-- Destructive removal of rule-chain + alarm subsystems.
-- User accepted hard-delete (no archive) on 2026-05-17.

-- 1. Drop foreign keys first (CASCADE handles them, but explicit for clarity)
ALTER TABLE "asset_templates" DROP CONSTRAINT IF EXISTS "asset_templates_default_rule_chain_id_fkey";

-- 2. Drop columns on retained tables
ALTER TABLE "asset_templates" DROP COLUMN IF EXISTS "default_rule_chain_id";
ALTER TABLE "asset_templates" DROP COLUMN IF EXISTS "alarm_rules";

DROP INDEX IF EXISTS "notification_logs_rule_chain_id_idx";
DROP INDEX IF EXISTS "notification_logs_alarm_id_idx";
ALTER TABLE "notification_logs" DROP COLUMN IF EXISTS "rule_chain_id";
ALTER TABLE "notification_logs" DROP COLUMN IF EXISTS "alarm_id";

-- 3. Drop tables in FK-dependency order (children first)
DROP TABLE IF EXISTS "rule_node_connections" CASCADE;
DROP TABLE IF EXISTS "rule_nodes" CASCADE;
DROP TABLE IF EXISTS "rule_chain_versions" CASCADE;
DROP TABLE IF EXISTS "alarms" CASCADE;
DROP TABLE IF EXISTS "rule_chains" CASCADE;
```

### Apply migration locally
```bash
cd apps/api && npx prisma migrate dev --name remove_rule_chain_and_alarms
```

If it complains about drift (because rows exist for alarms / rule chains in local dev DB), run with `--create-only` first, inspect, then `npx prisma migrate dev`.

### Regenerate Prisma client
```bash
npx prisma generate
```

### Build state expected
- `tsc -p apps/api/tsconfig.json` still clean (Prisma client lost `Alarm`, `RuleChain` types — but phase 4 removed all callers, so we're safe)
- Test suite clean

### Commit message
`refactor(db): drop rule-chain + alarm tables + asset_templates/notification_logs columns (phase 5/8)`

### Rollback
Hard — would need to write a re-create migration from the original schema. Possible (we have the old schema in git history) but tedious. Tag the commit before this phase: `git tag pre-rulechain-alarm-drop` for clean reset point.

---

## Phase 6 — Seed source cleanup + stale runtime row cleanup

**Goal:** Fresh `npm run seed` produces no rule-chain / alarm artifacts. Existing dev DB rows that hold stale `'ALARM_VIEW'`, `'rule-chains'` sidebar item, or `alarm-columns` config also cleansed.

### A. Source edits — `apps/api/prisma/seed.ts`
- Remove from role permission arrays:
  - SUPER_ADMIN (~lines 58-59): `RULE_CHAIN_*` and `ALARM_*` strings
  - ADMIN (~lines 95-96): same
  - SUPERVISOR (~line 124): `ALARM_*`
  - MAINTENANCE (~line 145): `ALARM_VIEW`, `ALARM_ACKNOWLEDGE`
  - OPERATOR (~line 165): `ALARM_VIEW`
  - VIEWER (~line 184): `ALARM_VIEW`
- Remove 11 alarm field ID rows (~lines 357-368)
- Remove `pipeline.dlq_alarm_threshold` config row (~line 469) OR rename to drop "alarm" wording if that knob is still meaningful
- Remove 7 help articles: 5 rule-chain entries (~lines 547-550) + 2 alarm entries (~lines 566-567)

### B. Runtime row cleanup SQL (run AFTER source edits, BEFORE re-seed)

Per phase 0.5 counts, the local DB has 3 stale `roles` rows + 1 `role_configs` row + 1 `system_config` row. Production-equivalent installs will be similar.

```sql
-- 1. Strip ALARM_*/RULE_CHAIN_* from roles.permissions JSONB arrays
UPDATE roles
SET permissions = (
  SELECT jsonb_agg(p)
  FROM jsonb_array_elements_text(permissions) p
  WHERE p::text !~ '^"(ALARM_|RULE_CHAIN_)'
)
WHERE permissions::text ~* 'ALARM_|RULE_CHAIN_';

-- 2. Strip alarm + rule-chain sidebar items from role_configs
UPDATE role_configs
SET sidebar_items = (
  SELECT jsonb_agg(s)
  FROM jsonb_array_elements_text(sidebar_items) s
  WHERE s::text !~ '^"(alarms|rule-chains)"$'
)
WHERE sidebar_items::text ~* 'alarms|rule-chains';

-- 3. Delete the orphaned alarm-columns config row
DELETE FROM system_config WHERE config_key ILIKE 'alarm%' OR config_key ILIKE '%.alarm%';

-- 4. (Optional, audit registry retained) Leave audit_trail rows alone.
--    The 4 rows with inert UUID strings in details JSON stay — they are 21 CFR evidence
--    of historic actions, and the user has explicitly accepted that the UUIDs become
--    orphan after drop.
```

Save this SQL as `scripts/remove-rulechain-alarm-runtime-cleanup.sql` and run via:
```bash
"$env:PGPASSWORD = 'digilog123'; psql -U digilog -d digilog_db -f scripts/remove-rulechain-alarm-runtime-cleanup.sql"
```

### C. Verify
```bash
cd apps/api && npx tsx prisma/seed.ts
psql -U digilog -d digilog_db -At -c "SELECT name FROM roles WHERE permissions::text ~* 'ALARM_|RULE_CHAIN_';"  # expect: empty
psql -U digilog -d digilog_db -At -c "SELECT role FROM role_configs WHERE sidebar_items::text ~* 'alarms|rule-chains';"  # expect: empty
psql -U digilog -d digilog_db -At -c "SELECT config_key FROM system_config WHERE config_key ILIKE 'alarm%';"  # expect: empty
```

### Note on `notification_logs.triggeredBy` text column
Existing rows literally store `'alarm'` or `'rule-chain'` as the triggered-by source. These remain as inert strings after the FK columns are dropped (column type is `VARCHAR`, not enum). No decode logic breaks. Plan intentionally leaves them — they're historical evidence.

### Commit message
`refactor(seed,db): remove rule-chain + alarm seed data + cleanse stale runtime rows (phase 6/8)`

---

## Phase 7 — Rebuild + verification harness

**Goal:** Everything green end-to-end.

```bash
# Shared
npx nx build shared && npx nx build db && npx nx build queue

# API tsc
cd apps/api && npx tsc --noEmit

# API tests (single-fork per CLAUDE.md)
cd apps/api && npx vitest run --pool=forks --poolOptions.forks.singleFork=true 2>&1 | tail -20
# Expect: ≥1200 pass, NO new failures vs baseline

# Web tsc
cd apps/web && npx tsc --noEmit

# Web build
cd apps/web && npx vite build

# APK rebuild (per reference_apk_build_paths.md)
cd apps/android && npx cap copy android && cd android && ./gradlew assembleDebug
# Then copy the new APK out to repo root for distribution:
# cp apps/android/android/app/build/outputs/apk/debug/app-debug.apk DigiLog-FilterOps.apk
# Verify the new APK doesn't ship dead alarm/rule-chain references in its JS bundle:
# (the vite build above already eliminates them, the cap copy mirrors that into the assets/)

# API smoke
cd apps/api && npx tsx watch src/app.ts
# In another shell:
curl -sk https://localhost:3000/api/alarms -H "Authorization: Bearer $TOKEN"
# Expect 404 (route gone)
curl -sk https://localhost:3000/api/rule-chains -H "Authorization: Bearer $TOKEN"
# Expect 404

# Web smoke
cd apps/web && npx vite --host
# Open http://localhost:5175, log in as superadmin / Admin@123
# Confirm sidebar has no "Alarms" / "Rule Chains" items
# Confirm /alarms, /rule-chains, /config/alarm-columns all render 404 in router
```

### Commit message
`chore: rebuild shared + verify clean tsc/tests after rule-chain+alarm removal (phase 7/8)`

---

## Phase 8 — Documentation + memory updates

**Goal:** Docs and memory reflect new reality. No stale stats.

### CLAUDE.md (root)
- "System Stats" section:
  - Database: 69 models → **64 models** (drop 5)
  - Modules: 37 → **35** (rule-chain deleted; queries module shrinks but file count unchanged for the module dir)
  - Permissions: 107 → **100** (–4 rule-chain –3 alarm)
  - Privileges: 90 → **83** (–4 rule-chain –3 alarm)
  - Reauth: 96 → **91** (–3 rule-chain –2 alarm)
  - Sidebar items: 26 → **24** (–2)
  - Config defs: 30 → **29** (drop alarm-columns)
  - Config pages: 27 → **26**
  - Rule chain line ("77 node types across 8 categories") → **deleted**
- "Pipeline Flow" section: confirm it only describes cleaning-cycle stages, not rule-chain nodes. The two are independent; the existing wording is fine but reread.
- "Key API Endpoints" section: drop any alarm/rule-chain endpoints (none listed today, but verify).

### apps/api/CLAUDE.md
- "36 API Modules" → 35; drop `rule-chain` from the comma list
- "Prisma schema" annotation: add a line under "Step X" series for 2026-05-17 alarm+rulechain drop
- "Phase 2" pipeline flow section: confirm no references to RuleChain

### packages/shared/CLAUDE.md
- Permission / reauth / sidebar counts updated
- Audit-actions kept note unchanged

### CHANGELOG.md
- New top entry: `2026-05-17 — Removed rule-chain + alarm subsystems (5 models, ~34 files, schema migration). 21 CFR audit-action registry retained as unemitted contracts.`

### tasks/todo.md
- New entry: "Rule-chain + alarm removal" with this plan file as reference and links to the 8 commits

### Memory updates
- New memory: `project_rulechain_alarm_removal_2026_05_17.md` — what was removed, what was retained (audit registry), commit range, build verification result
- Update `feedback_remove_entity_concept_recurring.md` — note that rule-chain + alarm removal WAS successful (unlike the AssetInstance/AssetTemplate ask which remains structurally infeasible)

### Commit message
`docs: update counts + changelog + memory for rule-chain+alarm removal (phase 8/8)`

---

## Phase summary

| Phase | Scope | Risk | Build state after |
|-------|-------|------|------------------|
| 0 | Baseline tests | none | unchanged |
| 1 | Frontend deletion | low | API works, no UI |
| 2 | Shared package | low | API won't compile |
| 3 | Backend route deletion | medium | API won't compile (worse) |
| 4 | Cross-module cleanup | high | API compiles clean |
| 5 | Schema + migration | high (destructive DB) | tests clean |
| 6 | Seed cleanup | low | fresh DB clean |
| 7 | Full rebuild + verify | low | green |
| 8 | Docs + memory | low | green |

## Risk callouts

1. **Migration is destructive.** Tag `pre-rulechain-alarm-drop` created in phase 0 — `git reset --hard pre-rulechain-alarm-drop` restores the world if any phase blows up. Local DB rows are throwaway (dev only — no prod per CLAUDE.md), but the safety tag covers all 8 phases.
2. **Audit registry retention** is a regulatory choice, not an oversight. Removing those entries later requires explicit user sign-off per memory.
3. **Notification rules in DB** that reference event type `RULE_CHAIN_TRIGGERED` become orphan rows after phase 4. Decide whether to also delete them in phase 6 seed-cleanup or leave as inert.
4. **Test count baseline** must match between phase 0 and phase 7. Any new failures = phase 4 missed a ref.
5. **The user has 6 open CRITICAL audit items** in `tasks/STRICT-AUDIT-2026-05-16.md`. This refactor lands BEFORE attempting those (otherwise their commits get tangled). Confirm before starting phase 1.
