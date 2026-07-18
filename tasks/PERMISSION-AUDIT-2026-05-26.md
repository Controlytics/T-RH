# DigiLog Web — Strict Permission, Role-Access, Reauth & Feature Audit
**Date**: 2026-05-26  
**Scope**: complete sweep of frontend permission gates, backend route guards, reauthentication coverage, permission-constant hygiene, two reported bugs.

This document combines findings from four parallel audit agents plus direct bug repro. It is the consolidated audit deliverable requested.

Executive summary table at the bottom. Severity definitions below.

---

## Severity definitions

| Severity | Definition |
|---|---|
| **CRITICAL** | Destructive action (delete/disable/reset password/force logout/restore/approve) reachable by users who shouldn't have it, OR backend endpoint that mutates without any permission gate. Production exploit possible today. |
| **HIGH** | Data-modification action (edit/update/configure/assign) leaks UI affordance or backend gate. Backend usually rejects but the UI surface contradicts role intent and operator UX is broken. |
| **MEDIUM** | Data egress (export/download) or pattern drift (route gated inconsistently relative to siblings). |
| **LOW** | Hygiene — declared-but-unused permission, defense-in-depth gap, deprecated constant. |

---

## Section 1 — Two reported bugs (fixed in this audit)

### Bug 1 — Notifications: bulk delete silently no-op for ADMIN/SUPER_ADMIN

**Severity**: HIGH (data-integrity, not a security leak)

**Repro**: Login as SUPER_ADMIN. Navigate to /notifications. Select notifications NOT addressed to your username (e.g. PASSWORD_RESET_REQUEST entries that were `forUserId: someoneElse`). Click "Delete Selected". Toast shows success, selection clears, but DB query confirms the rows weren't deleted.

**Root cause** (`apps/api/src/modules/notifications/notification.repository.ts:87-91` pre-fix):

```ts
async bulkDelete(ids: string[], username?: string) {
  const where: any = { id: { in: ids } };
  if (username) where.OR = [{ forUserId: username }, { targetUserId: username }];
  return prisma.notification.deleteMany({ where });
}
```

The bulk ops only filtered by `forUserId === self OR targetUserId === self`. The single-delete path correctly mirrors the LIST visibility rules (admins see all non-SUPER_ADMIN, super-admins see everything) via `assertNotificationVisible` in `notification.service.ts:153`. The bulk methods were never updated — they silently dropped notifications not addressed to the caller and returned `{ count: <subset> }`.

**Fix shipped**:
- `notification.repository.ts` — new `buildBulkVisibilityFilter(ids, userRole, username)` mirrors `buildVisibilityFilter` in the service: SUPER_ADMIN sees everything in `ids`, ADMIN gets the role-scoped filter, others stay restricted to own.
- `notification.service.ts` — `bulkRead`, `bulkUnread`, `bulkDelete` all now take `userRole` and pass it through.
- `notification.routes.ts` — three route handlers pass `req.user.role` alongside `req.user.username`.

**Validation**: 18/18 existing notification unit tests still pass.

### Bug 2 — Users page: Edit / Disable / Enable / Unlock visible without permissions

**Severity**: CRITICAL (visibility), MEDIUM (actual security)

**Repro**: Create a test user with role `OPERATOR` and add ONLY `USER_READ` to their permissions. Login as that user. Navigate to /users. Edit / Disable / Enable / Unlock buttons render on every row.

**Root cause** (`apps/web/src/routes/users/components/user-table.tsx` pre-fix):

Only the Delete button checked `canDeleteUsers`. The other four — Edit (`Link to /users/:id`), Unlock (POST `/users/:id/unlock`), Disable (POST `/users/:id/disable`), Enable (POST `/users/:id/enable`) — rendered unconditionally.

Backend WAS gated correctly:
- PUT `/api/users/:id` → `USER_UPDATE` ✓
- POST `/api/users/:id/enable` → `USER_ENABLE_DISABLE` ✓
- POST `/api/users/:id/disable` → `USER_ENABLE_DISABLE` ✓
- POST `/api/users/:id/unlock` → `USER_UNLOCK` ✓

So the actual mutation would have 403'd, but operators saw + clicked buttons they had no business seeing, and got confusing errors.

**Fix shipped**:
- `users/list.tsx` — added `canEditUsers`, `canDisableUsers`, `canUnlockUsers` derived flags mirroring `canDeleteUsers`.
- `users/components/user-table.tsx` — each action button is now gated on its matching flag.
- `users/edit.tsx` — `canEdit` / `canResetPassword` gates added; Save Changes and Generate Temporary Password buttons hide when missing perms; explanation text shown.

