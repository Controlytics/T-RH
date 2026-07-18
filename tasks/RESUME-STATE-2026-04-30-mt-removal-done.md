# Resume State — 2026-04-30 — Step 1 + MT Removal complete (uncommitted)

## TL;DR for next session

Two large refactors are **done in code and verified end-to-end in the UI** but **not yet committed**:

1. **Step 1 of the 9-step architectural refactor** — admin-editable `TemplateKind` lookup table (replaces closed Prisma enum). Includes one inline-edit UX fix and one role-gating fix on `/assets/templates`.
2. **Multi-tenancy removal** — DigiLog is now single-tenant, single-site, single-company. `Organization` model + 11 `organizationId` columns + 2 `orgId` columns + `org-admin`/`tenant-admin` modules + 4 `ORG_*` permissions + `ORG_ADMIN` role + Organizations sidebar + page all gone. JWT `scope` always stamps `GLOBAL`.

Plus 3 bugs caught during the post-MT-removal e2e walk and fixed:
- `/pm-schedules` React error #300 crash (hook-order bug from early-return-before-hooks)
- `/my-tasks` misleading red "Failed to load tasks" toast when PM disabled
- Any unknown URL rendered blank (added `<Route path="*">` redirect to `/`)

**Branch:** `feature/phase5-verification` in worktree `.worktrees/phase5-verification` (branched from `windows_dep`).
**Q4 standing rule:** do not commit until told. Working tree has all changes uncommitted.
**Last live verification:** `npx prisma validate` ✅, `npx tsc --noEmit` (api) exits 0, `npx vite build` (web) exits 0, Playwright walked 23+ pages with no crashes.

---

## Live counts (verified post-MT-removal, post-Step-1)

| Metric | Value | Verification command |
|---|---|---|
| Models | **64** | `grep -cE "^model " apps/api/prisma/schema.prisma` |
| Enums | **22** | `grep -cE "^enum " apps/api/prisma/schema.prisma` |
| Permissions | **105** | `grep -cE "^\\s+[A-Z_]+:" packages/shared/src/types/permissions.ts` |
| Privileges | **89** | `grep -cE "id:.*label:.*category" packages/shared/src/types/feature-privileges.ts` |
| Reauth actions | **81** | `grep -cE "^\\s+[A-Z_]+:" packages/shared/src/types/reauth-actions.ts` |
| Sidebar items | **25** | `grep -cE "\\{ id:" packages/shared/src/types/sidebar-items.ts` |
| API modules | **36** | `ls apps/api/src/modules/ \| wc -l` |
| Config defs | **30** | `ls apps/api/src/modules/config/defs/*.def.ts \| wc -l` |
| Config pages | **27** | `ls apps/web/src/routes/config/*.tsx \| wc -l` |

---

## What changed at the file level

### Step 1 — TemplateKind lookup
- `apps/api/prisma/schema.prisma` — `enum TemplateKind` removed; `model TemplateKind` added; `AssetTemplate.templateKind` is now `String` FK
- `apps/api/src/modules/template-kinds/routes.ts` — NEW CRUD module
- `apps/api/src/modules/assets/services/template.service.ts` — `assertTemplateKindExists()` helper
- `apps/api/src/modules/assets/repositories/template.repository.ts` — bug fix: `templateKind` was being silently dropped on create
- `apps/api/prisma/seed.ts` — seeds 6 system kinds
- `packages/shared/src/schemas/assets.ts` — `SYSTEM_TEMPLATE_KIND_CODES`, `templateKindCodeSchema`, etc.
- `apps/web/src/routes/config/template-kinds.tsx` — NEW Configuration page (with inline-edit UX fix replacing window.prompt())
- `apps/web/src/routes/assets/templates.tsx` — Kind column added; `useMemo` import bug fixed; Create/Edit/Delete buttons gated on `ASSET_TEMPLATE_*` perms
- `apps/web/src/routes/assets/components/template-form-editor.tsx` — Kind dropdown SWR-fetches from `/api/template-kinds?isActive=true`
- 10 frontend lookup sites converted from `t.name === 'Block'` etc. to `t.templateKind === 'BLOCK'`
- `apps/web/src/main.tsx` — `/config/template-kinds` route + permission gate

