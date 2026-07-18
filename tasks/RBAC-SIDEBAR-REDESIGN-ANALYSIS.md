# Sidebar-Based RBAC Redesign — Analysis & Implementation Plan

**Status:** AWAITING APPROVAL — no code changes until approved (per requirement 12)
**Date:** 2026-06-30
**Branch:** RFID
**Author:** analysis pass over live code (backend + frontend + DB + routing + sidebar + Roles & Access)

---

## 0. TL;DR — read this first

You asked to replace a "module-wise" permission system with a "sidebar-menu-based"
RBAC. **The brutally honest finding: the system is already ~80% sidebar-anchored.**
`FEATURE_PRIVILEGES` is already `module.action` (`users.create`, `filters.operate`),
`SIDEBAR_PRIVILEGE_MAP` already ties each sidebar item to its privileges, and the
admin UI already shows checkboxes grouped by category.

The real problems are **fragmentation and gaps**, not the model:

- **5–6 overlapping permission layers** with two parallel vocabularies (uppercase
  `PERMISSIONS` vs dotted `FEATURE_PRIVILEGES`) bridged by a hand-maintained map.
- **A separate `access-matrix` system** gating config pages, with a **fail-OPEN**
  default (the single biggest security gap).
- **Export permissions that are pure frontend theater** (`AUDIT_EXPORT`,
  `RETIREMENT_LIST_EXPORT`, `REPLACEMENT_LIST_EXPORT`, the cleaning-record/lifecycle
  export gates) — the data is already delivered to the client; there is no backend
  export endpoint to protect.
- **Two genuinely open routes** (`/quality-notifications`, `/checklist/:entityId`).
- **3 GET endpoints on Report Reviews with no permission gate** (any logged-in user
  can read the review queue by URL).
- **Single-delete on Notifications has no `requirePermission`** while bulk-delete does.
- **A dead `DASHBOARD_*` permission family** (4 perms) gating CRUD no UI reaches.
- **FE/BE mismatches** where the button is hidden but the API is reachable (status
  update, retire/replace, PM delete, user delete).

### Chosen approach (your decision, 2026-06-30): **B — Consolidate + fill gaps**

Reorganize into ONE sidebar-anchored permission **catalog** (Sidebar → Page →
Action), collapse the parallel gating systems into it, and **close every enforcement
gap** — while keeping the underlying enforced permission strings working as aliases so
the 21 CFR Part 11 audit trail stays valid. **Not** a from-scratch rewrite.

### Chosen granularity (your decision): **Every applicable action, per page**

Each page exposes only its real actions as separate toggles (~150–200 nodes total),
matching requirements 3–4.

### One key architecture decision made in this report (please confirm in §6)

**Uppercase `PERMISSIONS` stays the canonical, *enforced* vocabulary.** The sidebar
tree is a **catalog/presentation layer on top** of it, not a replacement. Every
backend gate (`requirePermission('USER_DELETE')`) and every route guard
(`RequireRole permissions={[PERMISSIONS.USER_READ]}`) keeps working untouched. This is
the lower-risk direction and is the true spirit of approach B. (The alternative —
making dotted `module.action` canonical and aliasing the uppercase strings — would
touch hundreds of gate call-sites for no compliance benefit. Rejected; see §6.)

---

## 1. Current permission flow (as built)

### 1.1 The six layers

| # | Layer | File | Role |
|---|-------|------|------|
| 1 | `PERMISSIONS` (≈109) | `packages/shared/src/types/permissions.ts` | The **real backend gate** vocabulary (`USER_CREATE`). Uppercase `MODULE_ACTION`. |
| 2 | `FEATURE_PRIVILEGES` (≈98) | `packages/shared/src/types/feature-privileges.ts` | **Admin-facing toggles** — already `module.action` (`users.create`). |
| 3 | `FEATURE_TO_PERMISSION_MAP` | same file, L204-352 | Bridge: privilege id → one-or-more `PERMISSIONS`. |
| 4 | `REAUTH_ACTIONS` (≈100) | `packages/shared/src/types/reauth-actions.ts` | **Step-up e-signature** (CFR §11). Separate axis from RBAC. |
| 5 | `SIDEBAR_PRIVILEGE_MAP` | `packages/shared/src/types/sidebar-privilege-map.ts` | Sidebar item → privilege ids (visibility). |
| 6 | config `access-matrix` | `apps/api/.../config/static-routes/access-matrix.routes.ts` | A **parallel** role→page gate, **for config cards only**, **fail-open**. |

### 1.2 Storage & resolution

- **`Role.permissions`** is a `JsonB` **string array** directly on the role row
  (`schema.prisma:117`). No `Permission` table, no `RolePermission` join.
- **`User.role`** is a `VarChar(50)` string FK by name (`schema.prisma:146`). One role
  per user.
- **JWT carries only the role name** (`lib/jwt.ts:21-26`), NOT permissions.
- On each request, `auth.ts` `onRequest` re-reads the authoritative role from DB
  (30s cache) and overwrites `req.user.role`; then the RBAC gate resolves
  `role → permissions[]` (5s cache, `plugins/rbac.ts:31-47`).
- The frontend gets the permission list via `GET /api/auth/me`
  (`auth.service.ts:297`, `auth.repository.ts:25`).

### 1.3 Enforcement primitives

- **Backend:** `app.requirePermission(p)`, `app.requireAnyPermission(...p)`,
  `app.requireRole(...r)`, `app.requireSuperAdmin()` (`plugins/rbac.ts:58-155`).
  `hasEffectivePermission()` (`permissions.ts:228-267`) applies implicit expansion:
  `*_VIEW ← *_READ`, and `*_MANAGE` grants `_CREATE/_UPDATE/_DELETE/_VIEW/_READ/_EXPORT`
  (but **not** `_RESTORE`).
