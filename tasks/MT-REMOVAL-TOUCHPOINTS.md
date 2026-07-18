# Multi-Tenancy Removal — Touchpoint Inventory

**Decision recorded 2026-04-30:** DigiLog → single-tenant, single-site, single-company. No `Site` substitute, no `Tenant` substitute. Drop the entire MT layer.

**Standing rules in force:**
- Existing data wipe permitted (Postgres reset + reseed)
- Schema rebuild permitted (no migrations needed; `prisma db push --force-reset`)
- Operational expectation must hold: every feature still works for SUPER_ADMIN / ADMIN / OPERATOR / VIEWER (ORG_ADMIN role gets retired)
- Do not commit until told (Q4 standing)

This document is the master pre-flight checklist. Implementation must touch every item below; the e2e test pass at the end re-verifies nothing was missed.

---

## 1 — Schema (`apps/api/prisma/schema.prisma`)

### 1.1 Models to delete entirely
- `model Organization` (line 28) — root MT model

### 1.2 `organizationId` columns to drop (11 models)
| Model | Lines |
|---|---|
| User | 63, 68 (relation), 72 (index) |
| AssetInstance | 82, 89 (relation), 94 (index) |
| AssetTemplate | 147, 155 (index) |
| FilterCleaningProfile | 197, 226 (index) |
| FilterProfile | 462 |
| ChecklistProfile | 525, 562 (composite index `[organizationId, currentLifecycleState]`) |
| BlockChangeRequest | 1304, 1321 (composite index) |
| EquipmentGroup | 1371, 1379 (composite index) |
| EntityAssignment | 1463, 1474 (composite index) |
| TemplateAssignment | 1524, 1532 (composite index) |
| DashboardAssignment | 1581, 1586 (composite index `[status, organizationId]`) |

### 1.3 `orgId` columns to drop (2 models — Phase 5 reports module)
| Model | Lines |
|---|---|
| ReportTemplate | 1615, 1616 (relation), 1625 (index) |
| ReportInstance | 1664, 1665 (relation), 1672 (index) |

### 1.4 Composite indexes to redefine
After dropping `organizationId`/`orgId`, the composite indexes lose their first column. Re-create as single-column indexes on the remaining field where the second column is still relevant (e.g. `[currentLifecycleState]` on ChecklistProfile, `[status]` on BlockChangeRequest/DashboardAssignment, `[isActive]` on EquipmentGroup/EntityAssignment/TemplateAssignment).

### 1.5 Enum cleanup
- `RoleScope` enum has values `GLOBAL | ORGANIZATION` — keep enum, but remove `ORGANIZATION` value. Touchpoint: `packages/shared/src/types/roles.ts` line 56.

---

## 2 — Backend (34 files matched `organizationId`)

### 2.1 Modules to DELETE entirely
- `apps/api/src/modules/org-admin/` (whole module — org-scoped admin operations)
- `apps/api/src/modules/tenant-admin/` (whole module — cross-org admin operations)

### 2.2 Helpers / infra to DELETE
- `apps/api/src/lib/org-scope.ts` — exports `orgWhere(ctx)` used in 28 files; delete file
- `apps/api/src/lib/jwt.ts` line 26 — drop `organizationId?: string` from JWT payload type
- `apps/api/src/types/context.ts` line 12 — drop `organizationId?` from request context
- `apps/api/src/lib/build-context.ts` line 16 — drop `organizationId: req.user.organizationId`