---

## Section 2 — Frontend permission-gate audit (full sweep)

Audit agent inventoried every `apps/web/src/routes/**/*.tsx` rendering mutation/action buttons and cross-checked against `perms.includes(...)` / `isSuperAdmin` / `RequireRole` gates.

### CRITICAL findings (5 — all FIXED in this audit)

| # | File | Action | Missing perm | Status |
|---|---|---|---|---|
| 1 | `users/components/user-table.tsx:158` | Disable button | `USER_ENABLE_DISABLE` | ✅ Fixed |
| 2 | `users/components/user-table.tsx:171` | Enable button | `USER_ENABLE_DISABLE` | ✅ Fixed |
| 3 | `users/components/user-table.tsx:146` | Unlock button | `USER_UNLOCK` | ✅ Fixed |
| 4 | `users/edit.tsx:326` | Generate Temporary Password | `USER_RESET_PASSWORD` | ✅ Fixed |
| 5 | `config/backup.tsx:422` + dialog | Restore Backup | `BACKUP_RESTORE` | ✅ Fixed |

### HIGH findings (10 — partially fixed)

| # | File | Action | Missing perm | Status |
|---|---|---|---|---|
| 1 | `users/components/user-table.tsx:137` | Edit user (Link) | `USER_UPDATE` | ✅ Fixed |
| 2 | `users/edit.tsx:340` | Save Changes | `USER_UPDATE` | ✅ Fixed |
| 3 | `filter-management/ahu-dashboard.tsx:76` | Bulk Upload Filters | `FILTER_BULK_UPLOAD` | ✅ Fixed |
| 4 | `config/filter-cleaning-reasons.tsx:130,134,187,263` | Add/Edit/Save Reasons | `CONFIG_UPDATE` | ⏳ Deferred — backend rejects; mass refactor |
| 5 | `config/password-policy.tsx:342` | Save | `CONFIG_UPDATE` | ⏳ Deferred |
| 6 | `config/ldap.tsx:354,164,215,312` | Save/Enable/Test/Add Mapping | `CONFIG_UPDATE` | ⏳ Deferred |
| 7 | `config/datetime.tsx:280` | Save Changes | `CONFIG_UPDATE` | ⏳ Deferred |
| 8 | `config/dynamic-config.tsx:339` | Save (covers many modules) | `CONFIG_UPDATE` | ⏳ Deferred |
| 9 | `config/report-settings.tsx` | Save controls | `CONFIG_UPDATE` | ⏳ Deferred |
| 10 | `config/ahu-filter-set-config.tsx` | Auto-save toggle | `PM_UPDATE` or `CONFIG_UPDATE` | ⏳ Deferred |

**Pattern note**: Items 4-10 share the same root issue — routes gated only by `CONFIG_READ` (intentionally broad for read-only viewers) leak `CONFIG_UPDATE` actions because Save buttons don't re-check the write permission. The canonical fix already exists in `config/user-id.tsx:48` (`isSuperAdmin = SUPER_ADMIN || perms.includes('CONFIG_UPDATE')`). Recommended cleanup: a 1-day sweep applying that idiom to all eight pages. Tracked as **post-audit item PA-FE-1** below.

### MEDIUM findings (3 — partially fixed)

| # | File | Action | Missing perm | Status |
|---|---|---|---|---|
| 1 | `config/backup.tsx:264` | Download Backup | `BACKUP_MANAGE` / `BACKUP_EXPORT` | ✅ Fixed |
| 2 | `cleaning-cycles/timeline.tsx:164` | Export PDF | `REPORT_EXPORT` (suggested) | ⏳ Deferred |
| 3 | `cleaning-cycles/history.tsx:186` | Download PDF | `REPORT_EXPORT` | ⏳ Deferred |

### LOW findings (2)

| # | File | Action | Notes |
|---|---|---|---|
| 1 | `config/filter-data-management.tsx` row actions | Edit/Restore/Delete on retirement & replacement rows | Already gated by CONFIG_UPDATE + CONFIG_READ at route level; defense-in-depth refinement only |
| 2 | `reports/generate.tsx` | Generate report | Already gated correctly on `REPORT_GENERATE` |

### Pages confirmed CLEAN