### Multi-tenancy removal — schema
- `model Organization` deleted
- 11 `organizationId` columns removed (User, AssetTemplate, AssetInstance, FilterCleaningProfile, FilterProfile, ChecklistProfile, BlockChangeRequest, EquipmentGroup, EntityAssignment, TemplateAssignment, DashboardAssignment)
- 2 `orgId` columns removed (ReportTemplate, ReportInstance)
- 5 composite indexes rewritten as single-column
- `AssigneeType` enum: `ORGANIZATION` value dropped
- `RoleScope` enum: collapsed `GLOBAL | ORGANIZATION` → `GLOBAL`
- `Role.scope` default: `ORGANIZATION` → `GLOBAL`

### Multi-tenancy removal — backend (24 files swept)
- DELETED: `apps/api/src/modules/org-admin/`, `apps/api/src/modules/tenant-admin/`, `apps/api/src/lib/org-scope.ts`
- `apps/api/src/app.ts` — tenant-admin route registrations removed
- `apps/api/src/types/context.ts` — dropped `organizationId` from RequestContext
- `apps/api/src/lib/build-context.ts` — dropped `organizationId` copy
- `apps/api/src/lib/jwt.ts` — dropped `organizationId` from JwtPayload
- `apps/api/src/plugins/auth.ts` — removed org-active check + `organizationId` user-pin; default scope changed to `GLOBAL`
- `apps/api/src/modules/auth/{auth.repository,auth.service,routes}.ts` — dropped org from select / login response / signToken; default scope changed to `GLOBAL`
- `apps/api/src/modules/admin-requests/admin-request.service.ts` — removed `ctx.organizationId`
- `apps/api/src/modules/assets/{routes/instance,routes/template,services/instance,services/bulk-upload-filter}.{routes,service}.ts` — removed ORGANIZATION assignee branches + dropped org write
- `apps/api/src/modules/assets/services/__tests__/instance.service.test.ts` — comment cleanup
- `apps/api/src/modules/block-change-requests/block-change.service.ts` — dropped org filter + create
- `apps/api/src/modules/checklist-profiles/checklist-profile.service.ts` — dropped org filter helper + create
- `apps/api/src/modules/cleaning-profiles/cleaning-profile.service.ts` — dropped org scope on list/get/create/update/getAssignedAssets/assignAssets
- `apps/api/src/modules/dashboards/routes.ts` — dropped ORGANIZATION assignee branch
- `apps/api/src/modules/entity-assignments/routes.ts` — dropped ORGANIZATION branch entirely (list, create, bulk, delete, my-entities)
- `apps/api/src/modules/equipment-groups/equipment-groups.service.ts` — dropped org helper + usages + create resolution
- `apps/api/src/modules/filter-operations/filter-operations.service.ts` — dropped org filter + helper + getFilter type assertion + 5 endpoints
- `apps/api/src/modules/filter-profiles/filter-profile.service.ts` — dropped org scope + cross-org validation
- `apps/api/src/modules/ldap/ldap.service.ts` — dropped org from auto-provisioned users
- `apps/api/src/modules/pm-schedules/pm-schedule.service.ts` — dropped org helper + entity-org check + 5 query usages
- `apps/api/src/modules/report-templates/report-template.service.ts` — dropped orgScope helper + create resolution + orgId
- `apps/api/src/modules/reports/service.ts` — dropped prisma.organization lookup + orgId
- `apps/api/src/modules/super-admin/routes.ts` — DELETED 5-endpoint orgs CRUD route group
- `apps/api/src/modules/users/{routes,user.repository,user.service}.ts` — dropped org from create/update body + filter + signature + payload + escalation guard
- `apps/api/src/plugins/__tests__/auth.plugin.test.ts` — dropped org mock
- `apps/api/vitest.global-setup.ts` — dropped "System" Organization auto-create + organizationId from user creates
- `apps/api/prisma/seed.ts` — dropped ORG_MANAGE/VIEW/CREATE/DELETE perms from SUPER_ADMIN + ADMIN roles

