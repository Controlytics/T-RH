# CRUD-coverage audit — 2026-05-09

Audit of Create / Read / Update / Delete / Reauth coverage across 4 entities. Backend endpoints checked against actual FE call sites. Code-grounded — every claim cites file:line.

| Entity | BE endpoints | FE pages | Real gaps |
|---|---|---|---|
| Checklists | 11 (incl. nested questions + version history) | 4 | 1 metadata-edit, 1 reauth on standalone form |
| Cleaning Profiles | 11 | 3 | DELETE button missing + 2 unused endpoints |
| Equipment Groups | 8 | 3 | none — fully wired |
| PM Schedules | 16 across 5 sub-entities | 4 | 2 orphan endpoints + 3 missing reauth |

---

## 1. Checklists

### Coverage matrix

| Op | BE | FE | Status |
|---|---|---|---|
| Create profile | `POST /api/checklist-profiles` (`routes.ts:23-31`) | `checklist-admin/list.tsx` modal | ✅ |
| List | `GET /api/checklist-profiles` | `checklist-admin/list.tsx` | ✅ |
| Detail | `GET /api/checklist-profiles/:id` | `checklist-admin/detail.tsx` | ✅ |
| **Edit profile metadata** (name/description/isActive) | `PUT /api/checklist-profiles/:id` (`routes.ts:33-40`) | **NO UI** — detail page is read-only for metadata | ⚠️ **GAP** |
| Delete profile | `DELETE /api/checklist-profiles/:id` | `checklist-admin/list.tsx` delete button | ✅ |
| Question CRUD | POST/PUT/DELETE `:id/questions[/:qId]` | `checklist-admin/detail.tsx` Add/Edit/Delete | ✅ |
| Reorder questions | `PUT :id/reorder` | `checklist-admin/detail.tsx` up/down arrows | ✅ |
| Version history | `GET :id/versions[/:n]` | `version-history/index.tsx` | ✅ |

### Real gaps

1. **No metadata-edit UI on `checklist-admin/detail.tsx`** — the BE `PUT /:id` accepts name / description / isActive and the FE renders these as read-only labels. Operators have to delete + recreate to rename a profile.
2. **`POST /api/data/checklist` (standalone entity-checklist form at `checklist-form/index.tsx:167`) is NOT reauth-wrapped** — the cycle-bound `POST /api/filters/:id/submit-checklist` IS wrapped with `SUBMIT_CHECKLIST_WITH_SIGNATURE`. Two parallel submission paths with inconsistent reauth posture.

---

## 2. Cleaning Profiles

### Coverage matrix

| Op | BE | FE | Status |
|---|---|---|---|
| Create | `POST /api/filter-cleaning-profiles` | `cleaning-profile-editor.tsx` (id="new") | ✅ |
| List | `GET /api/filter-cleaning-profiles` | `cleaning-profile-list.tsx` | ✅ |
| Detail | `GET /:id` | `cleaning-profile-editor.tsx` (UUID) | ✅ |
| Update (snapshot+bump) | `PUT /:id` | `cleaning-profile-editor.tsx` save | ✅ |
| Toggle ACTIVE/INACTIVE | `PATCH /:id/toggle-status` | `cleaning-profile-list.tsx:196-200` | ✅ |
| **Delete** | `DELETE /:id` (`routes.ts:191`) — reauth `DELETE_CLEANING_PROFILE` | **`canDelete` perm checked at `cleaning-profile-list.tsx:25` but NO delete button rendered** | ⚠️ **GAP** |
| Version history | `GET /:id/versions[/:n]` | `version-history/index.tsx` | ✅ |
| **Validate pipeline** | `POST /:id/validate` (`routes.ts:320`) | **No FE caller** — editor validates client-side | ⚠️ orphan |
| **Assigned-assets view** | `GET /:id/assigned-assets` (`routes.ts:215`) | **No UI** | ⚠️ orphan |
| **Assigned-assets bulk-assign** | `POST /:id/assign-assets` (`routes.ts:237`) | **No UI** | ⚠️ orphan |

### Real gaps

1. **DELETE button missing** — `cleaning-profile-list.tsx:25` reads `canDelete` but never renders a delete control. Backend route + reauth gate are live; archive logic blocks delete if any FilterProfile or CleaningCycle references the profile (clean 409 IN_USE response).
2. **3 orphan endpoints** — `/validate`, `/assigned-assets` (GET), `/assign-assets` (POST). Either expose them in UI or delete them.

---

## 3. Equipment Groups

### Coverage matrix

