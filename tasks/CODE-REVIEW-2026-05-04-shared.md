# Code Review — `packages/shared/src/` (Phase 5 verification)

**Date:** 2026-05-04
**Reviewer:** Senior Code Reviewer (adversarial pass)
**Scope:** `packages/shared/src/**` only — types, permissions, privileges,
reauth-actions, sidebar items, sidebar privilege map, zod schemas, audit
helpers. Cross-package consistency checks against
`apps/api/src/modules/**/*.ts`, `apps/web/src/routes/**`, and
`apps/api/prisma/seed.ts`.

---

## Verified live counts (live `grep`/`wc`, this worktree, 2026-05-04)

| Item | Count | Verification command |
| --- | --- | --- |
| Permissions (`PERMISSIONS` keys) | **106** | `grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts` |
| Feature privileges (`FEATURE_PRIVILEGES`) | **90** | `grep -cE "^\s+\{ id: '" packages/shared/src/types/feature-privileges.ts` |
| `FEATURE_TO_PERMISSION_MAP` keys | **90** | `grep -cE "^  '[a-z_.]+':" packages/shared/src/types/feature-privileges.ts` |
| Reauth actions (`REAUTH_ACTIONS` keys) | **87** | `grep -cE "^\s+[A-Z_]+:" packages/shared/src/types/reauth-actions.ts` |
| Reauth-action categories | 17 | `REAUTH_ACTION_CATEGORIES` array length |
| `SIDEBAR_ITEMS` entries | **26** | counted entries in `sidebar-items.ts` |
| `SIDEBAR_PRIVILEGE_MAP` entries | **27** (1 stale) | `grep -cE "^\s+sidebarId: " packages/shared/src/types/sidebar-privilege-map.ts` |
| `PERMISSION_CATEGORIES` perms exposed | **40** of 106 | extracted via `grep -oE "PERMISSIONS\.[A-Z_]+" permission-categories.ts` |
| `AUDIT_TEMPLATE_DEFAULTS` entries | 60 | counted manually |
| Zod schema files (live + tests) | 8 + 4 tests + 1 `.patch` | `ls packages/shared/src/schemas/` |

Discrepancy with claimed counts in user prompt:
- Prompt claimed **109** permissions; live is **106**. Worktree
  `CLAUDE.md` and `packages/shared/CLAUDE.md` already say 106 (post
  MT-removal + Phase 5.2 `VERSION_HISTORY_VIEW`). The prompt's "109"
  is stale — that count predates 2026-04-30 MT removal that dropped
  `ORG_*` permissions.
- Prompt claimed **91** privileges; live is **90**.
- Prompt claimed **81 → 87** reauth bump. Live is **87** ✅.
- Prompt claimed **26** sidebar items; `SIDEBAR_ITEMS` is **26** ✅
  but `SIDEBAR_PRIVILEGE_MAP` has **27** (extra `organizations` entry — see C-3).

---

## Critical (must fix before claiming Phase 5 verification done)

### C-1. `SIDEBAR_PRIVILEGE_MAP` references dead privilege IDs `org.view` / `org.manage`
**File:** `packages/shared/src/types/sidebar-privilege-map.ts:168-173`

```ts
{
  sidebarId: "organizations",
  label: "Organizations",
  ...
  privilegeIds: ["org.view", "org.manage"],
},
```

After MT removal (2026-04-30), `org.view`, `org.manage`, the
`organizations` sidebar item, and the `org-admin`/`tenant-admin` route
modules were all deleted. `SIDEBAR_ITEMS` (26 items) does not contain
`organizations`. `FEATURE_PRIVILEGES` (90 items) does not contain
`org.view` or `org.manage`.

**Why this is critical:**
- Whoever wrote `getPrivilegesForSection('organizations')` will get an
  empty array silently — easy to miss the orphan.
- The user-facing Role Privileges page that iterates
  `SIDEBAR_PRIVILEGE_MAP` will render an "Organizations" section with
  no toggles, confusing admins.
- Confirms a partial cleanup — MT removal fixed `SIDEBAR_ITEMS` and
  `FEATURE_PRIVILEGES` but missed this file.

**Fix:** delete the entry; verify no consumer hard-codes
`getPrivilegesForSection('organizations')`.

### C-2. `role.service.ts` `PERMISSION_META` is missing 15 perms (UI category fallback to "Other")
**File:** `apps/api/src/modules/roles/role.service.ts:34-150`
**Cross-shared-source:** `packages/shared/src/types/permissions.ts`