- **Frontend route guard:** `<RequireRole permissions={[...]} roles={[...]}>`
  (`components/require-role.tsx`), **OR-semantics**, client-side only.
- **Frontend button gating:** ad-hoc per page (`isSuperAdmin || perms.includes('X')`),
  **no shared hook** → easy to forget.
- **SUPER_ADMIN bypasses every layer** — 4 backend decorators + every frontend check
  (`require-role.tsx:29` and inline `isSuperAdmin` in each page).

### 1.4 Roles & Access admin UI (`/config/roles`, `role-access.tsx`)

4 tabs: **Roles | Permissions | Sidebar | Re-auth**. Permission assignment is a
checkbox list of `FEATURE_PRIVILEGES` grouped by category; saved as a `{featureId:
bool}` map to `PUT /api/config/roles/:name`. Sidebar visibility and reauth policy are
separate tabs writing via `CONFIG_UPDATE`-gated endpoints.

---

## 2. Complete sidebar-based permission hierarchy (proposed catalog)

This is the new **single catalog**. Each leaf is an **action node**. The
`enf` column classifies enforceability:

- **(a)** enforceable today via an existing dedicated backend gate
- **(b)** needs a NEW narrower backend gate to become real (today it's theater,
  shares a broad permission, or has an FE/BE mismatch)
- **(c)** cosmetic-only by nature — client-side action over already-fetched data; can
  never be a real backend gate (we keep it as a UI toggle but document it honestly)

> **Critical caveat (read before trusting per-page View control):** Several "view"
> actions are backed by *shared* broad permissions. `ASSET_READ`/`ASSET_VIEW` backs
> **~6 pages** (Filters, Retirement, Replacement, Lifecycle Report, Cleaning Record,
> Equipment Groups dropdowns). `CYCLE_READ` backs **3 report pages**. Granting one
> today grants the shared data everywhere. Making per-page View real requires new
> narrower read gates — these are tagged **(b)**.

### 2.1 Main sidebar