| Op | BE | FE | Status |
|---|---|---|---|
| Create | `POST /api/equipment-groups` (reauth `CREATE_EQUIPMENT_GROUP`) | `config/equipment-groups.tsx` "+ New Group" | ✅ |
| List by block | `GET /api/equipment-groups?blockId=` | `config/equipment-groups.tsx` | ✅ |
| List for filter-ops dropdown | `GET /api/equipment-groups` (raw array) | `filter-operations.tsx`, `mobile-operations.tsx`, `offline-sync-service.ts` | ✅ |
| List by block (specific) | `GET /api/equipment-groups/by-block/:blockId` | `filter-operations.tsx:898,978`, `mobile-operations.tsx` | ✅ |
| Detail | `GET /:id` | (loaded inline by list page) | ✅ |
| Update (snapshot+bump composite) | `PUT /:id` (reauth `UPDATE_EQUIPMENT_GROUP`) | `config/equipment-groups.tsx` Edit | ✅ |
| Delete | `DELETE /:id` (reauth `DELETE_EQUIPMENT_GROUP`) | `config/equipment-groups.tsx` Delete | ✅ |
| Version history | `GET /:id/versions[/:n]` | `version-history/index.tsx` Equipment Groups tab | ✅ |
| M8 soft-lock dialog (active cycle warning) | (FE-only, `GET /api/filters/cycles?status=IN_PROGRESS`) | `config/equipment-groups.tsx:73-514` | ✅ |

### Real gaps

**None.** Everything wired. Two design notes:

- Per-instrument `stageKey` is fixed by index in code (`equipment-groups.service.ts:76-80`): WASH_IN/WASH_IN/DRY_IN. Not user-editable. Intentional.
- `update()` does NOT block when bound to active cycles — Phase A.4 snapshot-then-bump pins the cycles to the prior version's snapshot, so mid-cycle edits don't reach in-flight cycles. The FE M8 dialog is informational only.

---

## 4. PM Schedules

### Coverage matrix

| Sub-entity | Op | BE | FE | Status |
|---|---|---|---|---|
| **PmSchedule** | List entries | `GET /api/pm-schedules/entries` | `pm-schedules/index.tsx` | ✅ |
| | Detail | `GET /api/pm-schedules/:entityId` | `pm-schedules/detail.tsx` | ✅ |
| | History | `GET /api/pm-schedules/:entityId/history` | (loaded inline) | ✅ |
| | Create | `POST /api/pm-schedules` (reauth `CREATE_PM_SCHEDULE`) | (CSV upload path — no direct create form) | ⚠️ via upload only |
| | **Update schedule** | `PUT /api/pm-schedules/:id` (reauth `UPDATE_PM_SCHEDULE`) | **No FE caller** | ⚠️ **ORPHAN** |
| | **Delete schedule** | `DELETE /api/pm-schedules/:id` (reauth `DELETE_PM_SCHEDULE`) | **No FE caller** | ⚠️ **ORPHAN** |
| **PmScheduleEntry** | Pending counts | `GET /entries/pending-counts` | `pm-schedules/index.tsx` | ✅ |
| | Approve | `POST /entries/approve` (reauth `APPROVE_PM_SCHEDULE`) | `pm-schedules/index.tsx` | ✅ |
| | Reject | `POST /entries/reject` (reauth `REJECT_PM_SCHEDULE`) | `pm-schedules/index.tsx` | ✅ |
| | Edit entry | `PUT /entries/:id/edit` (reauth `EDIT_PM_SCHEDULE`) | `pm-schedules/index.tsx` | ✅ |
| | **Resubmit entry** | `POST /entries/:id/resubmit` (`routes.ts:234`) | `pm-schedules/index.tsx` | ⚠️ **NO REAUTH** |
| **PmExecution** | **Create execution** | `POST /api/pm-executions` (`execution-routes.ts:21`) | `pm-schedules/detail.tsx:20` | ⚠️ **NO REAUTH** |
| | (PUT `/:id`) | **REMOVED** in commit b8fb038 (status derived from cycle timestamps) | n/a | intentional |
| **My Tasks** | Due list | `GET /api/pm-schedules/due` | `routes/my-tasks/index.tsx` | ✅ |
| **AHU config** | List | `GET /api/pm-schedules/ahu-configs` | `config/ahu-filter-set-config.tsx` | ✅ |
| | Update mode | `PUT /api/pm-schedules/ahu-configs/:ahuId` (reauth `UPDATE_CONFIG_PAGE`) | `config/ahu-filter-set-config.tsx` | ✅ |
| **Bulk** | Download template CSV | `GET /api/pm-schedules/template.csv` | `pm-schedules/index.tsx` | ✅ |
| | **Upload CSV** | `POST /api/pm-schedules/upload` (`routes.ts:30`) | `pm-schedules/index.tsx` | ⚠️ **NO REAUTH** |

