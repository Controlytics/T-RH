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
- `types/` — TypeScript interfaces, enums, and constants (**37 files**, re-derived 2026-10-29 — 36 → 37: `profile-display-keys.ts`, the trend page's extra keys per profile (`profileDisplayKeysSchema`, the forgiving reader `coerceProfileDisplayKeys`, `displayKeysEqual`, max 12). Earlier 35 → 36 (2026-10-28): `dashboard-widgets.ts`, the built dashboard widget contract (`customWidgetSchema`, `w:<id>` items, `widgetsEqual`, the caps; `dashboard-layout.ts` gained the strict `parseLayoutForWrite` and the `custom_widgets` gate). Earlier 34 → 35: `data-keys.ts`, the widget data-key contract (`dataKeyRefSchema`, `latestValuesRequestSchema`, the catalogue / latest-values response types and the 128 / 200 / 20 caps; 6 unit tests). Earlier 33 → 34 (2026-10-26): `profile-measurements.ts`, what each instrument PROFILE measures and which keys carry it — `profileMeasurementsSchema` (the ONE validator), `coerceProfileMeasurements` (the ONE reader: NULL or unreadable = `DEFAULT_PROFILE_MEASUREMENTS`, `[]` = measures nothing), `slotConfigFromMeasurements` (one profile's keys in the shapes the old global loaders returned), `measurementsEquivalent`; 17 unit tests, plus 3 for `isMktOn` (the profile MKT switch) in `mkt.test.ts`. Earlier 32 → 33: `mkt.ts`, Mean Kinetic Temperature (ICH Q1A / USP <1150>): the constant, `mktFromExpMean` for the API's SQL path, the pure reference `mktCelsius`, and `isMktEnabled`, the ONE reader of `isMktCalculationEnabled` (OFF by default). Earlier **32 files**, re-derived 2026-10-01 — 31 → 32: `sensor-offsets.ts` (the ONE parser, test and ingest correction for Temp / Humid Off set); 30 → 31: `report-downloads.ts` (`REPORT_KINDS`, `coerceReportDownloads` for the STORED row and `coerceReportDownloadsResponse` for the narrow route's per-kind shape — two readers, never swapped); `report-approvers.ts` gained `coerceApproverUserIds` / `coerceReportApprovers`. Earlier **30 files**, re-derived `ls packages/shared/src/types/*.ts | grep -v test | wc -l` 2026-09-22 — 29 → 30 that day: `floorplan-geometry.ts`, the ONE polygon geometry for floor plans (rectangle corners in a fixed order, bounding box, simple-polygon test, `validatePolygon`, `sharedEdges` / `mirrorOpening`, `largestInscribedRect`, `doorEdge`, `centroid`, `unionRectilinear`; **2026-10-01: `inscribedRects`, every maximal rectangle inside an outline, largest first — the dashboard tries a room's other arms for its card**; **2026-10-05: `segmentOnEdge` (a two-click segment both of whose ends lie within `SEGMENT_SNAP_TOL` of ONE edge lands on it; one end near each of two edges stays free) and `splitDoor` (a double door is two half-width doors with mirrored hinges) — the Layout Designer's 2D tools; 6 unit tests**), used by the API's room validation, the Layout Designer and the dashboard's drawing — 23 unit tests, mutation-checked; nothing geometric may be re-implemented on either side. Earlier **29 files**, re-derived 2026-09-16 — 28 → 29 that day: `attribute-labels.ts` (`coerceAttributeLabels`, the ONE reader of the `attribute-labels` config row, and `attributeLabel`, the ONE lookup: blank falls back to the KEY, lookup folds case; 11 unit tests, mutation-checked; **2026-09-21 the same file gained `coerceSettingsHidden` / `isHiddenInSettings` / `SETTINGS_HIDDEN_NONE` and the `SettingsHidden` type — the Settings PAGE's hidden set, stored as `settingsHidden` on the same config row; anything but the exact shape reads as nothing hidden, never as hide-everything; 16 unit tests now, file count unchanged**). **The 26 recorded next was already stale by two** — `report-approvers.ts` and one other landed without this line moving; re-derive. Earlier **26 files**, re-derived 2026-09-01 — 25 → 26 that day: `trend-widgets.ts`, the administered wording and per-widget date/time formats for the instrument trend page (the shipped defaults, the blank-falls-back resolver, the format vocabulary lifted from `datetime.def.ts`, and `TREND_WIDGET_FIELDS`, the ONE widget → fields mapping that both the config def's settings and the edit dialog are built from). **The 21 recorded below was stale by four before that** — re-derive, never trust this line. Earlier claimed **21 files**, verified `ls packages/shared/src/types/*.ts | grep -v test | wc -l` 2026-08-31 — `inactivity-alarms.ts` added that day (the inactivity-alarm defaults, snapshot shape and the ONE wording for "quiet > 15m", shared because the API freezes those numbers onto the alarm and the browser renders them back). **The 18 recorded below was already stale by two before that** — `dashboard-layout.ts`, `panel-style.ts` and `telemetry-period.ts` landed without this line being re-synced; that shortfall is corrected here, not caused here. Earlier **18 files**, verified `ls packages/shared/src/types/*.ts | grep -v test | wc -l` 2026-08-28 — 2026-08-28 added `panels.ts`, the ONE catalogue of assignable dashboard/trend panels plus its resolver; it replaced an `ALL_CARDS` array in the web config page and a `VALID_CARD_KEYS` set in an API route that carried a "keep in sync" comment. Its key order is frozen by test because the keys are stored in `role_configs`/`user_configs`. Earlier **17 files**, verified `ls packages/shared/src/types/*.ts | grep -v test | wc -l` 2026-08-27 — 2026-08-27 added `telemetry-downsample.ts` (`lttb()`, Largest-Triangle-Three-Buckets: it SELECTS a subset of the readings it is given and never computes a new one, which is why the trend page can plot a 30-day range without inventing a value; its tests assert reference equality with `toBe`, so a refactor that builds new objects fails). 2026-08-27 also added `alarm-webhook.ts`, which this line was never re-synced for — the "15" was stale by two before this correction. Earlier, 2026-08-19 added `telemetry-decimals.ts` (per-instrument display precision, and which attribute keys hold a temperature or a humidity) and `attribute-access.ts` (per-role instrument-attribute editability + the mandatory-remark validator); both are shared because BOTH sides decide with them and a second implementation would show an affordance the API refuses. Earlier: `alarm-limits.ts` added 2026-08-17 for the instrument-limit alarm work; the "11 files" recorded here was already stale before that, and the real count was 12 when that plan started. See Live Type Inventory below)
- `index.ts` — Barrel export