### 2.3 Files to UPDATE (drop `orgWhere(ctx)` + any direct `organizationId` reads/writes)
| File | What changes |
|---|---|
| `apps/api/src/plugins/auth.ts` | Remove org pinning from JWT verifier; drop `requireSameOrg`-style guards if present |
| `apps/api/src/plugins/__tests__/auth.plugin.test.ts` | Drop org-scoped test cases |
| `apps/api/src/modules/auth/auth.service.ts` | Drop `organizationId` from login response + token claims |
| `apps/api/src/modules/auth/auth.repository.ts` | Drop `organizationId` from User select |
| `apps/api/src/modules/auth/routes.ts` | Drop `/api/auth/switch-org` if present; clean response shape |
| `apps/api/src/modules/users/routes.ts` | Drop org filter from list query; drop org from user create/edit |
| `apps/api/src/modules/users/user.repository.ts` | Drop `organizationId` from filters + create payload |
| `apps/api/src/modules/users/user.service.ts` | Same |
| `apps/api/src/modules/admin-requests/admin-request.service.ts` | Drop org scope on requests |
| `apps/api/src/modules/assets/routes/instance.routes.ts` | Drop org scope on entity list; drop org from create |
| `apps/api/src/modules/assets/routes/template.routes.ts` | Drop org scope on template list |
| `apps/api/src/modules/assets/services/instance.service.ts` | Drop parent-org-inheritance + `organizationId` writes; remove the helper added during Step 0 |
| `apps/api/src/modules/assets/services/__tests__/instance.service.test.ts` | Drop the parent-org-inheritance test path; clean mock to match |
| `apps/api/src/modules/assets/services/bulk-upload-filter.service.ts` | Drop org scope |
| `apps/api/src/modules/block-change-requests/block-change.service.ts` | Drop org scope |
| `apps/api/src/modules/checklist-profiles/checklist-profile.service.ts` | Drop org scope |
| `apps/api/src/modules/cleaning-profiles/cleaning-profile.service.ts` | Drop org scope |
| `apps/api/src/modules/dashboards/routes.ts` | Drop org scope from dashboard assignment routes |
| `apps/api/src/modules/entity-assignments/routes.ts` | Drop org scope; route may be removed entirely if it was only for org-admin |
| `apps/api/src/modules/equipment-groups/equipment-groups.service.ts` | Drop org scope |
| `apps/api/src/modules/filter-operations/filter-operations.service.ts` | Drop org scope on cycle/event reads |
| `apps/api/src/modules/filter-profiles/filter-profile.service.ts` | Drop org scope |
| `apps/api/src/modules/ldap/ldap.service.ts` | Drop org-scoped LDAP-user create |
| `apps/api/src/modules/pm-schedules/pm-schedule.service.ts` | Drop org scope |
| `apps/api/src/modules/report-templates/report-template.service.ts` | Drop `orgId` scope |
| `apps/api/src/modules/reports/service.ts` | Drop `orgId` scope |
| `apps/api/src/modules/super-admin/routes.ts` | Drop org switcher endpoints |

### 2.4 Module count delta
- Before: 38 modules
- After: 36 modules (-org-admin, -tenant-admin)
- (TemplateKinds added in Step 1 stays at +1; net = 36)

---

## 3 — Frontend (12 files matched org refs)

### 3.1 Routes to DELETE
- `apps/web/src/routes/tenant/organizations.tsx` (Organizations list page)
- `apps/web/src/routes/tenant/org-detail.tsx` (Organization detail page)
- The whole `apps/web/src/routes/tenant/` folder if it has no other routes

### 3.2 Files to UPDATE
| File | What changes |
|---|---|
| `apps/web/src/main.tsx` | Drop `/organizations` + `/organizations/:id` routes |
| `apps/web/src/components/layout/sidebar.tsx` | Drop "Organizations" nav item |
| `apps/web/src/hooks/use-auth.ts` | Drop `organizationId` from User type + JWT decode |
| `apps/web/src/routes/users/create.tsx` | Drop "Organization" dropdown from form |
| `apps/web/src/routes/users/edit.tsx` | Same |
| `apps/web/src/routes/users/list.tsx` | Drop org column / filter |
| `apps/web/src/routes/assets/components/tabs/assignments-tab.tsx` | This was added during the deep-fix work for org assignments; consider whether it remains useful (it was for entity-level org assignments — no longer needed). Probably **delete the file**. |
| `apps/web/src/routes/filter-management/ahu-dashboard.tsx` | Drop org filter on AHU group reads |
| `apps/web/src/routes/config/ldap.tsx` | Drop org-scoped LDAP config |
| `apps/web/src/types/filter.ts` | Drop `organizationId` from Filter type |

### 3.3 Sidebar item count delta
Before: 26 sidebar items. Drop "Organizations" → 25.

---

## 4 — Shared package (`packages/shared/`)

### 4.1 Permissions (`src/types/permissions.ts`)
Drop these constants (lines 4-7):
- `ORG_MANAGE`
- `ORG_VIEW`
- `ORG_CREATE`
- `ORG_DELETE`

Permission count: 109 → **105**

### 4.2 Feature privileges (`src/types/feature-privileges.ts`)
Drop entries:
- `org.view` (line 35) + its mapping (line 187)
- `org.manage` (line 36) + its mapping (line 188)

Privilege count: 91 → **89**

### 4.3 Roles (`src/types/roles.ts`)
- Drop `ORG_ADMIN` from `DEFAULT_ROLES` (line 6)
- Drop `ORG_ADMIN: 4` from `ROLE_HIERARCHY` (line 40)
- Drop `ORG_ADMIN: 'ORGANIZATION'` from `ROLE_SCOPES` (line 54)
- Drop `ORG_ADMIN` from each role's role-list array in `MANAGEABLE_ROLES_BY_ROLE` (lines 65-67)
- Drop `'ORGANIZATION'` from `RoleScope` type (line 56)

