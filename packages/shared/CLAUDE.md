# DigiLog Shared — CLAUDE.md

## Overview
Shared TypeScript types, Zod schemas, and constants used by both API and Web apps.

## Build
```bash
npm run build -w @digilog/shared
# or: cd packages/shared && npx tsc
```

**Important:** After any changes to the shared package, rebuild it before testing API or Web:
```bash
npm run build -w @digilog/shared
```

## Key Exports
- `schemas/` — Zod validation schemas (login, user, config, etc.)
- `types/` — TypeScript interfaces, enums, and constants (**29 files**, re-derived `ls packages/shared/src/types/*.ts | grep -v test | wc -l` 2026-09-16 — 28 → 29 that day: `attribute-labels.ts` (`coerceAttributeLabels`, the ONE reader of the `attribute-labels` config row, and `attributeLabel`, the ONE lookup: blank falls back to the KEY, lookup folds case; 11 unit tests, mutation-checked). **The 26 recorded next was already stale by two** — `report-approvers.ts` and one other landed without this line moving; re-derive. Earlier **26 files**, re-derived 2026-09-01 — 25 → 26 that day: `trend-widgets.ts`, the administered wording and per-widget date/time formats for the instrument trend page (the shipped defaults, the blank-falls-back resolver, the format vocabulary lifted from `datetime.def.ts`, and `TREND_WIDGET_FIELDS`, the ONE widget → fields mapping that both the config def's settings and the edit dialog are built from). **The 21 recorded below was stale by four before that** — re-derive, never trust this line. Earlier claimed **21 files**, verified `ls packages/shared/src/types/*.ts | grep -v test | wc -l` 2026-08-31 — `inactivity-alarms.ts` added that day (the inactivity-alarm defaults, snapshot shape and the ONE wording for "quiet > 15m", shared because the API freezes those numbers onto the alarm and the browser renders them back). **The 18 recorded below was already stale by two before that** — `dashboard-layout.ts`, `panel-style.ts` and `telemetry-period.ts` landed without this line being re-synced; that shortfall is corrected here, not caused here. Earlier **18 files**, verified `ls packages/shared/src/types/*.ts | grep -v test | wc -l` 2026-08-28 — 2026-08-28 added `panels.ts`, the ONE catalogue of assignable dashboard/trend panels plus its resolver; it replaced an `ALL_CARDS` array in the web config page and a `VALID_CARD_KEYS` set in an API route that carried a "keep in sync" comment. Its key order is frozen by test because the keys are stored in `role_configs`/`user_configs`. Earlier **17 files**, verified `ls packages/shared/src/types/*.ts | grep -v test | wc -l` 2026-08-27 — 2026-08-27 added `telemetry-downsample.ts` (`lttb()`, Largest-Triangle-Three-Buckets: it SELECTS a subset of the readings it is given and never computes a new one, which is why the trend page can plot a 30-day range without inventing a value; its tests assert reference equality with `toBe`, so a refactor that builds new objects fails). 2026-08-27 also added `alarm-webhook.ts`, which this line was never re-synced for — the "15" was stale by two before this correction. Earlier, 2026-08-19 added `telemetry-decimals.ts` (per-instrument display precision, and which attribute keys hold a temperature or a humidity) and `attribute-access.ts` (per-role instrument-attribute editability + the mandatory-remark validator); both are shared because BOTH sides decide with them and a second implementation would show an affordance the API refuses. Earlier: `alarm-limits.ts` added 2026-08-17 for the instrument-limit alarm work; the "11 files" recorded here was already stale before that, and the real count was 12 when that plan started. See Live Type Inventory below)
- `index.ts` — Barrel export

## Usage
```typescript
import { PERMISSIONS, loginSchema, createUserSchema } from '@digilog/shared';
```

## Exports Inventory

### Permissions
- `PERMISSIONS` enum — **44** permission constants (42 → 44 on 2026-09-07, `REPORT_REVIEW_READ` / `REPORT_REVIEW_APPROVE`; earlier verified `grep -cE "^\s+[A-Z_]+:\s*'"
  packages/shared/src/types/permissions.ts` 2026-08-24; see Live Type Inventory below). The examples
  this line used to give — `ASSET_CREATE`, `ASSET_READ`, `FILTER_MANAGE` — don't exist any more
  (asset/filter domain removed); current examples: `USER_CREATE`, `USER_READ`, `USER_UPDATE`.
- Used by both backend `requirePermission()` and frontend `<RequireRole permissions={[]}>`

### Schemas
- `loginSchema` — Login form validation
- `createUserSchema` — User creation validation
- `updateUserSchema` — User update validation
- `passwordPolicySchema` — Password policy config validation
- `loginSecuritySchema` — Login security config validation
- `sessionConfigSchema` — Session config validation
- `datetimeConfigSchema` — Date/time format validation

### Types
- Role hierarchy types
- Notification event types
- Config key types
- ~~Alarm column definitions~~ / ~~Relationship type mappings (INVERSE_RELATIONSHIP_MAP)~~ — **gone**;
  see Constants note below

### Constants
- ~~`ALARM_COLUMN_DEFINITIONS`~~ / ~~`INVERSE_RELATIONSHIP_MAP`~~ — **neither exists** (verified
  `grep -rn "ALARM_COLUMN_DEFINITIONS\|INVERSE_RELATIONSHIP_MAP" packages/shared/src/` 2026-08-24: no
  matches). The alarm-columns config page was removed 2026-05-17 with the rule-chain/alarm tear-out;
  `INVERSE_RELATIONSHIP_MAP` was entity/relationship-domain, removed 2026-07-18.
- Default audit text templates

## Live Type Inventory

> **The per-file counts in the table below are inherited from upstream DigiLog and were
> NEVER true in this fork.** Verified by `grep` 2026-08-27, the real numbers are
> **44** permission constants, **45** feature privileges, **50** reauth actions in
> **8** categories, **102** audit actions, **96** audit templates in **7**
> categories, **15** sidebar items, **14** PERMISSION_TREE groups, **57** tree
> nodes.
> 2026-09-08 (Settings page): sidebar items 14 → 15 (`settings`), tree groups
> 13 → 14 and nodes 55 → 57 (`settings.view` on INSTRUMENT_READ, `settings.edit`
> on INSTRUMENT_UPDATE — no new permission), feature privileges 43 → 45. The
> frozen `legacy-maps-snapshot.ts` was extended by appending again; the tree
> group sits AFTER `reports` because the derived sidebar map is order-sensitive
> against the snapshot and `SIDEBAR_ITEMS`.
> 2026-09-07 (report review workflow): permissions 42 → 44 (`REPORT_REVIEW_READ`,
> `REPORT_REVIEW_APPROVE`), reauth 48 → 50 (`APPROVE_REPORT`, `REJECT_REPORT` in
> the existing `Reports` category), audit actions 98 → 102 and templates 92 → 96
> (`REPORT_REVIEW_REQUESTED` / `APPROVED` / `REJECTED`, `REPORT_DOWNLOADED`,
> generic placeholders only), sidebar items 13 → 14 (`reports`), tree groups
> 12 → 13 and nodes 53 → 55 (`reports.view`, `reports.approve`), feature
> privileges 41 → 43. The frozen `legacy-maps-snapshot.ts` was extended by
> appending again.
> 2026-09-07 (Data Report page): sidebar items 12 → 13 (`data-report`), tree
> groups 11 → 12 and nodes 52 → 53 (`data_report.view`, configurable, gated on
> the EXISTING `INSTRUMENT_READ`), feature privileges 40 → 41. The frozen
> `legacy-maps-snapshot.ts` was extended by APPENDING the node / section, so
> the order-sensitive parity tests keep pinning everything before it. Also:
> `dashboard_history` LEFT the `PANELS` catalogue (its frozen-order test was
> re-pinned) and `DEFAULT_DASHBOARD_LAYOUT` closed up — 0 stored layouts named
> it.
> 2026-08-27 (alarm webhook annunciator): reauth 47 → 48 (`MANAGE_ALARM_WEBHOOK`,
> in the EXISTING `Configuration` category — categories stay at 8), audit actions
> 93 → 97 and templates 87 → 91 (create / update / delete / test a target,
> `Configuration` category), feature privileges 38 → 40 and tree nodes 50 → 52.
> **No permission and no sidebar item was added** — the surface reuses
> `ALARM_RULE_READ` / `ALARM_RULE_MANAGE` and lives under Config.
> Earlier, 2026-08-24: reauth 46 → 47, categories 7 → 8 (`DOWNLOAD_REPORT` under a
> new `Reports` category, to govern report/audit-export downloads).
> The prose in
> each row is still useful as *history* — which change removed what, and why — so it is
> kept rather than rewritten; read the numbers from the greps in the root `CLAUDE.md`
> "Live-count verification" block, never from here.

**`telemetry-period.ts` — never index `PERIOD_PRESETS` by POSITION.** The default
window used to be resolved as `PERIOD_PRESETS[3]`, so inserting a preset anywhere
above it silently changed what every trend page opened on — a latent trap that
bit when the `12h` preset was added 2026-08-27. It now resolves by VALUE against
`DEFAULT_PERIOD`. Add presets freely; do not reintroduce a positional lookup.
`15m` is kept even though the operator's list starts at `1h` — removing a preset
someone may be using was not part of that change.

### (historic) verified 2026-06-30 post-Phase-1-RBAC-catalog

`packages/shared/src/types/` contains **11 type files** (verified `ls packages/shared/src/types/*.ts | grep -v test` 2026-06-30):

| File | Purpose |
|---|---|
| `permissions.ts` | **102** permission constants (PERMISSIONS enum) — **2026-07-04 removed 7** with the reports generate/sign tear-out (`REPORT_TEMPLATE_{READ,CREATE,UPDATE,DELETE}`, `REPORT_VIEW`, `REPORT_SIGN`, `REPORT_DELETE`; 109→102; `REPORT_EXPORT`/`REPORT_GENERATE` KEPT — now gate the cleaning-record/lifecycle PDF export; `REPORT_REVIEW_SUBMIT/REVIEW/APPROVE` KEPT — ad-hoc review workflow). 2026-07-01 added `AUDIT_DELETE` (108→109; grantable via the `audit.delete` "Delete Audit Record (permanent)" picker toggle — re-adds physical audit hard-delete torn out 2026-05; **breaks the hash chain**, see apps/api audit/routes.ts); 2026-07-01 added `FILTER_LIST_EXPORT` (gates the Filters-page Export PDF/Excel menu via the new `filters.export` toggle; `filters.rfid_manage` made enforced-only same day); removed vestigial `ASSET_RELATIONSHIP_CREATE`/`ASSET_RELATIONSHIP_DELETE` (109→107; never used as a route gate — relationships gated by the edit perms; nodes + default-role grants + live-DB rows also stripped); `UNS_VIEW`/`UNS_MANAGE` removed 2026-06-17; 2026-06-30 Admin Requests split: `ADMIN_REQUEST_REVIEW` REMOVED, `ADMIN_REQUEST_APPROVE`/`ADMIN_REQUEST_REJECT` added (net +1; page visible to approve/reject holders, no view-only level) |
| `feature-privileges.ts` | **83** feature privileges + `FEATURE_TO_PERMISSION_MAP`. **2026-07-04: removed 9 tree nodes** with the reports generate/sign tear-out (90→83); the ACTIVE cleaning-record + lifecycle PDF export re-gated by making `cleaning_record.export`/`lifecycle.export` configurable (kept `REPORT_EXPORT` + `REPORT_GENERATE`). **2026-07-02: `filters.rfid_manage` re-added to the picker (configurable again; 89→90)** — reverses the 2026-07-01 enforced-only removal that left non-SUPER_ADMIN roles unable to be granted RFID assign (403 on tablet). Re-added to `CONFIGURABLE_PRIVILEGE_ORDER` + frozen snapshot. 2026-07-01: added `audit.delete` picker toggle (physical audit hard-delete; grant-set `[AUDIT_DELETE, AUDIT_READ]`; 88→89). 2026-07-01: `notifications.manage` made enforced-only (removed from picker); `notifications.delete` gate `[]`→`['NOTIFICATION_DELETE']` (now a real grantable perm; backend delete routes use requirePermission instead of requireSuperAdmin). 2026-07-01 redundancy audit: `checklists.toggle`/`cleaning_profiles.toggle` (dup their `.edit` gate) + `checklists.submit` (same `FILTER_OPERATE` gate as `filters.operate`) made enforced-only (92→89); `notifications.view/manage` re-tagged `enforce:'c'` (gate enforced by no route — visibility-only). **Phase 5E (2026-06-30): both now DERIVED from `PERMISSION_TREE`** (over the `configurable:true` nodes); hand-maintained arrays retired; frozen-snapshot test locks zero drift. `uns.*` removed 2026-06-17; 2026-06-30 admin_requests: `.view` removed, `.approve`/`.reject` added; 2026-06-30 `assets.create/edit/delete` made enforced-only (99→96); **2026-07-01 `assets.identifiers.create/delete` (RFID) + `assets.relationships.create/delete` made enforced-only (96→92; RFID covered by `filters.rfid_manage`, relationships gated by edit perms); `assets.view` label→"View Filters"**. Perm constants kept throughout. |
| `reauth-actions.ts` | ~~**92**~~ **48** reauth actions (the "92" is stale — see the Live Type Inventory correction above; `grep -cE "^\s+[A-Z_]+:" packages/shared/src/types/reauth-actions.ts` = 48, 2026-08-27). **2026-07-04 removed 7** with the reports generate/sign tear-out (`{CREATE,UPDATE,DELETE}_REPORT_TEMPLATE`, `GENERATE_REPORT`, `SIGN_REPORT`, `REJECT_REPORT`, `DELETE_REPORT`; 99→92; `REVIEW_REPORT`/`APPROVE_REPORT` KEPT — ad-hoc review workflow). **2026-07-04 removed 3 dead/theater actions** (`CREATE_TEMPLATE_KIND`, `UPDATE_TEMPLATE_KIND`, `DELETE_TEMPLATE_KIND` — rendered in the action-reauth config UI but never enforced by any endpoint; template kinds are seed-only, no runtime CRUD route; 102→99). **2026-07-01 added 2** (`DELETE_AUDIT_RECORD`, `BULK_DELETE_AUDIT_RECORDS` — physical audit hard-delete, category `Configuration`; 100→102). **2026-06-17 removed 6 actions** (`MANAGE_DEVICE_CREDENTIAL`, `OVERRIDE_UNS_PATH`, `DELETE_UNS_MAPPING`, `UPDATE_UNS_CONFIG`, `UPDATE_RETENTION_POLICY`, `EXECUTE_RETENTION`) and 2 categories (`UNS`, `Retention`) with data-ingestion tear-out |
| `roles.ts` | Role constants + hierarchy + display labels; `defaultRoles` extracted to `apps/api/prisma/default-roles.ts` (Phase 1 reconciliation) |
| `permission-categories.ts` | Permission grouping for the role-access UI |
| `permission-tree.ts` | **Single sidebar-anchored permission catalog (Sidebar→Page→Action); derives `FEATURE_PRIVILEGES` / `FEATURE_TO_PERMISSION_MAP` / `SIDEBAR_PRIVILEGE_MAP`; source of truth from Phase 1 onward** — added 2026-06-30. **Phase 5A (2026-06-30):** `PermissionNode` gained `gate: Permission[]` (discriminating backend perm, NOT grant-expansion) + optional `gateRoles?: string[]`. Helpers: `resolveNodeGate(nodeId)` / `resolveNodeGateRoles(nodeId)` — both return `[]` for unknown ids. `useCan()` hook in `apps/web/src/hooks/use-can.ts` consumes these. |
| `sidebar-items.ts` | ~~**27**~~ **15** sidebar items — the "27" here is stale (covered by the Live Type Inventory correction above; verified `grep -c "id: '" packages/shared/src/types/sidebar-items.ts` minus the interface's own `id: string;` line = 12, 2026-08-24; **13** since 2026-09-07). Current list: `home, dashboard, functional-locations, alarms, users, admin-requests, configuration, notifications, audit, system-health, instruments, debug-traces, data-report` (`data-report` added 2026-09-07 — the Instrument History widget's own page; `reports` added the same day — the report review workflow; **14** since then). Everything else in this row's prose (Organizations removed, `version-history`/`rfid-track-record`/`quality-notifications`/`reports-group` additions) describes items that were later removed with the domains they belonged to; `version-history` and the Reports-group items are NOT in the live list above. `home` (2026-07-13, first entry) is the one addition from this row's history that survives. |
| `sidebar-privilege-map.ts` | Sidebar item → privilege binding. **Phase 5E: now DERIVED** from `PERMISSION_TREE` group `visibilityPrivilegeIds` (`deriveSidebarPrivilegeMap()`); hand-maintained array retired. `getPrivilegesForSection` kept. |
| `audit-actions.ts` | **98** audit action constants for `AuditTrail.action` (`grep -cE "^\s+[A-Z_]+:\s*'"`, 2026-09-05; 97 → 98 with `INSTRUMENT_ATTRIBUTE_REPORTED`, the device → platform attribute write; earlier 93 → 97 with the alarm webhook annunciator) |
| `audit-templates.ts` | **92** templates in **7** categories (`AUDIT_TEMPLATE_DEFAULTS`, 2026-09-05; 91 → 92 with the same action — its template deliberately carries NO `{actor}`, there is none; earlier 87 → 91 with the alarm webhook annunciator) — they hide UUIDs in the audit UI (e.g. `"<RequestType> — <Name> (<EmployeeID>)"`). A template using a NEW placeholder is **two** edits: the template here AND the substitution in `apps/web/src/routes/audit/audit-helpers.ts`, or it renders literally in the exported §11 record; `{targetName}` and `{actor}` are substituted generically, so a template using only those needs no second edit. `template-placeholders.test.ts` is the check. |
| ~~`action-tape.ts`~~ | **File does not exist** (verified `ls packages/shared/src/types/` 2026-08-24, no matches anywhere in the codebase). It described the filter-operations action tape, gone with the domain. Remove this row next time this table is touched. |

Plus `index.ts` (barrel).

`packages/shared/src/schemas/` contains **7 Zod validation schemas** (+ `.test.ts` siblings, verified
`ls packages/shared/src/schemas/*.ts | grep -v test | wc -l` 2026-08-24 — the table below is stale;
`assets.ts`, `templates.ts`, `hierarchy.ts` don't exist any more (asset/entity domain removed), and
`instrument-profiles.ts` + `instruments.ts` were added since and are missing from this table):

| File | Purpose |
|---|---|
| `auth.ts` | Login, logout, change-password, force-login |
| `users.ts` | Create / update / role-assignment user payloads |
| `instruments.ts` | Instrument CRUD / attribute payloads |
| `instrument-profiles.ts` | Instrument profile CRUD payloads |
| `audit.ts` | Audit query schema |
| `config.ts` | All config-page payload schemas (password-policy, branding, datetime, etc.) |
| `action-reauth.ts` | Reauth-action request schema |

> ~~Stray file: `config.ts.patch` exists in this folder — clean up.~~ Does not exist (verified
> `ls packages/shared/src/schemas/*.patch` 2026-08-24: no such file) — already cleaned up.

## Notes
- Prisma schema has **36 Prisma models, 13 enums** (verified `grep -cE "^model "` / `"^enum "` 2026-08-27 — 2026-08-27 added 2 models (`AlarmWebhookTarget`, `AlarmWebhookDelivery`; 34 → 36) for the alarm webhook annunciator, with **no new enum** — its `method`/`event`/`status` are validated strings. Earlier, verified 2026-08-17 — 2026-08-17 added 2 enums (`AlarmSource`, `AlarmLimitKind`; 11 → 13) for instrument-limit alarms, plus `Alarm.ruleId` (now nullable), `source`, `limitKind`, `clearedValue`. Earlier: 2026-08-11 added `Floorplan` + `FloorplanRoom`; 2026-08-13 added `FunctionalLocation`, `AlarmRule`, `Alarm` and five enums (`FunctionalLocationType`, `AlarmMetric`, `AlarmComparison`, `AlarmSeverity`, `AlarmState`); 2026-08-14 added two VALUES to `NotificationEventType`, which is not a new enum. Earlier: **29 Prisma models, 6 enums** verified 2026-08-08; the long-standing "61 models, 23 enums" was inherited from upstream DigiLog and was NEVER true in this fork — the real count before Instrument Profiles was 28 models / 6 enums). Recent changes: rule-chain + alarm tear-out 2026-05-17 dropped 5 models; data-ingestion tear-out 2026-06-11..2026-06-17 dropped 6 models (`DeviceCredential`, `UnsMapping`, `ConnectivityStatus`, `DataStream`, `DeadLetterQueue`, `IngestionSystemConfig`); reports generate/sign tear-out 2026-07-04 dropped 4 models (`ReportTemplate`, `ReportTemplateVersion`, `ReportInstance`, `ReportSignature`) + 2 enums (`ReportTemplateStatus`, `ReportStatus`); Wave 1 typed-hierarchy migration added 4 sidecar tables Block/Area/AHU/Filter; Step 6 added `FilterDetails` 1:1 sidecar; Phase A.3 added `FilterProfileVersion` sidecar; Phase A.4 added `EquipmentGroupVersion` sidecar.
- ~~Phase 2 types (filter operations, cleaning profiles) are still co-located in API modules (not yet extracted)~~ — moot; filter operations/cleaning profiles were removed entirely in the 2026-07-18 Phase 0 strip, not just left un-extracted.
- 64 field IDs across 12 modules (stale Alarms ×11 + Telemetry ×3 removed 2026-06-29 with the torn-out subsystems — seed + DB) — **unverified 2026-08-24**, re-count before citing; several of the 12 modules referenced here no longer exist.

---

## Phase 3 Update (2026-04-07)

> ⚠️ **Removed — `rfid_scan_app/` does not exist** (verified `ls rfid_scan_app` 2026-08-24: no such
> file). No mobile app, RFID, or offline sync exists in this fork. Kept as history.

**RFID & Offline Operations:**
- RFID Scanner Android app (`rfid_scan_app/`) for KC-series UHF readers
- RFID keyboard guard prevents UKB tag input leaking into random fields
- Offline cleaning operations via IndexedDB queue + sync engine
- Cached identifier→filter map for offline RFID lookup
- "Data Synced" indicator in mobile header
- One identifier per entity (backend-enforced)
- Responsive layout with collapsible sidebar
- Error popups replace inline banners
- User creation auto-assigns org for admins
- `/api/roles/active` public endpoint for contact-admin page

See `CHANGELOG.md` for full details.

---

## Phase 4 Update (2026-04-14)

**Permissions & Privileges (snapshot at release; current totals are higher — see Live Type Inventory):**
- Each FEATURE_TO_PERMISSION_MAP mapping includes both frontend visibility permission + backend route permission
- 16 reauth categories
- `colorTheme` field added to `brandingConfigSchema` in `schemas/config.ts`
- Sidebar privilege map updated with new toggle IDs for Filters/Checklist/Cleaning Profile/Equipment Group/PM page controls

See `CHANGELOG.md` for full details.

## Phase 5 Updates (2026-04-15..29)

- New audit-template + audit-action types added (UUIDs no longer leak in admin-request audit UI)
- New permission/reauth additions: `FILTER_CREATE/EDIT/DELETE/HIERARCHY_EDIT/HIERARCHY_DELETE`, `PM_APPROVE`, 9 `REPORT_*` permissions, `BLOCK_CHANGE_REQUEST/APPROVE`
- `requireAnyPermission(...perms)` decorator pattern requires shared types to expose permission lists in tuple form (used by backend RBAC plugin to check "any of")