Permissions defined in `PERMISSIONS` and seeded by `prisma/seed.ts` but
absent from `PERMISSION_META`:

```
FILTER_CREATE, FILTER_EDIT, FILTER_DELETE,
FILTER_HIERARCHY_EDIT, FILTER_HIERARCHY_DELETE,
REPORT_TEMPLATE_READ, REPORT_TEMPLATE_CREATE, REPORT_TEMPLATE_UPDATE, REPORT_TEMPLATE_DELETE,
REPORT_GENERATE, REPORT_VIEW, REPORT_SIGN, REPORT_DELETE, REPORT_EXPORT,
VERSION_HISTORY_VIEW
```

`ALL_PERMISSIONS` derives via `Object.values(PERMISSIONS).map(...)` so
the perms still appear in the API response — but with `category: 'Other'`
and `label === key` (raw uppercase). On the role-edit screen these 15
perms are dumped into a generic "Other" bucket, breaking
discoverability and visually telling admins these are second-class.

**Fix:** add proper category/label entries (Filter Management, Filters
Page Controls, Reports, Audit / Versions). This file already imports
`PERMISSIONS`, so use the typed key.

### C-3. `enforceReauth('UPDATE_EMAIL_CONFIG' | 'UPDATE_SMS_CONFIG', ...)` references undefined reauth actions
**Files:**
- `apps/api/src/modules/notification-delivery/routes.ts` (call sites)
- `packages/shared/src/types/reauth-actions.ts` (missing entries)

Both actions are passed to `enforceReauth(...)` but neither exists in
`REAUTH_ACTIONS`. Consequences:

- They cannot be configured on the action-reauth admin page — the page
  iterates `REAUTH_ACTIONS`, so no checkbox exists to opt either action
  into "require re-auth for ADMIN".
- Audit-trail label/category lookup falls back to the raw key.
- Operators cannot enforce step-up auth on email/SMS config writes.

This is an old wiring miss, not introduced this session, but it
trips the same shared-package contract as the C2 reauth additions
(`RETIRE_FILTER`, `REPLACE_FILTER`, `BULK_UPLOAD_FILTERS`) that the
prompt mentioned were added today. Add the two entries under category
`'Notification Delivery'` (and add the new category to
`REAUTH_ACTION_CATEGORIES`).

### C-4. `'admin_requests.view'` privilege maps to `USER_CREATE` permission — semantic coupling bug
**File:** `packages/shared/src/types/feature-privileges.ts:127, 279`

```ts
{ id: 'admin_requests.view', label: 'Review Admin Requests', ... }
'admin_requests.view': ['USER_CREATE'],
```

The actual route (`apps/api/src/modules/admin-requests/routes.ts`)
guards three handlers with `requirePermission('USER_CREATE')`. Net
effect:

- Granting "Review Admin Requests" silently grants "Create Users"
  (because the map injects `USER_CREATE` into the role's permissions
  array).
- Granting "Create Users" silently grants admin-request review.
- A reviewer who is *not* allowed to create users directly cannot
  approve a `CREATE_USER` admin request — the only enforcement path is
  the same permission.

This is the design pattern called out in the prompt: "Where does
`FEATURE_TO_PERMISSION_MAP` map a frontend perm to no backend perm
(or vice versa)?" — here it's worse, the map deliberately conflates
two semantically distinct features.

**Fix options (prefer first):**
1. Add a dedicated `ADMIN_REQUEST_REVIEW` permission, wire
   `admin-requests/routes.ts` to `requirePermission('ADMIN_REQUEST_REVIEW')`
   and seed it onto SUPER_ADMIN/ADMIN/SUPERVISOR. Map
   `'admin_requests.view': ['ADMIN_REQUEST_REVIEW']`.
2. At minimum, document the conflation in the privilege definition
   (label: "Review Admin Requests (implies Create Users)") so admins
   understand the entitlement they are granting.

---

## High (should fix before next release)

### H-1. `SIDEBAR_PRIVILEGE_MAP` "checklists" entry points at `cleaning_profiles.*` privileges
**File:** `packages/shared/src/types/sidebar-privilege-map.ts:146-152`

```ts
sidebarId: "checklists",
privilegeIds: ["cleaning_profiles.view", "cleaning_profiles.create",
               "cleaning_profiles.edit", "cleaning_profiles.delete"],
```