### 4.4 User schemas (`src/schemas/users.ts`)
- Line 12 — drop `organizationId: z.string().uuid().optional()` from create schema
- Line 24 — drop same from update schema

### 4.5 Sidebar items (`src/types/sidebar-items.ts`)
- Line 37 — drop `'organizations'` entry
- Sidebar item count: 26 → **25**

---

## 5 — Seed (`apps/api/prisma/seed.ts`)
Currently the seed does NOT reference Organization rows directly (verified via grep). However:
- The vitest globalSetup file (`apps/api/vitest.global-setup.ts`) auto-creates a "System" org when none exists; **drop that block**.
- Any user-create paths in the seed that pass `organizationId` should be cleaned up.

---

## 6 — Tests
| File | What changes |
|---|---|
| `apps/api/src/modules/assets/services/__tests__/instance.service.test.ts` | Drop the "creates instance with parent and inherits parent org" test path; clean the mock that now references `findUnique` for org lookup |
| `apps/api/src/plugins/__tests__/auth.plugin.test.ts` | Drop org-scoped test cases |
| `apps/api/vitest.global-setup.ts` | Drop "System" Organization auto-create block (lines ~62-70) |

---

## 7 — Documentation sync (per `feedback_doc_sync_each_phase`)

Files to update with new counts after MT removal:
- `CLAUDE.md` (root) — system stats: 65 → **64 models**, 38 → **36 modules**, 109 → **105 permissions**, 91 → **89 privileges**, 26 → **25 sidebar items**, 27 → **27 config pages** (template-kinds stays)
- `apps/api/CLAUDE.md` — same counts; module list
- `apps/web/CLAUDE.md` — sidebar count
- `packages/shared/CLAUDE.md` — permission/privilege/sidebar counts
- `BACKEND_GUIDE.md`
- `API_REFERENCE.md` — drop `/api/org-admin/*` + `/api/tenant-admin/*` endpoints
- `FRONTEND_GUIDE.md` — drop Organizations page reference
- `PROJECT_SUMMARY.md`
- `PROJECT_ARCHITECTURE.md` — drop the multi-tenancy section
- `windowsIssues.md` — N/A (no MT-specific issue)
- `CHANGELOG.md` — add MT-removal entry
- `tasks/todo.md` — audit-log entry
- `future/architectural-refactor-9-steps.md` — mark Step 3 (organizationId NOT NULL) as **OBSOLETE — superseded by MT removal**

---

## 8 — Risk register

| Risk | Mitigation |
|---|---|
| Composite index drop causes implicit query plan change | Replace each composite with a single-column index on the remaining column where useful |
| Some modules use `organizationId` for *non-org* purposes (e.g. equipment-groups treats it as a "site" tag) | Re-read each service after the inventory; if any code is using `organizationId` as a site/zone tag, flag it before deletion. **None found in this inventory** — all uses are pure MT scoping |
| Existing audit trail rows reference deleted Organization rows | Audit table doesn't have FK to Organization; rows just reference the actor user. Safe |
| Frontend cached SW bundle may serve old code | Standard SW unregister + cache clear after rebuild (lesson learned during Step 1) |
| `RoleScope = 'ORGANIZATION'` may be referenced by dynamic roles in the seeded `roles` table | Reseed the roles table as part of `prisma db push --force-reset` |
| Reauth actions referencing `ORGANIZATION_*` actions | Verified: none exist in `reauth-actions.ts`. Safe |

---

## 9 — Order of operations

1. **Schema** — edit `schema.prisma`, drop models / columns / relations / indexes
2. **Shared** — drop permissions / privileges / roles / sidebar items / user-schema fields
3. **Build shared** — `npx nx build shared` so backend + frontend pick up clean types
4. **Backend** — delete org-admin / tenant-admin modules; rip out `orgWhere(ctx)`; drop org from JWT/context/auth
5. **Frontend** — delete tenant routes; drop sidebar item; drop user-form org dropdown; drop org column on lists
6. **Seed + globalSetup** — drop org auto-create
7. **DB reset + reseed** — `prisma db push --force-reset` + `npx tsx prisma/seed.ts`
8. **Build web** — `npx vite build` (preview mode in this worktree)
9. **Service worker** — unregister + clear caches in browser before re-test
10. **E2E test pass** — Playwright run for SUPER_ADMIN + ADMIN + OPERATOR + VIEWER:
    - Login flow
    - Dashboard
    - Entities list + create
    - Entity Templates list + create
    - Filter Management (block list + filter operations + cleaning cycle)
    - Audit Trail
    - Configuration (every config tab)
    - Notifications
    - PM Schedules + My Tasks + Approvals
    - Reports + Report Templates
11. **Doc sync** — every file in §7 above
12. **Stop**, hand back to user. Do not commit.