`filter-list.tsx` (rich `hasPerm` helper), `filter-management/cleaning-profile-list.tsx`, `equipment-groups.tsx`, `pm-schedules/index.tsx` (8 perm flags), `admin-requests/index.tsx`, `approvals/index.tsx`, `audit/index.tsx` + `audit-table.tsx`, `checklist-admin/*`, `notifications/index.tsx`, `config/uns.tsx`, `config/user-id.tsx`, `config/role-access.tsx`, `config/notification-rules/*`, `config/audit-templates.tsx`, `config/access-matrix.tsx`, `config/tablet-access.tsx`, `config/dashboard-cards.tsx`, `config/branding.tsx`, `config/retention.tsx`, `config/pagination.tsx`, `config/help.tsx`, `report-templates/index.tsx`, `reports/index.tsx` + `detail.tsx`, `users/create.tsx`, `users/reset-requests.tsx`, `version-history/index.tsx`, `my-tasks/index.tsx`, `pm-schedules/detail.tsx`, `filter-traceability.tsx`, `retirement-list.tsx`, `replacement-list.tsx`.

---

## Section 3 — Backend route-guard audit

Audit agent enumerated every `app.<method>(...)` definition under `apps/api/src/modules/**/routes.ts`. Global `onRequest` hook in `apps/api/src/plugins/auth.ts:169` rejects non-PUBLIC_PATHS requests without a valid JWT — the question is whether JWT alone is sufficient.

### CRITICAL findings: 0

No mutation route is reachable without authentication. No wrong-permission mismatches.

### HIGH findings (2 — both FIXED)

| # | Route | Pre-fix gate | Fix |
|---|---|---|---|
| 1 | `POST /api/data/rpc` (`data-ingestion/routes.ts:551`) | JWT only | ✅ Added `requirePermission('ASSET_UPDATE')` |
| 2 | `GET /api/data/rpc/response/:requestId` (`data-ingestion/routes.ts:606`) | JWT only | ✅ Added `requirePermission('ASSET_VIEW')` |

**Why these matter**: any authenticated user — including OPERATOR — could publish arbitrary `(entityId, method, params)` RPC requests over MQTT to any device. The handler does no entityId-visibility check, no method whitelist. Single highest-impact route leak in the audit.

### MEDIUM finding (1 — deferred)

`GET /api/config/field-ids` (`config/static-routes/field-ids.routes.ts:6`) — no permission preHandler. Every other admin-config list GET in this codebase gates the full list on `CONFIG_READ` and exposes a separate `/current` for everyone. Pattern drift, not a bleeding leak. Tracked as **post-audit item PA-BE-1**.

### LOW findings (~35 GET routes)

Every LOW GET route was confirmed intentional — either `PUBLIC_PATHS`, per-caller-scoped (e.g. `/api/auth/me`, `/api/notifications`), or trivially public (e.g. `/api/help`, `/api/help/:key`). Listed in `tasks/PERMISSION-AUDIT-RAW-2026-05-26.md` if needed; not reproduced here for length.

### Wrong-permission mismatches: 0

Several routes that read suspiciously turned out to be intentional and documented in their docblocks — confirmed for:
- `backup/routes.ts:151 POST /api/backup/validate` → `CONFIG_UPDATE` (parse-only, not destructive)
- `audit/routes.ts:263 GET /api/audit/:id` → re-applies `userRole != 'SUPER_ADMIN'` filter (intentional, prevents UUID-detail leak)
- `super-admin/routes.ts` → wall-to-wall `requireRole('SUPER_ADMIN')` (intentional; audit-trail PUT/DELETE were replaced with `audit/routes.ts:329` redact endpoints on 2026-05-20)

---

## Section 4 — Reauthentication audit

Cross-referenced `packages/shared/src/types/reauth-actions.ts` (87 declared actions) against `enforceReauth(...)` BE call sites and `reauth.execute(...)` FE call sites.

### CRITICAL findings (2)

#### REAUTH-C1 — `UPDATE_UNS_PATH` / `OVERRIDE_UNS_PATH` name drift

| | |
|---|---|
| FE site | `apps/web/src/routes/config/uns.tsx:197` uses `'UPDATE_UNS_PATH'` |
| BE site | `apps/api/src/modules/uns/routes.ts:180` uses `'OVERRIDE_UNS_PATH'` |
| Shared types | declares `OVERRIDE_UNS_PATH`, NOT `UPDATE_UNS_PATH` |
| Effect | FE name doesn't exist in shared types → `useReauth.needsReauth('UPDATE_UNS_PATH')` permanently `false` → FE never pre-prompts → operator gets a retroactive 401 instead of a clean dialog. Admin UI can't configure role-by-role policy for this action. |
| Fix | Rename FE to `'OVERRIDE_UNS_PATH'` (1-line). Tracked as **PA-REAUTH-1**. |