```
Dashboard                       (/)                         enf
 └── View                        dashboard.view             (b) route is UNGATED today; widgets gated by config not perms
 └── Manage Dashboards*          dashboard.manage           (c) DEAD — DASHBOARD_* CRUD has no UI; recommend retire or wire

Users                           (/users)
 ├── View                        users.view                 (a) USER_READ
 ├── Add                         users.create               (a) USER_CREATE   (FE button currently UNGATED — gap)
 ├── Edit                        users.edit                 (a) USER_UPDATE
 ├── Delete                      users.delete               (b) USER_DELETE exists but FE hardcodes SUPER_ADMIN — mismatch
 ├── Enable / Disable            users.enable_disable       (a) USER_ENABLE_DISABLE
 ├── Unlock                      users.unlock               (a) USER_UNLOCK
 └── Reset Password              users.reset_password       (a) USER_RESET_PASSWORD

Admin Requests                  (/admin-requests)
 ├── View                        admin_requests.view        (a) ADMIN_REQUEST_REVIEW
 ├── Approve                     admin_requests.approve     (a) ADMIN_REQUEST_REVIEW (shared w/ reject)
 └── Reject                      admin_requests.reject      (b) split from approve if you want distinct control

Configuration                   (/config)   [parent group — see §2.3 for all cards]
 ├── View Config                 config.view                (a) CONFIG_READ
 └── Edit Config                 config.edit                (a) CONFIG_UPDATE
     (each config card is a child node — §2.3)

Notifications                   (/notifications)
 ├── View                        notifications.view         (a) NOTIFICATION_VIEW (list API itself UNGATED — gap)
 ├── Mark Read/Unread            notifications.mark         (c) per-user data, no gate needed
 └── Delete                      notifications.delete       (b) bulk=NOTIFICATION_DELETE, single=NO GATE — fix asymmetry

Audit Trail                     (/audit)
 ├── View                        audit.view                 (a) AUDIT_READ
 ├── Export                      audit.export               (c) THEATER — client-side jsPDF; no backend export endpoint
 ├── Redact                      audit.redact               (a) requireSuperAdmin + reauth
 └── Verify Chain                audit.verify_chain         (a) requireSuperAdmin (no UI surface yet)

Report Reviews                  (/report-reviews)
 ├── View                        report_reviews.view        (b) 3 GET endpoints have NO GATE — any user reads queue
 ├── Review                      report_reviews.review      (a) REPORT_REVIEW + reauth always
 ├── Approve                     report_reviews.approve     (a) REPORT_APPROVE + reauth always
 └── Reject                      report_reviews.reject      (a) folded into review/approve endpoints

Stage Approvals                 (/stage-approvals)
 ├── View                        stage_approvals.view       (a) STAGE_APPROVAL_VIEW
 ├── Approve                     stage_approvals.approve    (a) STAGE_APPROVAL_DECIDE + reauth always
 └── Reject                      stage_approvals.reject     (a) STAGE_APPROVAL_DECIDE + reauth always

System Health                   (/system-health)
 └── View                        system_health.view         (b) role-gated (SUPER_ADMIN/ADMIN), not permission-gated

Debug Traces                    (/debug/traces)
 ├── View                        debug.view                 (a) READ_DEBUG_TRACE
 └── Manage (toggle)             debug.manage               (b) MANAGE_DEBUG_TRACE — toggle is a no-op/vestigial; FE shows it to read-only users

Filters                         (/filter-list)
 ├── View                        filters.view               (b) ASSET_READ/ASSET_VIEW — SHARED across 6 pages
 ├── Add Filter                  filters.create             (a) FILTER_CREATE | ASSET_CREATE
 ├── Edit Filter                 filters.edit               (a) FILTER_EDIT | ASSET_UPDATE
 ├── Delete Filter               filters.delete             (a) FILTER_DELETE | ASSET_DELETE
 ├── Create Block/Area/AHU       filters.hierarchy_create   (a) FILTER_HIERARCHY_CREATE | ASSET_CREATE
 ├── Edit Hierarchy              filters.hierarchy_edit     (a) FILTER_HIERARCHY_EDIT | ASSET_UPDATE
 ├── Delete Hierarchy            filters.hierarchy_delete   (b) delete-block button uses ASSET_DELETE only — inconsistent
 ├── Bulk Upload                 filters.bulk_upload        (a) FILTER_BULK_UPLOAD | ASSET_CREATE
 ├── Retire                      filters.retire             (b) FE=FILTER_RETIRE, BE also accepts FILTER_OPERATE — mismatch
 ├── Replace                     filters.replace            (b) FE=FILTER_REPLACE, BE also accepts FILTER_OPERATE — mismatch
 ├── Status Update               filters.status_update      (b) FE=FILTER_STATUS_UPDATE, BE=ASSET_UPDATE — perm never enforced
 ├── RFID Manage                 filters.rfid_manage        (a) FILTER_RFID_MANAGE | ASSET_IDENTIFIER_*
 └── Export                      filters.export             (c) client-side

Retirement List                 (/filter-retirements)
 ├── View                        retirement.view            (b) ASSET_READ (shared)
 └── Export                      retirement.export          (c) THEATER — RETIREMENT_LIST_EXPORT has no backend gate

Replacement List                (/filter-replacements)
 ├── View                        replacement.view           (b) ASSET_READ (shared)
 ├── Export                      replacement.export         (c) THEATER — REPLACEMENT_LIST_EXPORT has no backend gate
 └── Schedule (sub-tab)          replacement_schedule.*     (a) REPLACEMENT_SCHEDULE_VIEW/UPLOAD/REVIEW/APPROVE

Filter Operations               (/filters)
 ├── Start Cycle                 operations.start           (a) FILTER_OPERATE + reauth
 ├── Advance Stage               operations.advance         (a) FILTER_OPERATE + reauth
 ├── Submit Checklist            operations.submit_checklist(a) FILTER_OPERATE + reauth (e-signature)
 ├── Bypass Stage                operations.bypass          (a) FILTER_BYPASS + reauth
 └── Terminate Cycle             operations.terminate       (b) shares FILTER_BYPASS — split if distinct control wanted
     (NOTE: whole page is FE-UNGATED today — buttons render for all, 403 on submit)

Checklists                      (/checklists)
 ├── View                        checklists.view            (a) FCP_READ | CHECKLIST_TOGGLE | VERSION_HISTORY_VIEW
 ├── Add                         checklists.create          (a) CHECKLIST_CREATE | FCP_CREATE (NOT theater)
 ├── Edit                        checklists.edit            (a) CHECKLIST_EDIT | FCP_UPDATE
 ├── Delete                      checklists.delete          (a) CHECKLIST_DELETE | FCP_DELETE
 ├── Enable / Disable            checklists.toggle          (b) THEATER — CHECKLIST_TOGGLE shown but PUT needs FCP_UPDATE|CHECKLIST_EDIT
 └── Manage Questions            checklists.manage_questions(a) FCP_*|CHECKLIST_* + reauth (on detail page)

Cleaning Profiles               (/filter-cleaning-profiles)
 ├── View                        cleaning_profiles.view     (a) FCP_READ | CP_TOGGLE | VERSION_HISTORY_VIEW
 ├── Add                         cleaning_profiles.create   (a) CP_PAGE_CREATE | FCP_CREATE (NOT theater)
 ├── Edit                        cleaning_profiles.edit     (a) CP_PAGE_EDIT | FCP_UPDATE
 ├── Delete                      cleaning_profiles.delete   (a) CP_PAGE_DELETE | FCP_DELETE + reauth
 └── Enable / Disable            cleaning_profiles.toggle   (b) THEATER — CP_TOGGLE shown but PATCH needs FCP_UPDATE|CP_PAGE_EDIT

Equipment Groups                (/config/equipment-groups)  [also a config card]
 ├── View                        equipment_groups.view      (a) EG_VIEW | ASSET_READ
 ├── Add                         equipment_groups.create    (a) EG_CREATE | ASSET_CREATE + reauth
 ├── Edit                        equipment_groups.edit      (a) EG_EDIT | ASSET_UPDATE + reauth
 ├── Enable / Disable            equipment_groups.toggle    (a) EG_EDIT | ASSET_UPDATE + reauth
 └── Delete                      equipment_groups.delete    (a) EG_DELETE | ASSET_DELETE + reauth

PM Schedules                    (/pm-schedules)
 ├── View                        pm.view                    (a) PM_READ
 ├── New Schedule                pm.create                  (a) PM_CREATE + reauth
 ├── Upload                      pm.upload                  (a) PM_UPLOAD | PM_CREATE + reauth (NOT theater)
 ├── Download Template           pm.download_template       (a) PM_DOWNLOAD_TEMPLATE | PM_READ (NOT theater)
 ├── Edit Entry                  pm.edit_entry              (a) PM_EDIT_ENTRY | PM_UPDATE + reauth (NOT theater)
 ├── Review                      pm.review                  (a) PM_REVIEW + assertPmRole + reauth
 ├── Approve                     pm.approve                 (a) PM_APPROVE + assertPmRole + reauth
 ├── Reject                      pm.reject                  (a) PM_APPROVE + reauth (shared w/ approve)
 ├── Resubmit                    pm.resubmit                (a) PM_RESUBMIT | PM_CREATE + reauth (NOT theater)
 ├── Delete                      pm.delete                  (b) FE=SUPER_ADMIN only, BE=PM_DELETE — mismatch
 └── Export                      pm.export                  (c) client-side

My Tasks                        (/my-tasks)
 ├── View                        my_tasks.view              (a) PM_READ | PM_EXECUTE | PM_APPROVE
 ├── Perform                     my_tasks.perform           (a) navigation only; real gate is FILTER_OPERATE downstream
 └── Acknowledge Overdue         my_tasks.acknowledge       (a) PM_READ + enforceReauthAlways

Approvals (Block Change)        (/approvals)
 ├── View                        block_change.view          (a) BLOCK_CHANGE_REQUEST | BLOCK_CHANGE_APPROVE
 ├── Approve                     block_change.approve       (a) BLOCK_CHANGE_APPROVE + reauth
 └── Reject                      block_change.reject        (a) BLOCK_CHANGE_APPROVE + reauth

Version History                 (/version-history)
 └── View                        version_history.view       (a) VERSION_HISTORY_VIEW (clean — all endpoints accept it)
```