The Checklists page is a separate sidebar item with its own
`checklists.create / edit / delete / toggle` privileges (defined at
`feature-privileges.ts:73-76`). Mapping the Checklists section to
cleaning-profile toggles means:
- Admin enables a checklist toggle → no effect (FEATURE_TO_PERMISSION_MAP
  for `cleaning_profiles.*` writes `CP_PAGE_*` perms, not `CHECKLIST_*`).
- Admin can never grant the actual `CHECKLIST_CREATE / EDIT / DELETE /
  TOGGLE` perms via the unified Role Access page.

**Fix:** replace with `["checklists.create", "checklists.edit",
"checklists.delete", "checklists.toggle"]`.

### H-2. `SIDEBAR_PRIVILEGE_MAP` "equipment-groups" uses generic asset perms instead of EG-specific ones
**File:** `packages/shared/src/types/sidebar-privilege-map.ts:161-166`

```ts
sidebarId: "equipment-groups",
privilegeIds: ["assets.view", "assets.create", "assets.edit", "assets.delete"],
```

Equipment Groups already have `equipment_groups.view / create / edit /
delete` privileges (see `feature-privileges.ts:117-120`). The current
map silently grants generic asset CRUD whenever an admin toggles an EG
control, which is far broader than intended.

**Fix:** replace with `["equipment_groups.view", "equipment_groups.create",
"equipment_groups.edit", "equipment_groups.delete"]`.

### H-3. Dead Zod schemas: `packages/shared/src/schemas/templates.ts` and `hierarchy.ts`
**Files:**
- `packages/shared/src/schemas/templates.ts` (43 lines — `createTemplateSchema`,
  `updateTemplateSchema`, `attributeFieldSchema`, `telemetryPointSchema`)
- `packages/shared/src/schemas/hierarchy.ts` (35 lines — `createNodeSchema`,
  `updateNodeSchema`, `createLinkSchema`, `createIdentifierSchema`)

Neither is exported from `packages/shared/src/index.ts`. Search across
`apps/api/src` and `apps/web/src` finds zero non-`dist/` consumers.
They duplicate (with different shapes) the live schemas in `assets.ts`:
- `templates.ts.attributeFieldSchema.dataType` is lower-case
  `'text'/'number'/...` while `assets.ts.attributeDefinitionSchema.dataType`
  is upper-case `'TEXT'/'INTEGER'/...`.
- `templates.ts.telemetryPointSchema.dataType` accepts only `'number' |
  'boolean' | 'text'` while `assets.ts` accepts five upper-case types.

Risk: a future agent imports the dead schema by autocomplete and ships
two parallel validation regimes. **Fix:** delete both files.

### H-4. `PERMISSION_CATEGORIES` only covers 40 of 106 perms (and consumer is dead code)
**Files:**
- `packages/shared/src/types/permission-categories.ts` (40 entries)
- `apps/web/src/routes/config/roles-components/role-permissions-grid.tsx`
  (only consumer; not referenced by any live page)

Of the 106 permissions, 66 are missing — including every
`FILTER_*`, `FCP_*`, `FP_*`, `PM_*`, `EG_*`, `CHECKLIST_*` (page-control),
`CP_*`, `REPORT_*`, `BLOCK_CHANGE_*`, `CYCLE_READ`, `EVENT_READ`, plus
`ASSET_READ`, `ENTITY_ASSIGN`, `BACKUP_MANAGE`, `NOTIFICATION_MANAGE`,
`VERSION_HISTORY_VIEW`.

`RolePermissionsGrid` (the only consumer) has a `Props` interface but
no JSX site that imports it — search across `apps/web/src` for
`RolePermissionsGrid` returns only the file's own definition. The live
"Role Privileges" UI uses `FEATURE_PRIVILEGES` (via `permissions-tab.tsx`)
which is current.

**Fix:** delete `permission-categories.ts` AND `role-permissions-grid.tsx`,
or — if you want to keep the legacy "raw permissions" view alive —
regenerate `PERMISSION_CATEGORIES` from `PERMISSIONS` programmatically so
it can never drift again.