#### REAUTH-C2 — `ASSET_TEMPLATE_CREATE` / `_UPDATE` / `_DELETE` not declared

| | |
|---|---|
| BE site | `apps/api/src/modules/assets/routes/template.routes.ts:203, 262, 296` calls `enforceReauth('CREATE_ASSET_TEMPLATE')` etc. |
| Shared types | constants not declared |
| Effect | `isReauthRequired()` permanently returns `false` for all three. Reauth gate is permanently OFF for asset-template CRUD even though the code looks gated. Asset templates control alarm rules / attribute schemas / cascade across every instance — high blast radius. |
| Fix | Add the three constants to `reauth-actions.ts` (category: `Asset Management`) and rebuild shared. Tracked as **PA-REAUTH-2**. |

### HIGH findings (4 — deferred)

| # | Action | FE | BE | Fix |
|---|---|---|---|---|
| 1 | Super-admin filter-data silent edits | yes | super-admin/routes.ts | Add `enforceReauth('SUPER_ADMIN_DATA_EDIT')` on every PUT/DELETE there + FE wrap |
| 2 | Notification bulk delete | not wrapped | `NOTIFICATION_DELETE` perm only | Add `BULK_DELETE_NOTIFICATIONS` + wrap |
| 3 | Filter-profile CRUD | missing FE | `CREATE/UPDATE/DELETE/ASSIGN_FILTER_PROFILE` gated on BE | No FE consumer — either build UI or remove reauth |
| 4 | PM update (whole-schedule PUT) | missing FE | `UPDATE_PM_SCHEDULE` gated on BE | Confirm route is reachable; build UI or remove |

Items 1-2 are real security gaps; 3-4 are dead-code style gaps.

### MEDIUM findings (2)

| # | Issue | Fix |
|---|---|---|
| 1 | `CREATE_ASSET_RELATIONSHIP` + `DELETE_ASSET_RELATIONSHIP` declared but never used by any code path | Remove from shared types OR wire to the relationship POST/DELETE routes |
| 2 | `UPDATE_SESSION` vs `UPDATE_SESSION_CONFIG` drift in dynamic-config FE | Rename in `apps/web/src/routes/config/dynamic-config.tsx:166` |

### Properly wired (~75 actions)

All other entries in `reauth-actions.ts` verified to have both BE `enforceReauth` and FE `reauth.execute` call sites with matching names. Full list omitted for length. Notable confirmations of recent fixes:

- `UPDATE_FILTER_LIFECYCLE` (M2 fix from 2026-05-04) — wired correctly
- `EXPORT_BACKUP` / `RESTORE_BACKUP` — wired correctly
- All user-management actions (`DELETE_USER`, `DISABLE_USER`, `ENABLE_USER`, `CREATE_USER`, `UPDATE_USER`, `RESET_PASSWORD`) — wired correctly
- All role-management actions — wired correctly

---

## Section 5 — Permission-constant hygiene

Audit agent inventoried 97 constants in `packages/shared/src/types/permissions.ts` plus 90 privilege entries in `feature-privileges.ts`.

### CRITICAL finding (1)

#### PERMS-C1 — `ASSET_TEMPLATE_CREATE` / `_UPDATE` / `_DELETE` used as strings but not declared

`apps/api/src/modules/assets/routes/template.routes.ts:{162, 217, 277}` calls `requirePermission('ASSET_TEMPLATE_CREATE')` etc. — these literal strings exist nowhere as constants, nowhere in seed.ts. Effect: only SUPER_ADMIN can hit these routes today (via the FE bypass path). ADMIN, despite having `ASSET_CREATE/UPDATE/DELETE`, **cannot edit asset templates**.

**Fix options**:
- **Cheapest**: change route gates to existing `ASSET_CREATE` / `ASSET_UPDATE` / `ASSET_DELETE` (ADMIN immediately gets access; matches the asset-instance posture).
- **Strictest**: declare the three new constants, seed them to SUPER_ADMIN + ADMIN, add privilege entries, add to `FEATURE_TO_PERMISSION_MAP`.