### 2.2 Reports group (collapsible)

```
RFID Track Record               (/rfid-track-record)
 ├── View                        rfid_track.view            (b) ASSET_VIEW | FILTER_RFID_MANAGE (shared)
 └── Export                      rfid_track.export          (c) THEATER — no FE flag at all today

Filter Cleaning Record          (/cleaning-cycles)
 ├── View                        cleaning_record.view       (b) CYCLE_READ (shared across 3 report pages)
 └── Export                      cleaning_record.export     (c) FE=REPORT_EXPORT|REPORT_GENERATE, no backend export gate

Filter Lifecycle Report         (/filter-lifecycle-report)
 ├── View                        lifecycle.view             (b) CYCLE_READ (shared)
 └── Export                      lifecycle.export           (c) same as above

Deviations                      (/deviations)
 ├── View                        deviations.view            (b) PM_READ (route admits PM_APPROVE-only → empty page)
 └── Export                      deviations.export          (c) fail-open useExportOptions

Quality Notifications           (/quality-notifications)
 ├── View                        qnn.view                   (b) OPEN ROUTE — gated only by soft canSeeQnn role-list, no permission
 └── Export                      qnn.export                 (c) fail-open
```

### 2.3 Configuration sub-pages (children of the Configuration group)

Today gated by the `access-matrix` (UI-only, **fail-open**) + per-endpoint
`CONFIG_READ`/`CONFIG_UPDATE` or `requireRole('SUPER_ADMIN')`. Proposed: each becomes a
child node under Configuration, **default-deny**, mapping to its real gate.

| Config card | Route | Current gate | Proposed node(s) |
|---|---|---|---|
| General & Password | /config/password-policy | access-matrix + CONFIG_* | `config.password.view/edit` (a) |
| Date/Time Format | /config/datetime | access-matrix + CONFIG_* | `config.datetime.view/edit` (a) |
| Backup & Restore | /config/backup | CONFIG_* + BACKUP_* | `config.backup.view/run/restore` (a) — restore is BACKUP_RESTORE, excluded from MANAGE expansion |
| User ID Format | /config/user-id | access-matrix + CONFIG_* | `config.user_id.view/edit` (a) |
| Configuration Access | /config/access-matrix | SUPER_ADMIN | `config.access_matrix.manage` (a) |
| Schedule AHU Filters | /config/replacement-schedule-filters | SUPER_ADMIN | `config.replacement_filters.manage` (a) |
| Branding & Dashboard | /config/appearance | SUPER_ADMIN; **GET branding NO GATE** | `config.branding.view/edit` (b) — close open GET |
| Report Configuration | /config/report-config | SUPER_ADMIN | `config.report.view/edit` (a) |
| Tablet App Access | /config/tablet-access | CONFIG_* | `config.tablet_access.view/edit` (a) |
| Role & Access | /config/roles | SUPER_ADMIN / ROLE_MANAGE | `roles.*` — see §2.4 |
| Display Settings | /config/display-settings | SUPER_ADMIN | `config.display.view/edit` (a) |
| LDAP / AD | /config/ldap | CONFIG_* | `config.ldap.view/edit/test` (a) |
| Help Articles | /config/help | SUPER_ADMIN; **GET list NO GATE** | `config.help.view/create/edit/delete` (b) |
| Notification Rules | /config/notification-rules | SUPER_ADMIN + CONFIG_* | `config.notif_rules.view/create/edit/delete/toggle/test` (a) |
| Notification Channels | /config/email-settings | SUPER_ADMIN + CONFIG_* | `config.notif_channels.view/edit/test` (a) |
| Filter Data Management | /config/filter-data-management | EXPLICIT_GRANT + SUPER_ADMIN + reauth | `config.filter_data.view/edit/delete/restore` (a) |
| Filter Setup | /config/filter-setup | SUPER_ADMIN | `config.filter_setup.*` (a) — wrapper of 3 tabs |
| Role Assignments | /config/role-assignments | SUPER_ADMIN | `config.role_assignments.edit` (a) |
| Offline Cache & Lockout | /config/offline-cache | SUPER_ADMIN | `config.offline_cache.view/edit` (a) |