### H-5. Stray patch leftover: `packages/shared/src/schemas/config.ts.patch`
Two-line file that says "Replace lines 113-120 with new flexible schema".
Was already called out in `packages/shared/CLAUDE.md` ("> Stray file:
`config.ts.patch` exists in this folder — clean up.") but never deleted.

**Fix:** `git rm` it.

---

## Medium (cleanup / robustness)

### M-1. Code style: backend uses raw permission strings instead of `PERMISSIONS.X` constants
Routes such as `report-templates/routes.ts` and `reports/routes.ts`
guard endpoints with raw string literals (`requirePermission('REPORT_GENERATE')`)
rather than the typed `PERMISSIONS.REPORT_GENERATE` constant. Same for
the `'REPORT_*'` web checks (`perms.includes('REPORT_SIGN')`). This:
- Defeats the type-checking benefit of the central `PERMISSIONS` enum.
- Made the dead-permission audit noisier — a naive `grep PERMISSIONS\.X`
  flagged 15 perms as unused that were actually referenced as raw
  strings.
- Means renaming a permission (or typo'ing one) is a runtime/silent
  failure rather than a compile error.

**Fix:** migrate raw strings to typed constants. Worth a follow-up sweep
once the C-2 PERMISSION_META gap is closed.

### M-2. Duplicate `'GLOBAL'` literal in `roles.ts`
`type RoleScope = 'GLOBAL'` plus `ROLE_SCOPE` records every role to the
literal `'GLOBAL'`. Phase 5 MT-removal trimmed multi-tenancy but left
this as a transitional vestige. Either:
- Delete `RoleScope`/`ROLE_SCOPE` outright (callers already drop the
  field per `apps/api/CLAUDE.md`), or
- Leave the comment in place — no functional impact.

### M-3. `FEATURE_PRIVILEGES` `category` strings duplicated and free-form
`category` is a free-form string (e.g. `'Filter Management'`,
`'Filters Page Controls'`, `'Filter Page Controls'`) and there's no
union type guarding spelling. Compare to `REAUTH_ACTION_CATEGORIES`
which uses `as const` + a narrowed type. Suggest adding
`FEATURE_PRIVILEGE_CATEGORIES` as `as const` and typing
`category: (typeof FEATURE_PRIVILEGE_CATEGORIES)[number]`.

### M-4. `SidebarItem.icon` uses Unicode escape strings (e.g. `'\u{1F3E0}'`) while sidebar.tsx renders Lucide icons
`SIDEBAR_ITEMS[*].icon` and `SIDEBAR_PRIVILEGE_MAP[*].icon` are emoji
escapes. The actual sidebar component (`apps/web/src/components/layout/sidebar.tsx`)
imports Lucide React icons by name, not from this string. So the
`icon` field is essentially dead metadata that only appears in
config tabs.
- Either standardize on Lucide name strings (`'home' | 'users' | ...`)
  and have `sidebar.tsx` look them up, or
- Document that `icon` is presentational metadata only for the config UI.

### M-5. `SIDEBAR_ITEMS.icon` and `SIDEBAR_PRIVILEGE_MAP.icon` drift
Same `sidebarId` carries different icon strings between the two files
(e.g. `debug-traces` is `'\u{1F50D}'` (magnifying glass) in
`SIDEBAR_ITEMS` but `'\u{1F41B}'` (bug) in `SIDEBAR_PRIVILEGE_MAP`).
Pick one source of truth and have the other lookup by id.

### M-6. `notifications.delete` privilege does not include `NOTIFICATION_VIEW`
`'notifications.delete': ['NOTIFICATION_DELETE']` — but to *see* the list
of notifications you need `NOTIFICATION_VIEW`. Granting only
`notifications.delete` to a role gives a delete API permission with no
list page. Compare to `'users.delete': ['USER_DELETE', 'USER_READ']`
which correctly bundles READ. Add `NOTIFICATION_VIEW` to the array.

### M-7. `audit-templates.ts` placeholders aren't validated
`AUDIT_TEMPLATE_DEFAULTS` exposes `placeholders: string[]` per template
but there's no validation that the `template` string actually contains
those placeholders, nor that the runtime renderer rejects unknown
placeholders. A typo today (`{actr}` vs `{actor}`) ships silently and
shows an unrendered `{actr}` in the audit UI.

### M-8. `loginSecuritySchema` and `sessionConfigSchema` are kept for
"backward compatibility with existing data" but have no superseding schema
documented. Their fields (`lockoutType`, `lockoutDurationMinutes`,
`sessionDurationHours`) overlap with `passwordPolicySchema` (which now
includes `maxFailedAttempts`, `autoLogoutEnabled`, etc.). If they're
truly legacy, mark `@deprecated` in JSDoc; if still active, document
which writer owns them.

### M-9. `assetQuerySchema.limit` cap is 1000 — a 22.5x increase over standard pagination
Comment in `schemas/assets.ts:271-275` justifies it for the SPA's bulk
fetches. Fine for now but means a single authenticated request can pull
up to 1000 asset rows with attached templates / relationships. Add a
note that any new aggregating endpoint should re-evaluate the cap.

### M-10. `paginationConfigSchema.options` has `min(2).max(10)` but no upper bound on individual numbers
`options: z.array(z.number().min(5)).min(2).max(10)` — individual values
have no `.max()`. The cross-field `.refine` ensures `<= limit` (limit
capped at 1000), so it's bounded transitively, but explicit per-element
`max(1000)` is more honest.

---

## Low (nitpicks / future-proofing)

### L-1. `sidebar-items.ts` mixes single-quoted, double-quoted, and Unicode-escaped strings inconsistently — pure cosmetic, but a `prettier`/`biome` pass would normalize.

### L-2. `permissions.ts` is one flat object with manual section comments. Consider grouping into smaller named constants (`USER_PERMISSIONS`, `FILTER_PERMISSIONS`, ...) and re-exporting a merged record. Easier to spot adds/removes per category in PRs.

### L-3. The `VERSION_HISTORY_VIEW` doc comment in `permissions.ts:168-175` is a 7-line essay explaining the entitlement model. Move that to `packages/shared/CLAUDE.md` so the source file stays scannable.

### L-4. `audit-templates.test.ts` exists alongside `audit-templates.ts` — confirm in this scope (it does cover round-tripping). Other type files (`permissions.ts`, `feature-privileges.ts`, `reauth-actions.ts`, `sidebar-items.ts`, `sidebar-privilege-map.ts`) have **no test** locking the cross-file invariants surfaced in C-1 / H-1 / H-2 / H-4 above. A single `cross-package-consistency.test.ts` would have caught all four with five-line assertions:
```ts
// Every privilegeId in SIDEBAR_PRIVILEGE_MAP must exist in FEATURE_PRIVILEGES.
// Every sidebarId in SIDEBAR_PRIVILEGE_MAP must exist in SIDEBAR_ITEMS.
// Every key in FEATURE_TO_PERMISSION_MAP must equal an id in FEATURE_PRIVILEGES.
// Every value-string in FEATURE_TO_PERMISSION_MAP must exist in PERMISSIONS.
// Every key in REAUTH_ACTIONS.category must exist in REAUTH_ACTION_CATEGORIES.
```
Strongly recommended as a fast follow-up.

### L-5. `roles.ts` exports `CREATABLE_ROLES` marked `@deprecated`. If truly unused (the comment claims "use API endpoint /api/roles/:name/creatable"), drop it; otherwise the deprecation tag has been there long enough to delete safely.

---

## Design challenges

### D-1. The "CONFIG_README" promise in CLAUDE.md vs. lived reality
`CLAUDE.md` says: "Sidebar, permissions, reauth are separate — do NOT
auto-sync between them." That's defensible as a config-page UX rule —
admin should opt in per surface. But the underlying data model treats
**FEATURE_TO_PERMISSION_MAP** as an implicit auto-sync (toggling a
privilege writes its mapped permissions onto the role). Two concerns:

1. The `'admin_requests.view' → ['USER_CREATE']` mapping (C-4) is the
   case where this implicit sync produces a privilege escalation.
   There's no audit-log entry distinguishing "operator granted
   admin_requests.view" from "operator was given USER_CREATE" — a
   compliance reviewer reading `auditTrail` will see only the latter.
2. The flip side: a frontend privilege without a backend route
   permission silently shows a button that 403s on click. Several map
   entries hand out `'ASSET_READ'` as a coupled side-effect (e.g.
   `'filters.events': ['EVENT_READ', 'ASSET_READ']`) which means one
   privilege can broadcast read access across all entity types.

Recommend: every mapping that adds more than one permission should be
accompanied by a comment justifying the bundling, and the role-edit
audit log should record the *privilege ID* that triggered the change,
not just the resulting permission set.

### D-2. The two-source-of-truth pattern for sidebar
`SIDEBAR_ITEMS` (the rendering source) and `SIDEBAR_PRIVILEGE_MAP`
(the role-config source) are independently authored. CLAUDE.md
acknowledges "Sidebar items live in TWO files — must update both."
Today: one is at 26, the other at 27. C-1 is the result.

A merge into one structure (`SIDEBAR_ITEMS[i].privilegeIds: string[]`)
would eliminate the entire class of drift. The `getPrivilegesForSection`
helper would still work. The migration is mechanical.

### D-3. Permission naming inconsistency
- Sometimes verb-resource: `USER_CREATE`, `ASSET_DELETE`
- Sometimes resource-verb: `READ_DEBUG_TRACE`, `MANAGE_DEBUG_TRACE`
- Sometimes domain-prefix: `FCP_READ` (filter cleaning profile), `FP_READ`
  (filter profile), `EG_VIEW` (equipment group), `CP_TOGGLE` (cleaning
  profile)
- Sometimes long: `ASSET_RELATIONSHIP_CREATE`, `ASSET_IDENTIFIER_DELETE`
- Sometimes ENABLE_DISABLE composite: `USER_ENABLE_DISABLE`

The acronym-prefix style (FCP, FP, EG, CP) is hostile to grep — once
we have ~15 acronyms the next reader has to map them. New permissions
should use the verb-resource form (`CLEANING_PROFILE_TOGGLE`,
`EQUIPMENT_GROUP_VIEW`) and the existing acronyms should be migrated in
a single sweep.

### D-4. `RolePermissionsGrid` is dead but `PERMISSION_CATEGORIES` is exported
Either commit to "RolePermissionsGrid is the legacy raw view that admins
never need anymore" and delete both, or restore it. Keeping a dead
component referencing a 40-of-106 stale enum is the worst-case state —
it suggests the perms list is intentionally incomplete and invites
copy-paste-elsewhere of the wrong source.

---

## Out of scope (flagged for follow-up reviews, not opened here)

- `pipeline-executor/*` (~1500 LOC) — out-of-scope per prompt
  ("everything *except* deeply diving pipeline-executor"); only confirmed
  it's exported via `index.ts` and has its own `__tests__` folder.
- `apps/api/src/modules/roles/role.service.ts` — only the
  `PERMISSION_META` table touched here (C-2). Service logic, audit, and
  hierarchy enforcement not reviewed.
- `apps/api/src/modules/admin-requests/routes.ts` permission wiring —
  only the privilege bundling called out (C-4). Workflow logic not
  reviewed.
- The `apps/api` tests (`tests/integration/`, `apps/api/src/e2e/`) that
  reference the new C2/M1/M2 reauth actions — assumed green per
  `CLAUDE.md` "Verified baseline 1231 passing".
- The 8 zod `*.test.ts` siblings — not re-run; assumed CI-green.

---

## Five-line summary

1. **C-1**: `SIDEBAR_PRIVILEGE_MAP` carries a stale `organizations`
   entry (with dead `org.view` / `org.manage` privilege IDs) — leftover
   from MT removal. Net: 27 entries vs 26 in `SIDEBAR_ITEMS`.
2. **C-2**: `apps/api/src/modules/roles/role.service.ts` `PERMISSION_META`
   is missing 15 perms (5 FILTER_*, 9 REPORT_*, VERSION_HISTORY_VIEW) —
   role-edit UI dumps them under "Other" with no labels.
3. **C-3**: `enforceReauth('UPDATE_EMAIL_CONFIG')` and
   `'UPDATE_SMS_CONFIG'` (in `notification-delivery/routes.ts`) reference
   reauth actions that don't exist in `REAUTH_ACTIONS` — admins cannot
   configure step-up auth for either.
4. **C-4**: `'admin_requests.view'` privilege maps to `USER_CREATE`
   permission, conflating two semantically distinct entitlements and
   silently granting cross-feature access.
5. **H-1/H-2/H-3/H-4/H-5**: Checklist sidebar wired to cleaning-profile
   privileges; equipment-groups sidebar wired to generic asset perms;
   `schemas/templates.ts` + `schemas/hierarchy.ts` are dead duplicates
   of `assets.ts`; `PERMISSION_CATEGORIES` covers only 40 of 106 perms
   and its only consumer (`RolePermissionsGrid`) is itself dead;
   `config.ts.patch` is a stray leftover. Verified live counts:
   **106 permissions, 90 privileges, 87 reauth, 26 sidebar items
   (27 in SIDEBAR_PRIVILEGE_MAP — bug)**.