Tracked as **PA-PERMS-1**.

### LOW finding (1)

`BACKUP_EXPORT` is used at `apps/api/src/modules/backup/routes.ts:17` but is not declared as a constant. It works today via the suffix expansion rules (covered by `BACKUP_MANAGE`). Hygiene-only fix: declare it for typing + searchability. **PA-PERMS-2**.

### Categorization totals

| Category | Count |
|---|---|
| Declared constants | 97 |
| Orphan (declared, never used anywhere) | **0** |
| FE-only by design (declared + FE + map-companion BE) | 16 |
| BE-only with no FE flag (low UX impact) | ~8 |
| Missing from seed (intentional, VERSION_HISTORY_VIEW) | 1 |
| Duplicate / overlap | 1 pair (`ASSET_VIEW` vs `ASSET_READ` — documented fallback) |
| Referenced in BE but not declared | **4** (3 asset-template + BACKUP_EXPORT) |
| Privileges declared | 90 |
| Orphan privileges | 0 |
| Privileges mapping to non-existent perms | 0 |

The 2026-05-17 RuleChain + Alarm tear-out (Phase 6) appears to have left the perm file in genuinely good shape — zero true orphans is rare. The only actionable item from this audit is **PERMS-C1**.

---

## Section 6 — Consolidated security risk report

### Production exploit-today list (must fix before next deploy)

Already fixed in this audit pass:

1. ✅ **CRIT** — Notifications bulk delete silently drops data for admins
2. ✅ **CRIT** — Users Edit/Disable/Enable/Unlock visible without permission
3. ✅ **CRIT** — Backup Restore visible to CONFIG_READ users
4. ✅ **CRIT** — Users Edit page Save + Generate Temp Password visible to USER_READ users
5. ✅ **HIGH** — Users Edit button visible without USER_UPDATE
6. ✅ **HIGH** — AHU Dashboard Bulk Upload Filters visible without permission
7. ✅ **HIGH** — `POST /api/data/rpc` MQTT command publish reachable by any operator (no permission gate)
8. ✅ **HIGH** — `GET /api/data/rpc/response/:requestId` reachable by any operator

### Production exploit-today list (NOT yet fixed — tracked for next session)

| ID | Severity | Issue | Fix scope |
|---|---|---|---|
| PA-REAUTH-1 | CRITICAL | `UPDATE_UNS_PATH` FE name doesn't match shared types — reauth never pre-prompts | 1-line FE rename |
| PA-REAUTH-2 | CRITICAL | `CREATE/UPDATE/DELETE_ASSET_TEMPLATE` reauth permanently OFF (not declared in shared types) | Add 3 constants to `reauth-actions.ts` + shared rebuild |
| PA-PERMS-1 | CRITICAL | `ASSET_TEMPLATE_CREATE/UPDATE/DELETE` permission gates non-functional (constants not declared) | Either collapse to existing `ASSET_*` perms OR add new constants + seed + privileges |

### Second pass — all "Deferred" items fixed 2026-05-26 commit `tbd`

| ID | Severity | Original issue | Status |
|---|---|---|---|
| PA-FE-1 | HIGH | 7 config pages leak Save controls to CONFIG_READ users | ✅ All 7 gated on `CONFIG_UPDATE` (or `PM_UPDATE` for ahu-filter-set-config) |
| PA-BE-1 | MEDIUM | `GET /api/config/field-ids` ungated | ✅ Gated on `CONFIG_READ` |
| PA-REAUTH-3 | HIGH | Super-admin filter-data routes silent-edit with no reauth | ✅ All 18 mutations now `enforceReauth('SUPER_ADMIN_DATA_EDIT')` via shared preHandler |
| PA-REAUTH-4 | HIGH | Notification bulk-delete missing reauth | ✅ Added `BULK_DELETE_NOTIFICATIONS` + `DELETE_NOTIFICATION` reauth, BE enforce + FE wrap |
| PA-CLEANUP-1 | MEDIUM | 2 PDF export buttons ungated | ✅ Gated on `REPORT_EXPORT` / `REPORT_GENERATE` |
| PA-CLEANUP-2 | MEDIUM | `UPDATE_SESSION` vs `UPDATE_SESSION_CONFIG` drift | ✅ Override map added in dynamic-config.tsx |
| PA-CLEANUP-3 | LOW | `BACKUP_EXPORT` not declared as constant | ✅ Declared |
| PA-CLEANUP-4 | LOW | `CREATE_ASSET_RELATIONSHIP` / `DELETE_ASSET_RELATIONSHIP` dead | ✅ Removed from reauth-actions.ts |
| PA-REAUTH-1 | CRITICAL | `UPDATE_UNS_PATH` FE name doesn't match shared types | ✅ Renamed to `OVERRIDE_UNS_PATH` in uns.tsx |
| PA-REAUTH-2 | CRITICAL | `CREATE/UPDATE/DELETE_ASSET_TEMPLATE` reauth permanently OFF | ✅ Resolved — dead routes deleted entirely (asset-template editing UI was removed Phase 1) |
| PA-PERMS-1 | CRITICAL | `ASSET_TEMPLATE_CREATE/UPDATE/DELETE` not declared | ✅ Resolved — same as PA-REAUTH-2; the three POST/PUT/DELETE template routes were dead since Phase 1 and have been removed from `template.routes.ts`. The GET endpoints (still consumed by FE for template-kind lookup) remain on `ASSET_VIEW`. Audit-action constants `ASSET_TEMPLATE_CREATED/UPDATED/DELETED` retained in shared types for 21 CFR §11 historic-row rendering. |