### Multi-tenancy removal — shared package
- `packages/shared/src/types/permissions.ts` — dropped 4 ORG_* constants
- `packages/shared/src/types/feature-privileges.ts` — dropped `org.view` + `org.manage`
- `packages/shared/src/types/roles.ts` — dropped `ORG_ADMIN` from DEFAULT_ROLES + DEFAULT_ROLE_HIERARCHY + ROLE_SCOPE + CREATABLE_ROLES; collapsed RoleScope to `'GLOBAL'`
- `packages/shared/src/types/sidebar-items.ts` — dropped `organizations` entry
- `packages/shared/src/schemas/users.ts` — dropped `organizationId` from createUserSchema + updateUserSchema

### Multi-tenancy removal — frontend (12 files swept)
- DELETED: `apps/web/src/routes/tenant/` (organizations.tsx + org-detail.tsx)
- `apps/web/src/main.tsx` — dropped lazy imports + `/organizations` + `/organizations/:id` routes; switched `/config/filter-data-management` gate from `ORG_MANAGE` to `CONFIG_UPDATE`; **added catch-all `<Route path="*" element={<Navigate to="/" replace />} />`** + `Navigate` import
- `apps/web/src/components/layout/sidebar.tsx` — dropped Organizations nav item
- `apps/web/src/hooks/use-auth.ts` — dropped `organizationId` from User type
- `apps/web/src/types/filter.ts` — dropped `organizationId` from FilterInstance + FilterProfile
- `apps/web/src/routes/users/{create,edit,list}.tsx` — dropped /api/organizations SWR fetch + form fields + list filter
- `apps/web/src/routes/assets/components/tabs/assignments-tab.tsx` — dropped ORGANIZATION assignee branch + form-org state + dropdown option (USER + ROLE retained)
- `apps/web/src/routes/filter-management/ahu-dashboard.tsx` — dropped org pill
- `apps/web/src/routes/config/ldap.tsx` — dropped Default Organization section + orgsData SWR fetch
- `apps/api/src/modules/roles/role.service.ts` — dropped 4 ORG_* PERMISSION_META entries

