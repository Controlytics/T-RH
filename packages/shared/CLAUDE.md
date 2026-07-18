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
- `types/` — TypeScript interfaces, enums, and constants (11 files; see Live Type Inventory below)
- `index.ts` — Barrel export

## Usage
```typescript
import { PERMISSIONS, loginSchema, createUserSchema } from '@digilog/shared';
```

## Exports Inventory

### Permissions
- `PERMISSIONS` enum — 52+ permission constants (ASSET_CREATE, ASSET_READ, FILTER_MANAGE, etc.)
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
- Alarm column definitions
- Relationship type mappings (INVERSE_RELATIONSHIP_MAP)

### Constants
- `ALARM_COLUMN_DEFINITIONS` — 11 alarm columns with metadata
- `INVERSE_RELATIONSHIP_MAP` — Bidirectional relationship type pairs
- Default audit text templates

## Live Type Inventory (verified 2026-06-30 post-Phase-1-RBAC-catalog)

`packages/shared/src/types/` contains **11 type files** (verified `ls packages/shared/src/types/*.ts | grep -v test` 2026-06-30):

| File | Purpose |
|---|---|
| `permissions.ts` | **102** permission constants (PERMISSIONS enum) — **2026-07-04 removed 7** with the reports generate/sign tear-out (`REPORT_TEMPLATE_{READ,CREATE,UPDATE,DELETE}`, `REPORT_VIEW`, `REPORT_SIGN`, `REPORT_DELETE`; 109→102; `REPORT_EXPORT`/`REPORT_GENERATE` KEPT — now gate the cleaning-record/lifecycle PDF export; `REPORT_REVIEW_SUBMIT/REVIEW/APPROVE` KEPT — ad-hoc review workflow). 2026-07-01 added `AUDIT_DELETE` (108→109; grantable via the `audit.delete` "Delete Audit Record (permanent)" picker toggle — re-adds physical audit hard-delete torn out 2026-05; **breaks the hash chain**, see apps/api audit/routes.ts); 2026-07-01 added `FILTER_LIST_EXPORT` (gates the Filters-page Export PDF/Excel menu via the new `filters.export` toggle; `filters.rfid_manage` made enforced-only same day); removed vestigial `ASSET_RELATIONSHIP_CREATE`/`ASSET_RELATIONSHIP_DELETE` (109→107; never used as a route gate — relationships gated by the edit perms; nodes + default-role grants + live-DB rows also stripped); `UNS_VIEW`/`UNS_MANAGE` removed 2026-06-17; 2026-06-30 Admin Requests split: `ADMIN_REQUEST_REVIEW` REMOVED, `ADMIN_REQUEST_APPROVE`/`ADMIN_REQUEST_REJECT` added (net +1; page visible to approve/reject holders, no view-only level) |
| `feature-privileges.ts` | **83** feature privileges + `FEATURE_TO_PERMISSION_MAP`. **2026-07-04: removed 9 tree nodes** with the reports generate/sign tear-out (90→83); the ACTIVE cleaning-record + lifecycle PDF export re-gated by making `cleaning_record.export`/`lifecycle.export` configurable (kept `REPORT_EXPORT` + `REPORT_GENERATE`). **2026-07-02: `filters.rfid_manage` re-added to the picker (configurable again; 89→90)** — reverses the 2026-07-01 enforced-only removal that left non-SUPER_ADMIN roles unable to be granted RFID assign (403 on tablet). Re-added to `CONFIGURABLE_PRIVILEGE_ORDER` + frozen snapshot. 2026-07-01: added `audit.delete` picker toggle (physical audit hard-delete; grant-set `[AUDIT_DELETE, AUDIT_READ]`; 88→89). 2026-07-01: `notifications.manage` made enforced-only (removed from picker); `notifications.delete` gate `[]`→`['NOTIFICATION_DELETE']` (now a real grantable perm; backend delete routes use requirePermission instead of requireSuperAdmin). 2026-07-01 redundancy audit: `checklists.toggle`/`cleaning_profiles.toggle` (dup their `.edit` gate) + `checklists.submit` (same `FILTER_OPERATE` gate as `filters.operate`) made enforced-only (92→89); `notifications.view/manage` re-tagged `enforce:'c'` (gate enforced by no route — visibility-only). **Phase 5E (2026-06-30): both now DERIVED from `PERMISSION_TREE`** (over the `configurable:true` nodes); hand-maintained arrays retired; frozen-snapshot test locks zero drift. `uns.*` removed 2026-06-17; 2026-06-30 admin_requests: `.view` removed, `.approve`/`.reject` added; 2026-06-30 `assets.create/edit/delete` made enforced-only (99→96); **2026-07-01 `assets.identifiers.create/delete` (RFID) + `assets.relationships.create/delete` made enforced-only (96→92; RFID covered by `filters.rfid_manage`, relationships gated by edit perms); `assets.view` label→"View Filters"**. Perm constants kept throughout. |
| `reauth-actions.ts` | **92** reauth actions. **2026-07-04 removed 7** with the reports generate/sign tear-out (`{CREATE,UPDATE,DELETE}_REPORT_TEMPLATE`, `GENERATE_REPORT`, `SIGN_REPORT`, `REJECT_REPORT`, `DELETE_REPORT`; 99→92; `REVIEW_REPORT`/`APPROVE_REPORT` KEPT — ad-hoc review workflow). **2026-07-04 removed 3 dead/theater actions** (`CREATE_TEMPLATE_KIND`, `UPDATE_TEMPLATE_KIND`, `DELETE_TEMPLATE_KIND` — rendered in the action-reauth config UI but never enforced by any endpoint; template kinds are seed-only, no runtime CRUD route; 102→99). **2026-07-01 added 2** (`DELETE_AUDIT_RECORD`, `BULK_DELETE_AUDIT_RECORDS` — physical audit hard-delete, category `Configuration`; 100→102). **2026-06-17 removed 6 actions** (`MANAGE_DEVICE_CREDENTIAL`, `OVERRIDE_UNS_PATH`, `DELETE_UNS_MAPPING`, `UPDATE_UNS_CONFIG`, `UPDATE_RETENTION_POLICY`, `EXECUTE_RETENTION`) and 2 categories (`UNS`, `Retention`) with data-ingestion tear-out |
| `roles.ts` | Role constants + hierarchy + display labels; `defaultRoles` extracted to `apps/api/prisma/default-roles.ts` (Phase 1 reconciliation) |
| `permission-categories.ts` | Permission grouping for the role-access UI |
| `permission-tree.ts` | **Single sidebar-anchored permission catalog (Sidebar→Page→Action); derives `FEATURE_PRIVILEGES` / `FEATURE_TO_PERMISSION_MAP` / `SIDEBAR_PRIVILEGE_MAP`; source of truth from Phase 1 onward** — added 2026-06-30. **Phase 5A (2026-06-30):** `PermissionNode` gained `gate: Permission[]` (discriminating backend perm, NOT grant-expansion) + optional `gateRoles?: string[]`. Helpers: `resolveNodeGate(nodeId)` / `resolveNodeGateRoles(nodeId)` — both return `[]` for unknown ids. `useCan()` hook in `apps/web/src/hooks/use-can.ts` consumes these. |
| `sidebar-items.ts` | **27** sidebar items (Organizations entry removed in MT removal; `version-history` added 2026-05-02; **2026-06-11** added `rfid-track-record` + `quality-notifications` — real Reports-group nav items that were missing from this configurable list, so editing a role's sidebar config silently dropped them. `reports-group` is a derived container and intentionally NOT a configurable item. **2026-07-13** added `home` (first entry) — the Module Guide, previously force-shown in `sidebar.tsx` and absent here, now a normal Roles-&-Access-managed item; existing role_configs backfilled with `home`.) |
| `sidebar-privilege-map.ts` | Sidebar item → privilege binding. **Phase 5E: now DERIVED** from `PERMISSION_TREE` group `visibilityPrivilegeIds` (`deriveSidebarPrivilegeMap()`); hand-maintained array retired. `getPrivilegesForSection` kept. |
| `audit-actions.ts` | Audit action constants for `AuditTrail.action` |
| `audit-templates.ts` | Templates that hide UUIDs in audit UI (e.g. `"<RequestType> — <Name> (<EmployeeID>)"`) |
| `action-tape.ts` | Action-tape discriminated union (7 action variants: ADVANCE_TO_STAGE / SUBMIT_CHECKLIST / SUBMIT_DRYER_READINGS / SET_DRYER_DURATION / BYPASS_STAGE / TERMINATE_CYCLE / COMPLETE_CYCLE) — lifted from filter-operations module in Phase 5 (Step 8.1) |

Plus `index.ts` (barrel).

`packages/shared/src/schemas/` contains **8 Zod validation schemas** (+ `.test.ts` siblings):

| File | Purpose |
|---|---|
| `auth.ts` | Login, logout, change-password, force-login |
| `users.ts` | Create / update / role-assignment user payloads |
| `assets.ts` | Asset template + instance + relationship + identifier + **TemplateKind CRUD** payloads. `SYSTEM_TEMPLATE_KIND_CODES` and `templateKindCodeSchema` exported here (Step 1 of architectural refactor). |
| `templates.ts` | Asset template body schema (`attributeSchema`, alarm rules) |
| `hierarchy.ts` | Block / Area / AHU hierarchy create payloads |
| `audit.ts` | Audit query schema |
| `config.ts` | All config-page payload schemas (password-policy, branding, datetime, etc.) |
| `action-reauth.ts` | Reauth-action request schema |

> Stray file: `config.ts.patch` exists in this folder — clean up.

## Notes
- Prisma schema has **61 models, 23 enums** in `apps/api/prisma/schema.prisma` (verified 2026-07-04). Recent changes: rule-chain + alarm tear-out 2026-05-17 dropped 5 models; data-ingestion tear-out 2026-06-11..2026-06-17 dropped 6 models (`DeviceCredential`, `UnsMapping`, `ConnectivityStatus`, `DataStream`, `DeadLetterQueue`, `IngestionSystemConfig`); reports generate/sign tear-out 2026-07-04 dropped 4 models (`ReportTemplate`, `ReportTemplateVersion`, `ReportInstance`, `ReportSignature`) + 2 enums (`ReportTemplateStatus`, `ReportStatus`); Wave 1 typed-hierarchy migration added 4 sidecar tables Block/Area/AHU/Filter; Step 6 added `FilterDetails` 1:1 sidecar; Phase A.3 added `FilterProfileVersion` sidecar; Phase A.4 added `EquipmentGroupVersion` sidecar.
- Phase 2 types (filter operations, cleaning profiles) are still co-located in API modules (not yet extracted)
- 64 field IDs across 12 modules (stale Alarms ×11 + Telemetry ×3 removed 2026-06-29 with the torn-out subsystems — seed + DB)

---

## Phase 3 Update (2026-04-07)

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