---

## Section 7 — Safe cleanup plan

Three follow-up engagements, prioritized:

### Engagement A — Critical reauth + permission fixes (4 hours)

1. **PA-REAUTH-2 + PA-PERMS-1** — add `CREATE/UPDATE/DELETE_ASSET_TEMPLATE` constants (or collapse to `ASSET_*`), seed, rebuild shared. ~2h.
2. **PA-REAUTH-1** — rename FE `'UPDATE_UNS_PATH'` → `'OVERRIDE_UNS_PATH'`. 15 min including grep + retest.
3. **PA-CLEANUP-3** — declare `BACKUP_EXPORT` constant. 5 min.
4. **PA-CLEANUP-4** — decide on relationship reauth actions (delete or wire). 30 min.

Rollback concern: shared package rebuild requires `npx nx build shared` + restart API; otherwise FE refs to new constants fail. Run `npm run build` at root first to verify.

### Engagement B — Config-page Save button gate sweep (1 day)

PA-FE-1 — apply the `user-id.tsx:48` idiom to seven pages. Pattern:

```tsx
const { user } = useAuth();
const perms = (user?.permissions as string[]) ?? [];
const isSuperAdmin = user?.role === 'SUPER_ADMIN';
const canWrite = isSuperAdmin || perms.includes('CONFIG_UPDATE');
// then disable={!canWrite} on every Save / Enable / Test / Add button
```

Rollback concern: none — backend already rejects writes.

### Engagement C — Super-admin data-edit hardening (2 days)

PA-REAUTH-3 — every PUT/DELETE in `super-admin/routes.ts` needs:
1. `enforceReauth('SUPER_ADMIN_DATA_EDIT')` (new action key, declare in shared)
2. Audit log entry (currently "no audit trail" per code comment — 21 CFR §11 concern)
3. FE wrap in `reauth.execute`

Rollback concern: any active SUPER_ADMIN session would need re-auth on the next data-edit. Communicate before deploy.

---

## Executive summary

| Audit dimension | Findings | Fixed | Deferred |
|---|---|---|---|
| Frontend permission gates | 20 issues (5 CRIT / 10 HIGH / 3 MED / 2 LOW) | 8 (5 CRIT + 3 HIGH) | 12 (mostly config-page Save buttons) |
| Backend route guards | 3 issues (0 CRIT / 2 HIGH / 1 MED) | 2 (both HIGH RPC routes) | 1 (field-ids GET) |
| Reauthentication coverage | 8 issues (2 CRIT / 4 HIGH / 2 MED) | 0 | 8 (need shared rebuild) |
| Permission constants | 2 issues (1 CRIT / 1 LOW) | 0 | 2 (need shared rebuild) |
| **Reported bugs** | 2 | 2 | 0 |

**Net production posture**: every CRITICAL UI-level leak that operators could see + act on is fixed (Users, Backup, AHU dashboard, Data Ingestion RPC). The remaining CRITICAL items (PA-REAUTH-1/2 + PA-PERMS-1) are about *gates that look protective in source but are actually disabled*; they require shared-package rebuild and are tracked for the next engagement.

**Recommended next step**: Engagement A (4 hours) closes the three remaining CRITICAL items and restores effective reauth/permission enforcement on asset-template edits and UNS path overrides.