### Bug fixes from post-MT-removal e2e sweep
- `apps/web/src/routes/pm-schedules/index.tsx` — moved PM-disabled early-return below all hooks (fixed React error #300)
- `apps/web/src/routes/my-tasks/index.tsx` — replaced misleading red "Failed to load tasks" with amber "PM scheduling is disabled. Enable it in Configuration → PM Schedule Settings."
- `apps/web/src/main.tsx` — added catch-all `*` route (above)

### Documentation sync (11 files)
- `CLAUDE.md` (worktree) + `apps/api/CLAUDE.md` + `packages/shared/CLAUDE.md` — counts updated
- `CHANGELOG.md` — new "Multi-Tenancy Removal" entry above the Step 1 entry, plus a same-day "Post-MT-removal hardening" subsection covering the 3 bug fixes (PM hook crash, my-tasks PM_DISABLED message, catch-all `*` route)
- `future/architectural-refactor-9-steps.md` — Step 3 marked **OBSOLETE**; MT-removal track marked **DONE**
- `BACKEND_GUIDE.md` — module count + Organization-modules section retired + RequestContext shape update
- `API_REFERENCE.md` — login-response shape + create-user body + permissions list
- `FRONTEND_GUIDE.md` — Organizations route block retired; catch-all 404 redirect documented
- `PROJECT_SUMMARY.md` + `PROJECT_ARCHITECTURE.md` — counts + module list + JWT payload note
- `tasks/todo.md` — three audit-log entries (Step 1, MT removal, post-MT-removal hardening + doc-sync re-run)

---

## How to verify the current state when you come back

```bash
cd /c/Users/hello/21cfrlogbook-DigitalFMS/.worktrees/phase5-verification

# 1. Schema valid
cd apps/api && npx prisma validate

# 2. Backend compiles clean
npx tsc --noEmit 2>&1 | grep -E "error TS" | head -5
# (should print nothing)

# 3. Web builds clean
cd ../web && npx vite build 2>&1 | tail -5

# 4. No org refs left in either app
cd ../..
grep -rln "organizationId\|orgScope\|prisma\\.organization" apps/api/src/ apps/web/src/ 2>/dev/null
# (should print nothing)

# 5. Live API check (services should already be running as Windows services)
curl -sk -o /dev/null -w "%{http_code}\n" https://localhost:3000/health
# 401 means TLS+API are up

# 6. Login + check JWT scope=GLOBAL
TOKEN=$(curl -sk -X POST https://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"superadmin","password":"Admin@123","force":true}' \
  | python -c "import sys,json; print(json.load(sys.stdin).get('token',''))")
echo "$TOKEN" | cut -d'.' -f2 | python -c "
import sys, base64, json
s = sys.stdin.read().strip()
s += '=' * (-len(s) % 4)
print(json.dumps(json.loads(base64.urlsafe_b64decode(s)), indent=2))"
# Should show scope=GLOBAL and NO organizationId

# 7. /api/organizations should be 404
curl -sk -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" https://localhost:3000/api/organizations
# 404 confirms tenant-admin module is gone

# 8. /api/template-kinds should return 6 system kinds
curl -sk -H "Authorization: Bearer $TOKEN" https://localhost:3000/api/template-kinds | python -c "
import sys, json
kinds = json.load(sys.stdin)
print(f'{len(kinds)} kinds: {[k[\"code\"] for k in kinds]}')"
# Should be 6: BLOCK / AREA / AHU / FILTER / EQUIPMENT / OTHER
```

If any of those fail, something has regressed since 2026-04-30.

---

## Services running

NSSM-managed Windows services (don't restart unless needed):
- `DigiLogAPI-Phase5` — Fastify on `https://localhost:3000` (worktree's `apps/api/dist/app.js`)
- `DigiLogWeb-Phase5` — `vite preview` on `https://localhost:5175` (serves worktree's `apps/web/dist/`)
- Vite is in **preview** mode, NOT dev. Source edits require a rebuild (`cd apps/web && npx vite build`).
- After every web rebuild, the PWA service worker may serve a stale bundle. To force a fresh bundle in the browser, unregister the SW + clear caches:
  ```js
  // Run in DevTools console
  navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
  caches.keys().then(ks => ks.forEach(k => caches.delete(k)));
  location.reload();
  ```

If you need to reset the DB (e.g., to test the seed):
```bash
cd apps/api
PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="user consent: empty existing data" \
  npx prisma db push --force-reset --accept-data-loss
INITIAL_ADMIN_PASSWORD='Admin@123' npx tsx prisma/seed.ts
```

(`INITIAL_ADMIN_PASSWORD` env var is REQUIRED — seed will fail without it as a safety check.)

---

## Default credentials

- `superadmin` / `Admin@123` — auto-created by seed
- `RB0001` / `Test@1234` — created during this session via `/api/users` POST (test OPERATOR)

If the DB has been reset, RB0001 is gone. To re-create:
```bash
TOKEN=$(curl -sk -X POST https://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"superadmin","password":"Admin@123","force":true}' \
  | python -c "import sys,json; print(json.load(sys.stdin).get('token',''))")
curl -sk -X POST https://localhost:3000/api/users \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username":"RB0001","fullName":"Test Operator","email":"rb0001@digilog.local","role":"OPERATOR","password":"Test@1234","confirmPassword":"Test@1234","status":"ENABLED"}'
```

---

## Known follow-ups (non-blocking)

1. **PM is disabled by default.** That's intentional (opt-in feature flag). To enable PM and exercise the full PM/My Tasks flows, toggle "Enable PM Scheduling" in Configuration → PM Schedule Settings. The page no longer crashes when disabled — it shows a clean "PM Module Disabled" message.
2. **Reports `orgName` template variable.** `apps/api/src/modules/reports/service.ts` still populates `orgId` and `orgName` as empty strings in the resolution context (so `{{orgName}}` renders blank in PDFs). Trim the field once the report templates are confirmed not to reference it.
3. **DashboardScope enum.** Still has `TENANT | ORGANIZATION | USER` values. Single-tenant deployment makes TENANT and ORGANIZATION semantically identical. Consider collapsing for hygiene; not blocking.
4. **`/login` single-tab guard interaction.** During the e2e session I saw the "Session Active in Another Tab" dialog when re-logging in repeatedly. The dialog works, but interacting with `force: true` from `curl` while a browser tab is open does interrupt the browser session. Not a regression — pre-existing behavior, just visible during testing.

---

## Next steps in the 9-step refactor

| # | Step | Status |
|---|---|---|
| 1 | TemplateKind lookup | ✅ DONE |
| 2 | relationshipType enum + bidirectional check | pending |
| 3 | AssetInstance.organizationId NOT NULL | ❌ OBSOLETE — superseded by MT removal |
| 4 | applicableTemplates JSONB → join table | pending |
| 5 | Investigate two checklist systems | pending |
| 6 | FilterDetails 1:1 split off AssetInstance | pending |
| 7 | Multi-version pipeline rollout | pending |
| 8 | Decision-tape architecture | pending |
| 9 | Cycle as event fold | pending |

**Recommended next:** Step 2 (small, independent, ~1-2 hour task — tighten the relationshipType field with an enum and add a Postgres CHECK to enforce the bidirectional pair invariant).

---

## Open task list (carried forward)

| # | Status | Subject |
|---|---|---|
| 16 | ✅ completed | Tour observations + consolidated fix list |
| 17 | ✅ completed | Step 1: templateKind enum |
| 18 | ⏳ pending | Step 2: relationshipType enum + bidirectional check |
| 19 | ✅ completed (OBSOLETE) | Step 3: AssetInstance.organizationId NOT NULL — superseded |
| 20 | ⏳ pending | Step 4: applicableTemplates → join table |
| 21 | ⏳ pending | Step 5: Investigate two checklist systems |
| 22 | ⏳ pending | Step 6: FilterDetails 1:1 split |
| 23 | ⏳ pending | Step 7: Multi-version pipeline rollout |
| 24 | ⏳ pending | Step 8: Decision-tape architecture |
| 25 | ⏳ pending | Step 9: Cycle as event fold |
| 26 | ✅ completed | Step 1: e2e test pass |
| 27 | ✅ completed | MT removal: touchpoint inventory |
| 28 | ✅ completed | MT removal: schema rebuild |
| 29 | ✅ completed | MT removal: backend cleanup |
| 30 | ✅ completed | MT removal: frontend cleanup |
| 31 | ✅ completed | MT removal: e2e test pass |
| 32 | ✅ completed | MT removal: doc sync |
| 33 | ✅ completed | Bug sweep from MT-removal touchpoint test |

Reference docs:
- This file: `tasks/RESUME-STATE-2026-04-30-mt-removal-done.md`
- Earlier resume: `tasks/RESUME-STATE-2026-04-30-step1-templateKind-done.md`
- Touchpoint inventory: `tasks/MT-REMOVAL-TOUCHPOINTS.md`
- 9-step plan: `future/architectural-refactor-9-steps.md`
- Audit log: `tasks/todo.md`