## Usage
```typescript
import { PERMISSIONS, loginSchema, createUserSchema } from '@digilog/shared';
```

## Exports Inventory

### Permissions
- `PERMISSIONS` enum — **45** permission constants (44 → 45 on 2026-10-26, `REPORT_REVIEW_REJECT`; 42 → 44 on 2026-09-07, `REPORT_REVIEW_READ` / `REPORT_REVIEW_APPROVE`; earlier verified `grep -cE "^\s+[A-Z_]+:\s*'"
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
> **45** permission constants, **39** feature privileges (38 → 39 on 2026-10-26: `reports.reject`,
> Approve and Reject Reports split into two toggles; 45 → 38 on 2026-10-24: seven toggles
> that could never take effect left the Permissions tab — the two Alarm Rules nodes were deleted,
> Dashboards create / manage / assign, Delete Users and Field IDs stay as nodes, not configurable),
> **56** reauth actions in
> **8** categories, **100** audit actions, **113** audit templates in **7**
> categories (98 → 100 / 111 → 113 on 2026-10-27: `DEVICE_CERTIFICATE_ISSUED` /
> `DEVICE_CERTIFICATE_REVOKED`, Instruments). Earlier **98** / **111** in **7**
> categories (103 → 106 / 97 → 100 on 2026-09-22: `FLOORPLAN_LINK_CREATED` /
> `UPDATED` / `DELETED`, the Layout Designer's room links; `{room}` carries
> "A ↔ B", no new placeholder). Earlier **103** / **97** in **7**
> categories (102 → 103 / 96 → 97 on 2026-09-21: `ALARMS_PURGED`, the
> whole-table purge recorded by `apps/api/scripts/purge-alarms.ts`; generic
> `{actor}` only), **14** sidebar items, **14** PERMISSION_TREE groups, **56** tree
> nodes (55 → 56 on 2026-10-26, `reports.reject`; 57 → 55 on 2026-10-24, the Alarm Rules pair).
> 2026-09-19 (Home removed): sidebar items 15 → 14 (`home`, the Module Guide —
> the one item that had NO tree group; every remaining item has one, and
> `apps/web`'s `sidebar-visibility.test.ts` now locks that). Tree unchanged.
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

### Type files (live, re-derived 2026-10-05)

`packages/shared/src/types/` contains **37 type files** (2026-10-29, 36 → 37 with `profile-display-keys.ts`; 35 → 36 with `dashboard-widgets.ts`; 34 → 35 with `data-keys.ts`; `ls packages/shared/src/types/*.ts | grep -v test | wc -l`, 2026-10-26; 33 → 34 with `profile-measurements.ts`). The ones that carry a count:

| File | Live count (command, 2026-10-05) |
|---|---|
| `permissions.ts` | **45** permission constants (`grep -cE "^\s+[A-Z_]+:\s*'"`) |
| `feature-privileges.ts` | **39** feature privileges + `FEATURE_TO_PERMISSION_MAP`, DERIVED from `PERMISSION_TREE` (`legacy-maps-derived.test.ts` pins 39; 38 until 2026-10-26, 45 until 2026-10-24) |
| `reauth-actions.ts` | **56** reauth actions in **8** categories (`grep -cE "^\s+[A-Z_]+:"`; `grep -oE "category: '[^']+'" \| sort -u \| wc -l`) |
| `roles.ts` | Role constants + hierarchy + display labels; `defaultRoles` lives in `apps/api/prisma/default-roles.ts` |
| `permission-categories.ts` | Permission grouping for the role-access UI |
| `permission-tree.ts` | The single Sidebar→Page→Action catalog; derives `FEATURE_PRIVILEGES` / `FEATURE_TO_PERMISSION_MAP` / `SIDEBAR_PRIVILEGE_MAP`; `resolveNodeGate(nodeId)` feeds `useCan()` |
| `sidebar-items.ts` | **14** sidebar items (`grep -c "id: '"`) |
| `sidebar-privilege-map.ts` | Sidebar item → privilege binding, DERIVED from the tree's `visibilityPrivilegeIds` (**14** sections) |
| `audit-actions.ts` | **100** audit action constants (98 → 100 on 2026-10-27, the device-certificate pair) (`grep -cE "^\s+[A-Z_]+:\s*'"`) |
| `audit-templates.ts` | **113** templates in **7** categories (`grep -cE "^\s+[A-Z_]+:\s*\{"`, 2026-10-27; this row read 102 — a 2026-10-05 figure, already stale at 111 — until then). A template using a NEW placeholder is **two** edits: the template here AND the substitution in `apps/web/src/routes/audit/audit-helpers.ts`, or it renders literally in the exported §11 record; `{targetName}` and `{actor}` are substituted generically. `template-placeholders.test.ts` is the check. |

A "(historic) verified 2026-06-30" table stood here until 2026-10-05 with the upstream DigiLog
numbers (102 / 83 / 92 / 27) struck through and every removal narrated in the cells (audit
finding DOCS-5). That history is in `CHANGELOG.md`; the Live Type Inventory block above keeps
the per-change deltas since 2026-08-24. `action-tape.ts`, which that table still listed, does
not exist.

Plus `index.ts` (barrel).

`packages/shared/src/schemas/` contains **8 Zod validation schema files** (+ `.test.ts` siblings,
re-derived `ls packages/shared/src/schemas/*.ts | grep -v test | wc -l` 2026-10-05 — 7 → 8 that day:
`admin-forms.ts`, the CLIENT-side schemas for the LDAP, notification rule / template, help article and
New Instrument forms (audit 2026-10-03, WEB-15) plus `formFieldErrors()`, the `{ field: [messages] }`
reader the pages render from; they live here so `apps/web` grows no direct `zod` dependency. The
server stays authoritative. Earlier verified 2026-08-24 — the table below is stale;
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
- Prisma schema has **38 Prisma models, 13 enums** (37 → 38 on 2026-10-26: `MeasurementType`, migration `20261026120000_profile_measurements`; 36 → 37 on 2026-09-22: `FloorplanRoomLink`; earlier verified `grep -cE "^model "` / `"^enum "` 2026-08-27 — 2026-08-27 added 2 models (`AlarmWebhookTarget`, `AlarmWebhookDelivery`; 34 → 36) for the alarm webhook annunciator, with **no new enum** — its `method`/`event`/`status` are validated strings. Earlier, verified 2026-08-17 — 2026-08-17 added 2 enums (`AlarmSource`, `AlarmLimitKind`; 11 → 13) for instrument-limit alarms, plus `Alarm.ruleId` (now nullable), `source`, `limitKind`, `clearedValue`. Earlier: 2026-08-11 added `Floorplan` + `FloorplanRoom`; 2026-08-13 added `FunctionalLocation`, `AlarmRule`, `Alarm` and five enums (`FunctionalLocationType`, `AlarmMetric`, `AlarmComparison`, `AlarmSeverity`, `AlarmState`); 2026-08-14 added two VALUES to `NotificationEventType`, which is not a new enum. Earlier: **29 Prisma models, 6 enums** verified 2026-08-08; the long-standing "61 models, 23 enums" was inherited from upstream DigiLog and was NEVER true in this fork — the real count before Instrument Profiles was 28 models / 6 enums). Recent changes: rule-chain + alarm tear-out 2026-05-17 dropped 5 models; data-ingestion tear-out 2026-06-11..2026-06-17 dropped 6 models (`DeviceCredential`, `UnsMapping`, `ConnectivityStatus`, `DataStream`, `DeadLetterQueue`, `IngestionSystemConfig`); reports generate/sign tear-out 2026-07-04 dropped 4 models (`ReportTemplate`, `ReportTemplateVersion`, `ReportInstance`, `ReportSignature`) + 2 enums (`ReportTemplateStatus`, `ReportStatus`); Wave 1 typed-hierarchy migration added 4 sidecar tables Block/Area/AHU/Filter; Step 6 added `FilterDetails` 1:1 sidecar; Phase A.3 added `FilterProfileVersion` sidecar; Phase A.4 added `EquipmentGroupVersion` sidecar.
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
- 16 reauth categories at that release (**8** on 2026-10-05 — `grep -oE "category: '[^']+'" packages/shared/src/types/reauth-actions.ts | sort -u | wc -l`)
- `colorTheme` field added to `brandingConfigSchema` in `schemas/config.ts`
- Sidebar privilege map updated with new toggle IDs for Filters/Checklist/Cleaning Profile/Equipment Group/PM page controls

See `CHANGELOG.md` for full details.

## Phase 5 Updates (2026-04-15..29)

- New audit-template + audit-action types added (UUIDs no longer leak in admin-request audit UI)
- New permission/reauth additions: `FILTER_CREATE/EDIT/DELETE/HIERARCHY_EDIT/HIERARCHY_DELETE`, `PM_APPROVE`, 9 `REPORT_*` permissions, `BLOCK_CHANGE_REQUEST/APPROVE`
- `requireAnyPermission(...perms)` decorator pattern requires shared types to expose permission lists in tuple form (used by backend RBAC plugin to check "any of")