### Real gaps

1. **`PUT /api/pm-schedules/:id` is orphan** — BE accepts updates with reauth gate; no FE page calls it. Operators cannot edit a schedule's metadata after creation; they can only edit individual `PmScheduleEntry` rows.
2. **`DELETE /api/pm-schedules/:id` is orphan** — same shape. Soft-lock at `pm-schedule-crud.ts:138` blocks delete if any execution is `IN_PROGRESS` (per design); but even when permitted, no FE button exists. Schedules accumulate forever.
3. **`POST /api/pm-executions` has no reauth** — starts a PM task (creates an immutable execution row). Compare to the cycle-bound flows (start-cycle / advance / submit-checklist) which all reauth-wrap.
4. **`POST /api/pm-schedules/upload` (bulk CSV) has no reauth** — and per `pm-import.ts:133`, SUPER_ADMIN uploads auto-approve all entries, skipping the approval workflow. A SUPER_ADMIN can blast hundreds of entries with no password challenge.
5. **`POST /api/pm-schedules/entries/:id/resubmit` has no reauth** — flips a REJECTED entry back to PENDING. Minor compared to #3/#4.
6. **No "Create PM Schedule" form** — the only path to create a schedule is bulk CSV upload. Operators who want a single schedule must hand-craft a CSV.

---

## Consolidated action list (ranked by impact)

### High (compliance / data hygiene)

1. **PM bulk-upload reauth** — `POST /api/pm-schedules/upload`. SUPER_ADMIN auto-approve makes this a high-trust mutation; password challenge is consistent with every other bulk admin action on the branch.
2. **PM execution-create reauth** — `POST /api/pm-executions`. Reuse `START_PM_TASK` action key (declare new) or merge under `PM_APPROVE`/`UPDATE_PM_SCHEDULE`.
3. **Add cleaning-profile DELETE button** — wires the existing reauth-gated route. Use the same pattern as `equipment-groups.tsx` delete.
4. **PM schedule update + delete UI** — wire FE for the existing `PUT/DELETE /api/pm-schedules/:id` so single-schedule edits + retirement work without DB intervention.

### Medium (UX completeness)

5. **Checklist profile metadata edit UI** — wire FE for `PUT /api/checklist-profiles/:id` (name/description/isActive).
6. **Add a single-PM-schedule create form** — currently bulk-upload only. CSV path stays for batch; new form for one-off.
7. **PM resubmit reauth** — minor state change but inconsistent with approve/reject (which DO reauth).

### Low (cleanup)

8. **Cleaning profiles** — decide on the 3 orphan endpoints (`/validate`, `/assigned-assets` GET, `/assign-assets` POST). Either build the UI or delete the routes. Dead routes are still attack surface.
9. **Standalone checklist form reauth posture** — `POST /api/data/checklist` vs `/api/filters/:id/submit-checklist` should match. Pick one or document the divergence.

### Already-correct / intentional

- Equipment Groups — all 8 endpoints wired, all reauth-protected, M8 soft-lock live, version history surfaced.
- PM `PUT /api/pm-executions/:id` — removed by design (status derived from cycle timestamps, not stored).
- Equipment Groups `update()` doesn't 409 on bound cycles — Phase A.4 snapshot-then-bump pins cycles to prior version.

---

## Reference index

| Concern | File |
|---|---|
| Checklist routes | `apps/api/src/modules/checklist-profiles/routes.ts` |
| Checklist FE | `apps/web/src/routes/checklist-admin/{list,detail}.tsx`, `apps/web/src/routes/checklist-form/index.tsx` |
| Cleaning profile routes | `apps/api/src/modules/cleaning-profiles/routes.ts` |
| Cleaning profile FE | `apps/web/src/routes/filter-management/cleaning-profile-{list,editor}.tsx` |
| Equipment groups routes | `apps/api/src/modules/equipment-groups/routes.ts` |
| Equipment groups FE | `apps/web/src/routes/config/equipment-groups.tsx` |
| PM schedules routes | `apps/api/src/modules/pm-schedules/routes.ts`, `execution-routes.ts`, `pm-schedule-crud.ts`, `pm-import.ts` |
| PM FE | `apps/web/src/routes/pm-schedules/{index,detail}.tsx`, `apps/web/src/routes/my-tasks/index.tsx`, `apps/web/src/routes/config/ahu-filter-set-config.tsx` |
| Version history (cross-entity viewer) | `apps/web/src/routes/version-history/index.tsx` |