**Auto-discovered config defs** (`config/defs/*.def.ts`, ~34): already carry
`permissions:{read,write}`, `requiredRole`, `requiresReauth`. For `hasCustomPage:false`
defs, `dynamic-routes.ts:36-65` already auto-generates a permission-gated
`GET/PUT /api/config/dynamic/:moduleKey`. **Requirement 11 ("new page auto-supports
permissions") is already satisfied for these** — we extend the same auto-registration
to the sidebar catalog (§5.3).

### 2.4 Roles & Access page actions

```
Roles & Access                  (/config/roles)
 ├── View                        roles.view                 (a) ROLE_MANAGE
 ├── Create Role                 roles.create               (a) ROLE_MANAGE + reauth CREATE_ROLE
 ├── Edit Role                   roles.edit                 (a) ROLE_MANAGE + reauth UPDATE_ROLE
 ├── Delete Role                 roles.delete               (a) ROLE_MANAGE + reauth DELETE_ROLE
 ├── Assign Permissions          roles.assign_permissions   (b) Permissions tab writes via CONFIG_UPDATE, NOT ROLE_MANAGE — mismatch
 ├── Configure Sidebar           roles.configure_sidebar    (b) Sidebar tab writes via CONFIG_UPDATE — mismatch
 └── Configure Re-auth           roles.configure_reauth     (b) Re-auth tab writes via CONFIG_UPDATE — mismatch
```

> **Privilege-boundary bug:** a user with `CONFIG_UPDATE` but not `ROLE_MANAGE` can
> edit per-role permissions, sidebar visibility, and reauth policy through the
> Permissions/Sidebar/Re-auth tabs (the Save buttons only check dirty-state). This is
> a privilege-escalation surface — fixing it is in scope.

---

## 3. Gap analysis (requirements 9 & 10)

### 3.1 Security gaps (HIGH priority)

| # | Gap | Location | Risk |
|---|-----|----------|------|
| S1 | **Config access-matrix fails OPEN** — unconfigured module → allowed | `config/index.tsx:282` `canAccessModule` | New/unconfigured config pages visible to all roles |
| S2 | **Open route** `/quality-notifications` (no `RequireRole`) | `main.tsx:222` | URL-reachable; only soft `canSeeQnn` role-list, no permission |
| S3 | **Open route** `/checklist/:entityId` | `main.tsx:265` | Auth handled inside component only |
| S4 | **Report Reviews GET endpoints have NO permission gate** | `report-reviews/routes.ts:34,42,54` | Any logged-in user reads review queue/snapshots by URL |
| S5 | **Notifications single-delete has no `requirePermission`** (only reauth) | `notifications/routes.ts:243` | Asymmetric vs bulk-delete (`NOTIFICATION_DELETE`) |
| S6 | **Dashboard route entirely UNGATED** | `main.tsx:165` | Relies on per-card config + client `isAdmin` only |
| S7 | **`GET /api/config/branding` ungated; help list/`:key` ungated; `/tablet-access/my-features`, `/access-matrix/my-modules`, `/api/roles/active` ungated** | various | Minor info disclosure |
| S8 | **`useExportOptions` is fail-open** | `use-export-options.ts:6-16` | Unknown role/surface → both export formats shown |

#### Phase 2 closure status (2026-06-30)
| Gap | Status | Note |
|---|---|---|
| S1 | ✅ **CLOSED** | default-DENY (`can-access-module.ts`, 7 unit tests) + `access-matrix` seed for ADMIN (`seed.ts`). Commits `cdc2fe8`+`78a8482`. |
| S2 | ⚪ **NOT A GAP** (verified) | `/quality-notifications` already 403s server-side via `canSeeQnn`; client self-guards. No dedicated permission exists; FE guard would be cosmetic + risk drift. Left as-is. |
| S3 | 🟡 **MOOT / logged** | `/checklist/:entityId` is a DEAD page (submit endpoint `POST /api/data/checklist` removed in Phase 7; orphaned). Guarding it is pointless. Logged in `tasks/todo.md` for remove-vs-rebuild decision. |
| S4 | ✅ **CLOSED** | 3 GETs gated `REPORT_REVIEW_SUBMIT\|REPORT_REVIEW\|REPORT_APPROVE`. Commit `293796b`. |
| S5 | ✅ **CLOSED** | single-delete gated `NOTIFICATION_DELETE` (matches bulk; UI already admin-only). Commit `15f9939`. |
| S6 | ⚪ **NOT A GAP** (verified) | Dashboard `/` must stay all-authenticated (landing + catch-all redirect target). Gating any permission would lock minimal roles out. |
| S7 | ⚪ **MOSTLY INTENTIONAL** | `branding` + `roles/active` truly public (login theming / pre-auth contact-admin); `tablet-access/my-features` + `access-matrix/my-modules` self-scoped (consumed at login gate). **Only help GETs were a real exposure** → ✅ CLOSED with `CONFIG_READ` (commit `6bd2b9c`). |
| S8 | ⚪ **NOT A SECURITY CONTROL** | `useExportOptions` fail-open is a UI affordance; real export enforcement (if wanted) belongs on backend export endpoints (most are client-side PDF, no endpoint). Documented, no change. |

> **Runtime verification owed** (Phase 2 changes are behavior-affecting): curl 403/200 with an unauthorized vs authorized token for the gated endpoints, and a fresh-install seed run confirming ADMIN keeps the 4 config cards. The current dev DB is unaffected (its `access-matrix` row was already populated). FE/BE mismatches M1–M6 below remain for Phase 3.

### 3.2 FE/BE mismatches (button hidden but API reachable — MEDIUM)

| # | Action | FE gate | BE gate | Effect |
|---|--------|---------|---------|--------|
| M1 | Filter Status Update | `FILTER_STATUS_UPDATE` | `ASSET_UPDATE` | `FILTER_STATUS_UPDATE` never enforced; ASSET_UPDATE holder can PATCH directly |
| M2 | Retire / Replace | `FILTER_RETIRE`/`FILTER_REPLACE` | also accepts `FILTER_OPERATE` | Operators can retire/replace via API despite hidden button |
| M3 | User Delete / Bulk delete | SUPER_ADMIN only | `USER_DELETE` | `USER_DELETE` holder blocked in UI but can delete via API |
| M4 | PM Delete | SUPER_ADMIN only | `PM_DELETE` | `PM_DELETE` holder has no UI but can delete via API |
| M5 | Notifications delete | SUPER_ADMIN only | bulk=`NOTIFICATION_DELETE` | `NOTIFICATION_DELETE` holder blocked in UI |
| M6 | Roles Permissions/Sidebar/Re-auth tabs | none (dirty only) | `CONFIG_UPDATE` | `CONFIG_UPDATE`-without-`ROLE_MANAGE` can edit role permissions (escalation) |

#### Phase 3 closure status (2026-06-30) — direction: TIGHTEN backend (user decision)
| # | Status | Resolution |
|---|---|---|
| M1 | ✅ **CLOSED** | PATCH lifecycle-state → `FILTER_STATUS_UPDATE` (was ASSET_UPDATE). Commit `3968ec3`. |
| M2 | ✅ **CLOSED** | retire/replace → `FILTER_RETIRE`/`FILTER_REPLACE` (dropped FILTER_OPERATE fallback). Commit `648c054`. |
| M3 | ✅ **CLOSED** | user delete + bulk → `requireSuperAdmin()`. Commit `cf3a24e`. |
| M4 | ✅ **CLOSED** | PM delete → `requireSuperAdmin()`. Commit `44f27ec`. |
| M5 | ✅ **CLOSED** | notification delete + bulk → `requireSuperAdmin()` (supersedes Phase 2 S5). Commit `b00a07f`. |
| M6 | ✅ **CLOSED** | role/user/reauth config edits → `ROLE_MANAGE` (was CONFIG_UPDATE). Commit `7237a90`. FE already behind ROLE_MANAGE/SA route guards. |
| — | ✅ | Vestigial `USER_DELETE`/`PM_DELETE`/`NOTIFICATION_DELETE` removed from ADMIN seed (`259b963`); SUPER_ADMIN retains. |

> **Review:** 0 test regressions (all tests hitting these endpoints use SUPER_ADMIN tokens, which bypass), legitimate UI access preserved — changes remove only API-only bypass from roles that never had the button. **Runtime curl 403/200 verification owed.** Phase 4 (per-page View granularity) + Phase 5 (tree UI + `useCan()`) + Phase 6 (cleanup) remain.

### 3.3 Theater (frontend gate with no real backend control — MEDIUM)

| # | Permission | Why theater | Resolution |
|---|------------|-------------|------------|
| T1 | `AUDIT_EXPORT` | client-side jsPDF over `AUDIT_READ` data | Either accept as cosmetic (c) OR add a server-side export endpoint to gate (b→a) |
| T2 | `RETIREMENT_LIST_EXPORT` | client-side, data from `ASSET_READ` list | same |
| T3 | `REPLACEMENT_LIST_EXPORT` | client-side | same |
| T4 | cleaning-record / lifecycle export (`REPORT_EXPORT`/`REPORT_GENERATE`) | client-side PDF | same |
| T5 | `CHECKLIST_TOGGLE` | toggle PUT requires `FCP_UPDATE`/`CHECKLIST_EDIT` | align FE flag OR accept toggle under edit |
| T6 | `CP_TOGGLE` | toggle PATCH requires `FCP_UPDATE`/`CP_PAGE_EDIT` | same |
| T7 | Debug operation-trace toggle | endpoint is a vestigial no-op | retire the toggle or wire it |

> **Note:** the memory claiming `CHECKLIST_*`, `CP_PAGE_*`, `EG_*`,
> `PM_UPLOAD/DOWNLOAD_TEMPLATE/EDIT_ENTRY/RESUBMIT` are frontend-only theater is
> **incorrect** — verified that backend honors them via
> `requireAnyPermission(<base>, <flag>)`. Only `CHECKLIST_TOGGLE`/`CP_TOGGLE` (T5/T6)
> are true theater.

### 3.4 Dead / orphaned

| # | Item | Note |
|---|------|------|
| D1 | `DASHBOARD_VIEW/CREATE/MANAGE/ASSIGN` (4 perms) + entire `/api/dashboards` CRUD | No frontend consumes it (`dashboards/routes.ts` header confirms parked). Decide: retire perms or wire UI. |
| D2 | `SEND_FOR_REVIEW_ENABLED=false` → `POST /api/report-reviews/` (`REPORT_REVIEW_SUBMIT`) unreachable | The submit gate guards a button that renders nothing. |
| D3 | `handleToggleEntityTracing` (debug) | Dead frontend handler, no caller, no-op endpoint. |

### 3.5 Consistency / data issues

- **Hierarchy mismatch:** `roles.ts` `DEFAULT_ROLE_HIERARCHY` (SUPERVISOR=3…VIEWER=0)
  disagrees with `seed.ts` (SUPERVISOR=4…VIEWER=1). Pick one source.
- **Route guard ⊋ data-API permission:** Deviations, Cleaning Record, Lifecycle Report
  admit users (e.g. `VERSION_HISTORY_VIEW`-only, `PM_APPROVE`-only) whose data they
  cannot load → empty page. Align route guard to the actual data gate.
- **Shared broad read perms** (`ASSET_READ`, `CYCLE_READ`) prevent true per-page View
  control (the **(b)** view nodes).

---

## 4. Proposed target architecture

### 4.1 Single catalog, layered on the enforced vocabulary

```
                 ┌──────────────────────────────────────────────┐
                 │  PERMISSION_TREE  (NEW — single catalog)       │
                 │  Sidebar group → Page → Action node            │
                 │  node = {                                      │
                 │    id: 'users.delete',          // dotted      │
                 │    sidebar: 'Users', page, label, action,      │
                 │    permissions: ['USER_DELETE'], // enforced   │
                 │    reauthAction?: 'DELETE_USER',               │
                 │    apiRoutes: ['DELETE /api/users/:id'],       │
                 │    enforce: 'a'|'b'|'c',                        │
                 │  }                                             │
                 └───────────────┬──────────────────────────────┘
        derives ───────┬─────────┼───────────┬────────────────┐
                       ▼         ▼            ▼                ▼
              Sidebar visibility  Route guard  Button gating   Admin UI tree
              (replaces           (RequireRole (useCan() hook  (replaces flat
               SIDEBAR_*_MAP)      perms)       — NEW)          checkbox list)
                       │
                       ▼ enforced by (unchanged)
              Backend gates: requirePermission('USER_DELETE')
              hasEffectivePermission()  ← canonical, untouched
```

**Key:** `PERMISSIONS` (uppercase) remains the **enforced** vocabulary. The tree's
`permissions: [...]` field is the existing `FEATURE_TO_PERMISSION_MAP` content,
**absorbed into the tree** so there is one source instead of three
(`FEATURE_PRIVILEGES` + `FEATURE_TO_PERMISSION_MAP` + `SIDEBAR_PRIVILEGE_MAP`).

### 4.2 CFR constraints baked in

1. **Default-DENY.** New/unconfigured nodes default to **no access**. Auto-register the
   *node*, never auto-grant it. This directly fixes S1 (the fail-open access-matrix).
2. **Alias, don't delete.** Old `PERMISSIONS` strings stay as enforced aliases. The
   audit trail's historical permission references keep resolving. No string is removed.
3. **Reauth stays orthogonal.** It answers "must you re-sign," not "are you allowed."
   The tree *cross-links* each action's `reauthAction` so the admin UI shows both axes
   side by side, but they remain separate config (`action-reauth` SystemConfig).
4. **Roles preserved.** All 6 system roles + any custom roles keep their exact
   effective permissions on migration (§7).

### 4.3 The `useCan()` hook (NEW — fixes ad-hoc button gating)

A single frontend hook replaces the scattered `isSuperAdmin || perms.includes('X')`:

```ts
const can = useCan();
can('users.delete')   // resolves node → permissions[] → SUPER_ADMIN bypass → perms.includes
```

Every button/row-action/bulk-action references `can('<node id>')`. This makes button
gating consistent, auditable, and impossible to silently forget.

---

## 5. Required changes

### 5.1 Database

- **Minimal.** Storage model (`Role.permissions` JsonB string array) is kept — it
  already stores enforced `PERMISSIONS` strings. No new tables required for approach B.
- **Optional (recommended) cleanup:** drop the parallel `access-matrix` SystemConfig
  row once config cards move to the tree (S1). Keep historical audit rows.
- **Reconcile** `seed.ts` vs `roles.ts` hierarchy numbers (one migration/update).
- **No `prisma db push --accept-data-loss`** needed.

### 5.2 Shared package (`packages/shared`)

- **NEW** `permission-tree.ts` — the single catalog (§2). Generated to also export
  back-compat `FEATURE_PRIVILEGES`, `FEATURE_TO_PERMISSION_MAP`, `SIDEBAR_PRIVILEGE_MAP`
  shapes so nothing breaks during migration.
- Keep `permissions.ts`, `reauth-actions.ts` as-is (canonical enforced + reauth).
- Add NEW narrow `PERMISSIONS` for the **(b)** nodes that need real gates (e.g.
  `REPORT_REVIEW_READ`, per-page report read splits if you want true per-page View).
- `npm run build -w @digilog/shared` after every change (per project rule).

### 5.3 Backend (`apps/api`)

- **Close open gates (S2–S7):** add `requirePermission`/route guards to
  `/report-reviews` GETs, notifications single-delete, branding/help GET, qnn route.
- **Fix mismatches (M1–M6):** align backend gate to the intended per-action permission
  (e.g. make status-update accept `FILTER_STATUS_UPDATE`; make Roles
  Permissions/Sidebar/Re-auth tab endpoints require `ROLE_MANAGE` not bare
  `CONFIG_UPDATE`).
- **(b)→(a) for export theater (optional):** if true export control is wanted, add
  server-side export endpoints to gate; otherwise mark (c) and document.
- **Auto-register sidebar nodes** the same way config defs self-register
  (`config-discovery.ts` pattern) so requirement 11 holds for sidebar pages too.
- Retire or wire the dead `DASHBOARD_*` family (D1).

### 5.4 Frontend (`apps/web`)

- **NEW** `useCan()` hook + refactor every page's button gating to use it.
- **Sidebar** (`sidebar.tsx`): resolve visibility from the tree instead of
  `SIDEBAR_PRIVILEGE_MAP`.
- **Route guards** (`main.tsx`): wrap the 2 open routes; align over-permissive guards
  to their data-API permission.
- **Config index** (`config/index.tsx`): replace fail-open `access-matrix` card gating
  with tree-driven, default-deny gating.
- **Roles & Access admin UI** (`role-access.tsx` + `permissions-tab.tsx`): render the
  hierarchical tree (Sidebar → Page → Action) with per-page "select all", instead of
  the flat category checkbox list. Show the cross-linked reauth toggle per action.

### 5.5 Files to modify (inventory)

**Shared:** `permission-tree.ts` (new), `feature-privileges.ts`, `sidebar-privilege-map.ts`, `permissions.ts` (additions only), `sidebar-items.ts`, `roles.ts` (hierarchy).
**Backend:** `plugins/rbac.ts` (resolver), `modules/report-reviews/routes.ts`, `modules/notifications/routes.ts`, `modules/config/static-routes/{branding,access-matrix}.routes.ts`, `modules/help/routes.ts`, `modules/pm-schedules/routes.ts` (qnn), `modules/filter-operations/routes.ts` (status/retire/replace gates), `modules/config/static-routes/roles.routes.ts` + `action-reauth.routes.ts` (ROLE_MANAGE), `prisma/seed.ts` (hierarchy + role arrays), `lib/config-discovery.ts` (sidebar auto-register).
**Frontend:** `hooks/use-can.ts` (new), `components/layout/sidebar.tsx`, `main.tsx`, `routes/config/index.tsx`, `routes/config/role-access.tsx` + `roles-components/*`, and per-page button refactors (users, filters, notifications, audit, pm-schedules, etc. — ~20 pages).

---

## 6. Canonical vocabulary direction — DECIDED (2026-06-30)

**DECISION: uppercase `PERMISSIONS` stays canonical/enforced; the dotted sidebar tree
is a catalog layer on top.** Approved by user 2026-06-30.

Rationale: every backend gate (`requirePermission('X')`) and route guard
(`RequireRole permissions={[PERMISSIONS.X]}`) already speaks uppercase, so Phase 1
changes **zero** enforcement code — it only adds the catalog. The audit trail
references these exact strings, so on a validated 21 CFR Part 11 system this keeps the
compliance surface intact (no re-validation). The dotted-canonical alternative was
rejected: high-churn (hundreds of call-sites), high-risk, no functional benefit.

---

## 7. Role migration (preserve all access)

Phase 1 produces a **before/after effective-permission diff per role**. For each of
SUPER_ADMIN, ADMIN, SUPERVISOR, MAINTENANCE, OPERATOR, VIEWER (+ any custom roles), we
assert the new tree resolves to the **exact same** set of enforced `PERMISSIONS` the
role has today. Zero rows change meaning. SUPER_ADMIN bypass is unchanged. This diff is
the 21 CFR proof that nobody gained or lost access in the consolidation.

---

## 8. Implementation plan (phases — each independently shippable & approvable)

> The line-by-line plan comes *after* you approve this report (via the writing-plans
> step). This is the phase outline only.

- **Phase 0 — Reconcile & freeze.** Fix the `seed.ts`/`roles.ts` hierarchy mismatch;
  snapshot current effective permissions per role (the migration baseline). No behavior
  change.
- **Phase 1 — Build the catalog, zero behavior change.** Add `permission-tree.ts`;
  derive the existing `FEATURE_PRIVILEGES`/`SIDEBAR_PRIVILEGE_MAP`/`FEATURE_TO_PERMISSION_MAP`
  from it; add `useCan()`. **Assert** every role's effective permissions and every
  route's guard are byte-for-byte identical before/after. Ship behind no flag — it's a
  no-op refactor. **This is the CFR-safe foundation.**
- **Phase 2 — Close security gaps (S1–S8).** Default-deny config gating; wrap the 2
  open routes; gate Report Reviews GETs + notifications single-delete + branding/help
  GETs; fix fail-open exports. Each is a small, testable, self-contained fix.
- **Phase 3 — Fix FE/BE mismatches (M1–M6).** Align backend gates to intended
  per-action permissions; fix the Roles-tab `CONFIG_UPDATE` escalation.
- **Phase 4 — Per-page View granularity (the (b) view nodes).** Introduce narrow read
  permissions where pages currently share `ASSET_READ`/`CYCLE_READ`, IF you want true
  per-page View control. (Optional — bigger surface; can be deferred.)
- **Phase 5 — New Roles & Access tree UI.** Replace the flat checkbox list with the
  hierarchical Sidebar→Page→Action tree + cross-linked reauth.
- **Phase 6 — Cleanup & docs.** Retire/wire dead `DASHBOARD_*`; update CLAUDE.md,
  CHANGELOG, counts, memory; deprecate the absorbed maps.

Each phase: list touchpoints → change → test all touchpoints (curl APIs + UI) →
verify before/after permission diff → only then mark done (per CLAUDE.md correctness
rule).

---

## 9. Honest risk notes

- This is a **multi-week** effort touching the security core of a validated CFR system.
  Approach B keeps each phase small and reversible; Phase 1 being a proven no-op is what
  makes it safe.
- The **(c) cosmetic export** actions can never be true backend controls without new
  export endpoints — the report does not pretend otherwise.
- True **per-page View** control (Phase 4) is the only part that needs real new backend
  gates and is genuinely larger; it's isolated and optional.
- Nothing here removes a permission string or an audit-action registry entry (CFR
  inspector contract preserved).
