# Dashboard Builder — Phase 1 (many dashboards, alarm table) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A SUPER_ADMIN creates named dashboards (a sidebar page "Dashboards") over a profile, a location, a fixed list or all instruments, fills each with the existing four widget types plus a new alarm table, sets a time window, and assigns the dashboard to roles and users, who see only what is assigned to them and only the instruments they can already see.

**Architecture:**
- **Storage.** A dashboard's whole definition is ONE JSON document in the existing `dashboards.layout` column, validated by one strict shared parser on write and read back through one forgiving shared reader. There is no migration.
- **Server.** `/api/dashboards` is rewritten: whole-document saves, SUPER_ADMIN-only writes checked by role, assignment-only reads, an optimistic `expectedUpdatedAt`, and per-widget audit rows diffed in the transaction.
- **Data.** Every widget's data comes from the existing instrument and alarm routes. Two of them gain filters (`profileId`, `instrumentIds`, and a direct-only flag for alarms).
- **Web.** The renderers, dialog and grid from widget-data-keys phase 2 are reused unchanged in shape. Their `selection` prop is widened to carry a dashboard source and window.

**Tech Stack:**
- Web: React 19, SWR, react-grid-layout 2.2.4, Tailwind v4.
- API: Fastify 5, Prisma.
- Shared: zod in `@digilog/shared`.
- Tests: vitest (jsdom for the web, `app.inject` for e2e).

**Spec:** `docs/superpowers/specs/2026-10-29-dashboard-builder-design.md` (§4–§10 for phase 1; §11 lists the calls made). Precedent plan for shape and test style: `docs/superpowers/plans/2026-10-28-widget-data-keys-phase2.md`.

## Global Constraints

- **Only a SUPER_ADMIN creates, changes, duplicates, deletes or assigns a dashboard.**
  - Every write route checks `req.user.role === 'SUPER_ADMIN'` FIRST and answers 403 `DASHBOARDS_SUPER_ADMIN_ONLY`: "Only a super admin can create, change, assign or delete dashboards."
  - The check holds whatever `DASHBOARD_*` grants the caller has. AWS still owes the 2026-10-24 permission strip, so ADMIN may hold them there.
- **Seeing a dashboard needs `DASHBOARD_VIEW` + an active row + an assignment** to the caller's user id or role.
  - SUPER_ADMIN sees every active dashboard. ADMIN is not special. No assignment means none.
  - Anything not visible is a 404, never a 403.
- **A dashboard grants nothing.** Its data comes only from the existing routes, under the viewer's own permissions and instrument scope:
  - `telemetry-overview`, `latest-values`, `data-keys`, `/:id/telemetry`, `telemetry-history`, `/api/alarms`.
- **Instrument sets** (spec §4):
  - Dashboard source: `{mode:'all'} | {mode:'profile', profileId} | {mode:'location', functionalLocationId, directOnly} | {mode:'instruments', ids (1..200)}`.
  - A source that is unreadable, or names a profile or location that no longer exists, shows NO instruments — never all of them.
- **Time window:** `{mode:'relative', period}` (a `PERIOD_PRESETS` value) or `{mode:'fixed', from, to}`. The default is `{mode:'relative', period:'24h'}`.
  - Only the trend chart and the time-series table follow it, and only when their `options.period` is absent.
  - Value cards, the latest table and the alarm table take no window.
- **Two document readers, never swapped:**
  - `parseDashboardDocument` (strict, every write): a 400 with a message naming the widget.
  - `readDashboardDocument` (forgiving, every read): it drops a bad widget with its item and keeps the rest.
- **Home dashboard `/` is untouched**, except that its Add widget dialog offers the alarm table. On `/`, an alarm table is placed only when the viewer has BOTH the `custom_widgets` and `dashboard_alarms` panels, and the server's `resolveLayout` decides that.
- **Fastify strips undeclared response fields.**
  - Declare every field and every inner key.
  - Declare `document` as `{ type: 'object', additionalProperties: true }`, the `WIDGETS_JSON_SCHEMA` precedent; zod validates its shape.
- **Audit:**
  - Reuse the eight registered actions (`DASHBOARD_CREATED` / `UPDATED` / `DELETED`, `DASHBOARD_WIDGET_CREATED` / `UPDATED` / `DELETED`, `DASHBOARD_ASSIGNED` / `UNASSIGNED`).
  - Every `beforeValue` / `afterValue` carries `name`: the dashboard's title, or a widget row's widget title.
  - Each write and its rows go in ONE transaction (`auditLog(entry, tx)`).
  - `signatureMeaning` is ≤ 255 chars (`VARCHAR(255)`, raw insert — a longer one is a 500).
- **Re-auth:** a new action `UPDATE_DASHBOARD` (`Configuration`, ships OFF) on every write route via `enforceReauth`. The web sends it through `reauth.execute('UPDATE_DASHBOARD', …)` with `onSuccess`, `onError` AND `onCancel`; `hooks/__tests__/reauth-callers-declare-cancel.test.ts` enforces this.
- **No migration**, no new model, enum, permission, audit action or config def. `dashboard_widgets` is left unused, not dropped.
- **Counts that move:**
  - re-auth actions 56 → 57;
  - shared type files 37 → 38;
  - sidebar items 14 → 15;
  - permission-tree groups 14 → 15;
  - `<Route`s 54 → 56;
  - `/api/dashboards` routes 13 → 7.

  Tree nodes stay 56 and feature privileges stay 39: the new group reuses `dashboard.view` (Ruling D1).
- **Tests:**
  - Shared: `cd packages/shared && npx vitest run <file>`, then `npm run build -w @digilog/shared`.
  - API: one file at a time, `cd apps/api && npx vitest run <file> --pool=forks --poolOptions.forks.singleFork=true`, judged by EXIT CODE. Each e2e file owns its super admin, roles, users, profile and instruments, and restores anything it changed in `system_config` FIRST in `afterAll`, each step guarded on its own.
  - Web: ONE file per process, `cd apps/web && npx vitest run <file>`, judged by exit code. SWR mocks return module-level constants.
- **Look:**
  - UI v3 (`PageHero`, `Table` grid, `FormSection`, `DialogBanner`);
  - the dashboard's `PanelCard`;
  - light theme;
  - `useDatetimeFormat()` for every instant;
  - no `alert` / `confirm` (use `Dialog`);
  - every text input gets a distinct `name`.

## Review Focus

1. **An empty or unreadable instrument set must show nothing, not everything.** `GET /api/instruments/telemetry-overview?instrumentIds=` (present, empty) must return `[]`, and the web must not even ask when its list is empty. Absent `instrumentIds` = every visible instrument, as today. Task 2 test: `an empty instrumentIds selects nothing`; Task 5 test: `an empty instrument list makes no overview request`.
2. **A profile or location deleted after the dashboard was built.**
   - The list says `Profile no longer exists` / `Location no longer exists`.
   - The widgets show `No instruments in your view`.
   - Task 3 test: `a source naming a deleted profile is summarised as gone`; Task 2 test: `an unknown profileId selects nothing`.
3. **A 200-character dashboard title with an 80-character widget title** must save, not 500 on the audit insert. Task 3 test: `long titles never overflow signature_meaning`.
4. **Two super admins edit one dashboard.** The second save is a 409 that writes nothing, and the editor keeps their draft with a Reload. Task 3 case `a stale expectedUpdatedAt is a 409`; Task 7 test `a 409 keeps the draft and offers Reload`.
5. **A viewer assigned a dashboard but lacking `ALARM_READ` or `INSTRUMENT_READ`.** That widget prints its error and every other widget renders. Task 7 test: `one widget's 403 leaves the rest drawn`.

---

### Task 1: Shared — the dashboard document, the alarm-table widget type, the re-auth action

**Files:**
- Create: `packages/shared/src/types/dashboard-document.ts`, `packages/shared/src/types/dashboard-document.test.ts`
- Modify: `packages/shared/src/types/dashboard-widgets.ts` (+ its test): `alarm_table`, the keys rule, `options.status`
- Modify: `packages/shared/src/types/dashboard-layout.ts` (+ its test):
  - export `readItem`, `readWidgets` and `pairWidgets` for reuse;
  - `resolveLayout` drops an `alarm_table` item without the `dashboard_alarms` panel.
- Modify: `packages/shared/src/types/reauth-actions.ts`, `packages/shared/src/index.ts`
- Moves on purpose: `packages/shared/src/types/reauth-actions.test.ts:32` pins `toHaveLength(56)`, which becomes 57. It is the ONLY expected red; any other red is yours to explain.

**Interfaces:**
- Produces (`dashboard-widgets.ts`):
  - `WIDGET_TYPES` gains `'alarm_table'`, appended LAST.
  - `WIDGET_ALARM_STATUSES = ['active-unack', 'active-ack', 'cleared-unack', 'cleared-ack'] as const`.
  - `customWidgetSchema.options` gains `status?: one of WIDGET_ALARM_STATUSES`.
  - `keys` loses `.min(1)`. The `superRefine` adds:
    - a non-alarm type with 0 keys: `Choose at least one key` (path `['keys']`, the existing wording);
    - an `alarm_table` with any key: `An alarm table takes no keys`;
    - an `alarm_table` with `period`: `An alarm table has no period`;
    - any other type with `status`: `Only an alarm table has a status filter`.
- Produces (`dashboard-document.ts`):
  - `DASHBOARD_DOCUMENT_VERSION = 1`
  - `DASHBOARD_SOURCE_INSTRUMENTS_MAX = 200`
  - `dashboardSourceSchema` (discriminated on `mode`):
    - `{mode:'all'}`
    - `{mode:'profile', profileId: uuid}`
    - `{mode:'location', functionalLocationId: uuid, directOnly: boolean (default false)}`
    - `{mode:'instruments', ids: uuid[] 1..200, deduplicated}`

    Plus `type DashboardSource`.
  - `dashboardTimeWindowSchema`:
    - `{mode:'relative', period: PERIOD_PRESETS value}`
    - `{mode:'fixed', from: ISO datetime, to: ISO datetime}`, refined so that `from < to` (`The window must end after it starts`)

    Plus `type DashboardTimeWindow`, and `DEFAULT_DASHBOARD_WINDOW = {mode:'relative', period:'24h'}`.
  - `interface DashboardDocument { version: 1; source: DashboardSource; timeWindow: DashboardTimeWindow; items: LayoutItem[]; widgets: CustomWidget[] }`
  - `type StoredDashboardDocument = Omit<DashboardDocument, 'source'> & { source: DashboardSource | null }`. `null` = unreadable.
  - `emptyDashboardDocument(): DashboardDocument` → source `all`, the default window, no items, no widgets.
  - `parseDashboardDocument(v: unknown): { ok: true; document: DashboardDocument } | { ok: false; message: string }`
  - `readDashboardDocument(v: unknown): StoredDashboardDocument`
  - `diffWidgets(before: readonly CustomWidget[], after: readonly CustomWidget[]): { created: CustomWidget[]; updated: { before: CustomWidget; after: CustomWidget }[]; deleted: CustomWidget[] }`
    - Matched by `id`. "Updated" means `!widgetsEqual([b], [a])`.
  - The wire types both sides use (Task 3 serves them, Tasks 6–8 read them):
    - `DashboardSourceSummary = { mode: 'all' | 'profile' | 'location' | 'instruments' | 'unreadable'; label: string }`
    - `DashboardSummary = { id: string; title: string; description: string | null; sourceSummary: DashboardSourceSummary; widgetCount: number; updatedAt: string; assignments?: { roles: string[]; users: { id: string; username: string; fullName: string | null }[] } }`
    - `DashboardDetail = DashboardSummary & { document: StoredDashboardDocument }`
- Produces (`dashboard-layout.ts`):
  - `readItem`, `readWidgets` and `pairWidgets` are exported with unchanged behaviour.
  - `resolveLayout` keeps a `w:` item whose widget is an `alarm_table` only when `visiblePanels` includes `'dashboard_alarms'`.
- Produces (`reauth-actions.ts`): `UPDATE_DASHBOARD: { label: 'Update Dashboard (create, edit, delete, assign)', category: 'Configuration' }`.

- [ ] **Step 1: Write the failing tests.**
  - **`dashboard-document.test.ts`:**
    - `parseDashboardDocument` accepts a document holding one widget of each of the five types, with a profile source and a fixed window.
    - It refuses each of these with the stated message, and stores nothing:
      - not an object / wrong version → `Dashboard is not in a form this server can store.`
      - `{mode:'instruments', ids: []}` → message starts `Dashboard instruments:`
      - a fixed window with `to` before `from` → `Time window: The window must end after it starts`
      - an item `telemetry_table` → `Only widgets can be placed on a dashboard`
      - a bad widget → `Widget "<title>": …`
      - 21 widgets
      - a widget not placed → `Widget "<title>" is not placed`
      - an item placing a widget twice
      - an item with no widget
    - `readDashboardDocument`:
      - a stored doc with one bad widget keeps the good widget, its item and the source;
      - a bad source reads as `source: null`, NOT `{mode:'all'}`;
      - a bad window reads as `DEFAULT_DASHBOARD_WINDOW`;
      - `{}` reads as an empty document with `source: null`.
    - `diffWidgets` returns one created, one updated (label changed) and one deleted, and `[]` for an equal list in a different object-key order.
  - **`dashboard-widgets.test.ts`:**
    - an `alarm_table` with `keys: []` and `options.status: 'active-unack'` parses;
    - the three refusals above;
    - a `value_cards` with `keys: []` still fails with `Choose at least one key`;
    - every existing case stays green unedited.
  - **`dashboard-layout.test.ts`:** `an alarm table needs the dashboard_alarms panel`.
    - With visible = `['custom_widgets', 'telemetry_table']`, a role layout holding an `alarm_table` widget and a `value_cards` widget resolves to the value cards' item only.
    - Adding `'dashboard_alarms'` keeps both.
- [ ] **Step 2: Run** each of the three files. Expected: FAIL (module missing; new cases red).
- [ ] **Step 3: Implement.** `parseDashboardDocument` reuses `readItem` (an unreadable item is a refusal) and then requires `isWidgetItem`. Its widget rules reuse `parseLayoutForWrite`'s messages word for word. `readDashboardDocument` reuses `readWidgets` + `pairWidgets`.
- [ ] **Step 4: Run** the three files (PASS), the whole shared suite `npx vitest run` (exit 0), `npm run build -w @digilog/shared` (exit 0), and `npm run lint` in `packages/shared` (exit 0).
- [ ] **Step 5: Commit** `feat(shared): dashboard document contract, alarm table widget type, UPDATE_DASHBOARD re-auth`.

---

### Task 2: API — the overview and the alarm list take a profile, an id list, and (alarms) direct-only

**Files:**
- Create: `apps/api/src/lib/uuid-list.ts`, `apps/api/src/lib/__tests__/uuid-list.test.ts`
- Modify: `apps/api/src/modules/instruments/routes.ts` (the `/telemetry-overview` querystring + handler), `apps/api/src/modules/instruments/telemetry-overview.ts` (`buildTelemetryOverview` opts)
- Modify: `apps/api/src/modules/alarms/list-query.ts` (+ `__tests__/list-query.test.ts`), `apps/api/src/modules/alarms/routes.ts` (the `GET /` querystring + location branch)
- Create: `apps/api/src/e2e/dashboard-source-filters.e2e.test.ts`
- Must stay green unedited: `src/e2e/telemetry-overview.e2e.test.ts`, `src/e2e/alarm-list-filters.e2e.test.ts`, `src/e2e/data-keys.e2e.test.ts`

**Interfaces:**
- Produces:
  - `parseUuidList(raw: string | undefined, max: number): { ids?: string[]; error?: string }`
    - `undefined` → `{}` (absent).
    - `''` → `{ ids: [] }` (present and empty selects NOTHING).
    - Otherwise: trim each entry, drop empty entries, and deduplicate.
    - A non-uuid entry → `error: 'instrumentIds must be instrument ids'`.
    - More than `max` → `error: 'At most <max> instrumentIds'`.
  - `buildTelemetryOverview` opts gain `profileId?: string`, ANDed as `{ profileId }` like the other selection parts.
  - `GET /api/instruments/telemetry-overview`:
    - gains `profileId` (uuid format) and `instrumentIds` (string, at most 200);
    - a bad list is a 400 `VALIDATION_ERROR` with that message;
    - both are ANDed with the existing filters and with visibility.
  - `AlarmListQuery` gains `instrumentIds?: string[]` and `profileId?: string`.
    - `parseAlarmListQuery` fills them using `parseUuidList(…, 200)`.
    - An error goes to `q.error` with `field: 'instrumentIds'` / `'profileId'`.
    - `buildAlarmWhere` ANDs `{ instrumentId: { in } }` and `{ instrument: { profileId } }`. The `counts` query follows automatically.
  - `GET /api/alarms`:
    - gains `instrumentIds`, `profileId` (uuid) and `functionalLocationDirect` (`'true'|'false'`);
    - with `functionalLocationDirect=true`, `locationIds = [functionalLocationId]` and no `resolveLocationIds`.

- [ ] **Step 1: Write the failing tests.**
  - **`uuid-list.test.ts`:** the five rules above.
  - **`list-query.test.ts`:** a parsed `instrumentIds` / `profileId` lands in the where; a bad id is `q.error.field === 'instrumentIds'`.
  - **`dashboard-source-filters.e2e.test.ts`**, which owns:
    - SA `dsf_sa_<S>`;
    - profiles P and Q;
    - Block K with direct instrument C (profile P);
    - Area X under K with instrument A (P);
    - Area Y with instrument B (Q);
    - one ACTIVE alarm on each of A, B, C (seeded the way `alarm-list-filters.e2e.test.ts` seeds them);
    - a role `DSF_OP_<S>` holding `INSTRUMENT_READ` + `ALARM_READ`, scoped to Area X (`instrument_scope`, `invalidateRolePermsCache`), and its user.

    Cases:
    1. `overview by profile`: SA `?profileId=P` returns A and C only.
    2. `overview by id list, inside scope`: the OPERATOR sends `?instrumentIds=A,B` and gets A only (positive control: A present).
    3. `an empty instrumentIds selects nothing`: `?instrumentIds=` returns `data: []`.
    4. `an unknown profileId selects nothing`: a random uuid returns `[]`.
    5. `a bad id list is a 400`: `?instrumentIds=nope` → 400. 201 ids → 400.
    6. `alarms by id list and by profile`: `instrumentIds=A,B` → A's and B's; `profileId=P` → A's and C's; `counts` agree with each.
    7. `alarms direct-only`: `functionalLocationId=K` → A's and C's; with `&functionalLocationDirect=true` → C's only.
    8. `alarm filters stay inside scope`: the OPERATOR sends `instrumentIds=A,B` → A's only.
- [ ] **Step 2: Run** the three files. Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces. Declare the new querystring properties. The response schemas do not change.
- [ ] **Step 4: Run:**
  - the new files (PASS);
  - then the three must-stay-green files, one at a time (PASS);
  - `npm run lint` (exit 0).
- [ ] **Step 5: Mutation check** (restore from a backup copy, never `git checkout`). Record each in the ledger.
  - Make `''` read as absent → case 3 fails.
  - Drop the visibility AND on the overview → case 2 fails.
  - Ignore `functionalLocationDirect` → case 7 fails.
- [ ] **Step 6: Commit** `feat(api): overview and alarm list filter by profile and id list; alarms direct-only`.

---

### Task 3: API — `/api/dashboards` rewritten

**Files:**
- Modify (rewrite): `apps/api/src/modules/dashboards/routes.ts`
- Create: `apps/api/src/modules/dashboards/service.ts` (visibility where, source summaries, assignment reads, audit row builders), `apps/api/src/modules/dashboards/schemas.ts` (JSON response schemas)
- Rewrite: `apps/api/src/e2e/dashboards-module.e2e.test.ts` (it pins the OLD rules on purpose — spec §9), `apps/api/src/modules/dashboards/__tests__/mass-assignment.test.ts`

**Interfaces:**
- Consumes (Task 1): `parseDashboardDocument`, `readDashboardDocument`, `emptyDashboardDocument`, `diffWidgets`, `widgetItemId`.
- Produces (all under `/api/dashboards`; reads need `DASHBOARD_VIEW`):
  - `DashboardSummary` / `DashboardDetail` (Task 1's types) are the response shapes.
    - `assignments` is sent to a SUPER_ADMIN only.
  - `sourceSummary.label` reads:
    - `All instruments`;
    - the profile name, or `Profile no longer exists`;
    - the location name, plus ` (direct only)` when `directOnly`, or `Location no longer exists`;
    - `<n> instruments`;
    - `Instruments could not be read` (mode `unreadable`, for a `null` source).
  - Routes:
    - `GET /` → `{ data: DashboardSummary[] }`, ordered by title, case-insensitive. No paging.
    - `GET /:id` → `DashboardDetail`. 404 `DASHBOARD_NOT_FOUND` when not visible.
    - `POST /` body `{ title: trimmed 1..200, description?: ≤500, document?: unknown }` → 201 detail.
    - `POST /:id/duplicate` → 201 detail:
      - title `<title> (copy)`, cut to 200;
      - every widget gets a fresh `crypto.randomUUID()`, and its item is re-pointed;
      - no assignments.
    - `PUT /:id` body `{ title?, description?: string | null, document?, expectedUpdatedAt: date-time (required) }`, `additionalProperties: false` → 200 detail.
    - `DELETE /:id` → `{ success: true }` (soft delete).
    - `PUT /:id/assignments` body `{ roles: string[] ≤50 unique, userIds: uuid[] ≤500 unique }` → `{ roles, users }`.
  - **Write order:**
    1. the role check (403);
    2. the row must exist and be active (404);
    3. `enforceReauth('UPDATE_DASHBOARD')`;
    4. validation (400 `VALIDATION_ERROR`);
    5. the transaction.
  - **PUT concurrency:** the update is `updateMany({ where: { id, isActive: true, updatedAt: expectedUpdatedAt } })` inside the transaction.
    - A count of 0 is a 409 `DASHBOARD_CHANGED`: "This dashboard was changed by someone else. Reload it and make your change again." It writes nothing.
    - A PUT whose title, description and document all equal the stored ones is a 200 with no write and no audit row.
  - **Assignments:**
    - roles must exist in `roles.name`, and users in `users.id` (400 names the first unknown one);
    - only the difference is written;
    - an unchanged set writes nothing.
  - **Audit rows** (all in the write's transaction):
    - CREATED: `afterValue { name, description, source, widgetCount }` + a `DASHBOARD_WIDGET_CREATED` per initial widget.
    - UPDATED (only when title, description, source, window or items changed): before/after `{ name, description, source, timeWindow, widgetCount, items }`.
    - WIDGET_CREATED / UPDATED / DELETED: one per `diffWidgets` entry, `{ name: widget.title, dashboard: title, widget }`.
    - ASSIGNED / UNASSIGNED: one per added/removed role or user, `afterValue` / `beforeValue` `{ name: title, assignee: { type: 'ROLE', role } | { type: 'USER', userId, username } }`.
    - DELETED: `beforeValue { name, … }`.
    - `targetType: 'dashboard'`, `targetId` = the dashboard id.
    - `signatureMeaning` is built through one `meaning(text)` that cuts to 255.
- Retired (deleted from the file): every `/:id/widgets…` route, `PUT /:id/layout`, `POST /:id/assign`, `DELETE /:dashboardId/assign/:assignmentId`, `GET /:id/data/:widgetId` and `GET /widget-types`.

- [ ] **Step 1: Write the failing e2e.** The file owns:
  - SA `dbm_sa_<S>`;
  - role `DBM_VIEW_<S>` (`DASHBOARD_VIEW`, `INSTRUMENT_READ`) with users `v1` and `v2`;
  - role `DBM_MGR_<S>` (`DASHBOARD_VIEW`, `DASHBOARD_CREATE`, `DASHBOARD_MANAGE`, `DASHBOARD_ASSIGN`, hierarchy level 5) with user `m1`;
  - a profile `DBM_P_<S>`.

  If it touches `action-reauth` config, it restores that FIRST in `afterAll`. Cases:
  1. `a super admin creates and lists a dashboard`: 201. The list row has `sourceSummary.label === 'All instruments'`, `widgetCount === 0` and `assignments` `{roles: [], users: []}`.
  2. `an unassigned viewer sees none`: `v1`'s list is empty, and `GET /:id` is a 404.
  3. `assignment by role and by user`:
     - assign role `DBM_VIEW` → `v1` and `v2` list it, and their rows carry NO `assignments` key;
     - then assign only user `m1` → `v1`'s list is empty again and `m1` sees it.
  4. `a manager with every DASHBOARD_* grant still cannot write`: `m1` POST / PUT / duplicate / DELETE / assignments → each 403 `DASHBOARDS_SUPER_ADMIN_ONLY`, and the row's `updatedAt` is unchanged.
  5. `the document round-trips`: PUT a document with one widget of each of the five types, a profile source and a fixed window. `GET /:id` `.document` `toEqual`s it, inner keys included.
  6. `a bad document is a 400 and nothing is stored`: a panel-key item, an unplaced widget and a bad source each give 400 with the Task 1 message.
  7. `a stale expectedUpdatedAt is a 409`: nothing is stored and no audit row is written.
  8. `every write is audited with a name`:
     - create → `DASHBOARD_CREATED` with `afterValue.name`;
     - a PUT adding W1, changing W2's label and removing W3 → exactly one WIDGET_CREATED / UPDATED / DELETED, each with `name` = the widget title;
     - a move-only PUT → `DASHBOARD_UPDATED` only;
     - an unchanged PUT → no row;
     - assignments → one ASSIGNED per added role or user, and UNASSIGNED per removed, each with `afterValue.name` / `beforeValue.name`;
     - DELETE → `DASHBOARD_DELETED` with `beforeValue.name`.
  9. `a deleted dashboard is gone`: after DELETE, GET is a 404 (for the SA too), and PUT / DELETE / assignments are 404s.
  10. `duplicate`: new id, `(copy)`, every widget id differs, every item points at its widget, no assignments, and the original is unchanged.
  11. `a source naming a deleted profile is summarised as gone`: a dashboard over a temp profile; the profile is deleted; the summary reads `Profile no longer exists`.
  12. `long titles never overflow signature_meaning`: a 200-character title and an 80-character widget title → create and update are 201 / 200.
  13. `re-auth`: with `UPDATE_DASHBOARD` required, a PUT without a password is refused the way other re-auth routes refuse; the same PUT with the header succeeds.

  `mass-assignment.test.ts`: a PUT carrying `createdBy` / `isDefault` / `createdAt` leaves those columns unchanged.
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces. The visibility `where` for a non-SA is `{ isActive: true, assignments: { some: { OR: [{ assigneeType: 'USER', userId: sub }, { assigneeType: 'ROLE', roleValue: role }] } } }`. `GET /:id`, the list and every write's 404 test use the one function in `service.ts`.
- [ ] **Step 4: Run** both files (PASS); then `src/lib/__tests__/audit-actions-registry.test.ts` (PASS) and `npm run lint` (exit 0).
- [ ] **Step 5: Mutation check** (from a backup copy). Record each in the ledger.
  - Delete the `document` line from the GET `/:id` response schema → case 5 fails.
  - Delete the role check → case 4 fails.
  - Bring back "no assignment sees all" → case 2 fails.
  - Drop `updatedAt` from the `updateMany` where → case 7 fails.
- [ ] **Step 6: Commit** `feat(api): dashboards — whole-document saves, super-admin writes, assignment-only reads`.

---

### Task 4: Concept images — the Dashboards list and a dashboard page (operator rule: images before a new screen)

**Files:**
- Create: `docs/superpowers/concepts/2026-10-29-dashboards/concept-a.png`, `concept-b.png`, `concept-c.png` (+ the throwaway HTML beside them)

- [ ] **Step 1: Build three concepts.** They must differ in layout, not only in colour. Each shows the Dashboards list AND one dashboard page in view mode at 1240 × 880. Both screens are:
  - in the app's UI v3 language (`PageHero` band, `Table` grid, `PanelCard` widgets);
  - filled with plausible data from this plant (Instrument IDs `CWH/RDU/0xx-00`);
  - built from five widgets: value cards, a trend chart, the latest table, the alarm table and the time-series table;
  - with a header carrying the source ("Pressure Sensors · 24 instruments") and the time window.

  Static HTML using the built stylesheet (`apps/web/dist/assets/*.css` after `npx vite build`), screenshotted with headless Chrome.
- [ ] **Step 2: Show the three images to the operator, with no prose beyond a one-line label each, and record the pick in the ledger.** Tasks 6–8 build to the chosen concept. Tasks 1–3 and 5 do not wait for it.

---

### Task 5: Web — widgets follow a dashboard source and window; the alarm table renderer

**Files:**
- Create: `apps/web/src/routes/dashboard/widgets/selection.ts` (+ `__tests__/selection.test.ts`), `apps/web/src/routes/dashboard/widgets/alarm-table-widget.tsx` (+ `__tests__/alarm-table-widget.test.tsx`)
- Modify:
  - `widgets/use-widget-data.ts` (`WidgetSelection`, `useWidgetInstrumentIds`, `CatalogueSelector`, `catalogueUrl`);
  - `routes/dashboard/use-telemetry.ts` (`useTelemetryOverview` opts);
  - `widgets/widget-common.tsx` (`useWidgetRange`, `PeriodSelect`);
  - `widgets/trend-chart-widget.tsx`, `widgets/timeseries-table-widget.tsx` (pass the window);
  - `widgets/widget-panel.tsx` (`WidgetBody`, `WIDGET_EYEBROW`);
  - `widgets/widget-dialog.tsx` (the alarm-table tile, the `followLabel` prop);
  - `routes/dashboard/panel-auto-height.ts` (`autoHeightIds` includes `alarm_table`);
  - `routes/dashboard/selection-alarms.tsx` (an optional `scope` prop).
- Must stay green unedited: `selection-alarms.test.tsx`, every existing `widgets/__tests__/*` file, and `dashboard-widget-controls.test.tsx`.

**Interfaces:**
- Consumes (Task 1): `DashboardSource`, `DashboardTimeWindow`, `WIDGET_ALARM_STATUSES`. Consumes (Task 2): the new query parameters.
- Produces:
  - `WidgetSelection` gains `profileId?: string`, `instrumentIds?: string[]` and `window?: DashboardTimeWindow`.
    - Home keeps passing `{ functionalLocationId, directOnly }`.
  - `selectionForSource(source: DashboardSource | null, window: DashboardTimeWindow): WidgetSelection`:
    - `all` → `{ directOnly: false, window }`;
    - `profile` → `+ profileId`;
    - `location` → `functionalLocationId` + `directOnly`;
    - `instruments` → `instrumentIds: ids`;
    - `null` → `instrumentIds: []`.
  - `useTelemetryOverview(opts)` accepts `profileId?` and `instrumentIds?`.
    - `instrumentIds: []` makes NO request (SWR key `null`) and returns `rows: []`.
    - A non-empty list is sent comma-joined.
  - `CatalogueSelector` gains `{ profileId: string }`. The dialog builds its selector from the selection in this precedence:
    1. `instrumentIds` (empty → `null`);
    2. `profileId`;
    3. location;
    4. `all`.
  - `useWidgetRange(defaultPeriod: string | undefined, window?: DashboardTimeWindow)`:
    - **Following the dashboard:** with no `defaultPeriod` and a `window`, the preset is `'dashboard'`. The range is the window: a relative one is computed exactly like a preset (the same minute rounding), a fixed one is its `from` / `to`.
    - **The picker:** `PeriodSelect` takes `withDashboard?: boolean`, which adds a first option `Dashboard window` (value `'dashboard'`).
    - **Unchanged:** zoom and a chosen preset stay session state. With no `window`, the behaviour is exactly as today.
  - `SelectionAlarms` gains `scope?: { functionalLocationId?: string; directOnly?: boolean; instrumentIds?: string[]; profileId?: string; initialStatus?: (typeof WIDGET_ALARM_STATUSES)[number] }`.
    - With `scope` given, the query carries `functionalLocationId` (+ `functionalLocationDirect=true` when `directOnly`), `instrumentIds` and `profileId`.
    - `instrumentIds: []` makes no request and prints `No instruments in your view`.
    - The status filter starts at `initialStatus`.
    - With `scope` absent, the query is byte-identical to today.
  - `AlarmTableWidget({ widget, selection }: { widget: CustomWidget; selection: WidgetSelection })` renders `SelectionAlarms` with:
    - the source's `ids`, for `instruments` mode;
    - otherwise, the selection's location / profile / ids;
    - plus `initialStatus = widget.options.status`.
  - Widget metadata:
    - `WIDGET_EYEBROW.alarm_table = 'Alarms'`.
    - Dialog tile: `{ type: 'alarm_table', label: 'Alarm table', blurb: 'Open and recent alarms of these instruments, with acknowledge' }`.
    - When it is chosen, the dialog hides the keys, display and period steps, shows a Status select (`All statuses` + the four), and submits `keys: []`.
  - `WidgetDialog` gains `followLabel?: string`, default `Follow the dashboard selection`.

- [ ] **Step 1: Write the failing tests.**
  - `selection.test.ts`: the five mappings.
  - In a new `widgets/__tests__/use-widget-data-source.test.tsx`:
    - `an empty instrument list makes no overview request`;
    - `a profile source asks the overview by profileId`;
    - `a catalogue over a profile asks data-keys by profileId`.
  - In a new `widgets/__tests__/widget-range.test.tsx`:
    - a relative 7d window gives a 7-day range;
    - a fixed window gives exactly its `from` / `to`;
    - a widget's own `period` wins over the window;
    - `Dashboard window` is the first option only when a window is given.
  - `alarm-table-widget.test.tsx`:
    - an instruments-source widget requests `instrumentIds=<a>,<b>`;
    - a selection with `directOnly` requests `functionalLocationDirect=true`;
    - the server's rows and counts render;
    - `initialStatus` is the starting filter;
    - an empty id list makes no request and prints `No instruments in your view`.
  - In `widgets/__tests__/widget-dialog*.test.tsx` (the existing dialog test file): `the alarm table has no key step and submits keys []`.
- [ ] **Step 2: Run** each file, one per process. Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces.
- [ ] **Step 4: Run:**
  - each new file (PASS);
  - every must-stay-green file, one per process (PASS);
  - `cd apps/web && npx tsc --noEmit -p tsconfig.json` (or the repo's `npm run lint`) (exit 0).
- [ ] **Step 5: Mutation check.** Record each in the ledger.
  - Send `instrumentIds=` for an empty list → the empty-list test fails.
  - Drop `functionalLocationDirect` from the scope query → its case fails.
- [ ] **Step 6: Commit** `feat(web): widgets follow a dashboard source and window; alarm table widget`.

---

### Task 6: Web — the Dashboards sidebar page (list, new, rename, duplicate, delete) and its governance

**Files:**
- Modify (shared):
  - `packages/shared/src/types/sidebar-items.ts`: append `dashboards` LAST.
  - `packages/shared/src/types/permission-tree.ts`: append a group LAST.
  - `packages/shared/src/types/__snapshots__/legacy-maps-snapshot.ts`: append to `SIDEBAR_PRIVILEGE_MAP_SNAPSHOT` only (Ruling D1).
  - `packages/shared/src/types/permission-tree.test.ts`: a group case.
- Modify (web):
  - `apps/web/src/components/layout/sidebar.tsx`: append `allNavItems`;
  - `apps/web/src/main.tsx`: two lazy routes.
- Create:
  - `apps/web/src/routes/dashboards/use-dashboards.ts`;
  - `apps/web/src/routes/dashboards/index.tsx` (list page);
  - `apps/web/src/routes/dashboards/name-dialog.tsx` (New + Rename);
  - `apps/web/src/routes/dashboards/__tests__/list-page.test.tsx`.
- Must stay green: `legacy-maps-derived.test.ts` (FEATURE_PRIVILEGES 39 unchanged), `components/layout/__tests__/sidebar-parity.test.ts`, `sidebar-visibility.test.ts`, `routes/dashboard/__tests__/landing.test.ts`.
- Moves on purpose: `legacy-maps-derived.test.ts:84` pins `SIDEBAR_PRIVILEGE_MAP` `toHaveLength(14)`, which becomes 15.
- Verified, not assumed: the Roles & Access Permissions tab SKIPS a tree group with no feature-privilege nodes (`routes/config/roles-components/permission-tree-grouping.ts`, "skip sidebar groups with no FP nodes"). The node-less `dashboards` group therefore draws no empty section there. Add a case to `permission-tree-grouping`'s test: `a group with no nodes draws no section`.

**Interfaces:**
- Consumes (Task 3): the routes and `DashboardSummary`. Consumes (Task 1): `emptyDashboardDocument`.
- Produces:
  - Sidebar item: `{ id: 'dashboards', label: 'Dashboards' }`.
  - Tree group: `{ sidebarId: 'dashboards', label: 'Dashboards', icon: '🗂️', description: 'Dashboards a super admin builds and assigns', visibilityPrivilegeIds: ['dashboard.view'], nodes: [] }`.
  - Nav item: `{ id: 'dashboards', label: 'Dashboards', href: '/dashboards', icon: <a 2×2 grid svg in the existing style> }`.
  - Routes: `/dashboards` and `/dashboards/:id`, each `<RequireRole permissions={[PERMISSIONS.DASHBOARD_VIEW]}>` + `Suspense`. The `:id` page is Task 7's file; until then it is a stub that renders `null`.
  - `use-dashboards.ts`:
    - `useDashboards(): { rows: DashboardSummary[]; loading; error; mutate }`
    - `useDashboard(id): { dashboard?: DashboardDetail; notFound: boolean; loading; mutate }`
    - and these, each taking the password the re-auth dialog collected (`password?: string`, via the `…WithReauth` client methods when present):
      - `createDashboard(body, password?)`
      - `duplicateDashboard(id, password?)`
      - `deleteDashboard(id, password?)`
      - `saveDashboard(id, body, password?)`
      - `saveAssignments(id, body, password?)`
  - List page:
    - `PageHero` "Dashboards", with **New dashboard** for a SUPER_ADMIN only.
    - `Table` (grid) columns: Title (a link to `/dashboards/:id`), Instruments (`sourceSummary.label`), Widgets, Assigned to (SUPER_ADMIN only — role names, then user full names, or `Not assigned`), Updated.
    - SUPER_ADMIN row actions: Duplicate, Rename, Delete. Delete goes through a `Dialog` confirm naming the dashboard.
    - Empty states: for the SA, `No dashboards yet. Create the first one.`; for anyone else, `No dashboard has been assigned to you.`
    - Every write goes through `reauth.execute('UPDATE_DASHBOARD', …)` with all three outcomes, then `mutate()` and a toast.
    - New → after the 201, navigate to `/dashboards/<id>?edit=1`.

- [ ] **Step 1: Write the failing tests.**
  - `permission-tree.test.ts`: `the dashboards group reuses dashboard.view` (`visibilityPrivilegeIds` toEqual `['dashboard.view']`, nodes `[]`).
  - `list-page.test.tsx`:
    - the server's rows render with every column for an SA;
    - a non-SA sees no New, no Duplicate / Rename / Delete and no Assigned-to column;
    - both empty states;
    - Delete confirms in a dialog and then calls DELETE inside `reauth.execute('UPDATE_DASHBOARD'`;
    - New navigates to `?edit=1` with the returned id.
- [ ] **Step 2: Run** each. Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces and the chosen concept (Task 4).
- [ ] **Step 4: Run:**
  - the shared suite and the build;
  - each listed web file, one per process (PASS);
  - the web lint (exit 0).
- [ ] **Step 5: Commit** `feat(web): Dashboards sidebar page — list, new, rename, duplicate, delete`.

---

### Task 7: Web — the dashboard page: view, edit, save

**Files:**
- Create:
  - `apps/web/src/routes/dashboards/dashboard-page.tsx` (replaces Task 6's stub);
  - `apps/web/src/routes/dashboards/use-dashboard-draft.ts`;
  - `apps/web/src/routes/dashboards/time-window-picker.tsx`;
  - `apps/web/src/routes/dashboards/__tests__/dashboard-page.test.tsx`;
  - `apps/web/src/routes/dashboards/__tests__/use-dashboard-draft.test.ts`.
- Reuse unchanged: `PanelGrid`, `WidgetPanel`, `WidgetDialog`; from `panel-auto-height.ts`, `carryStoredFields`, `keepStoredHeights`, `applyAutoHeights` and `autoHeightIds`.

**Interfaces:**
- Consumes (Task 5): `selectionForSource`, `WidgetSelection`, `followLabel`. Consumes (Task 6): `useDashboard`, `saveDashboard`.
- Produces:
  - `useDashboardDraft(stored: StoredDashboardDocument)`:
    - returns `{ draft, editing, start(), cancel(), addWidget(w), updateWidget(w), removeWidget(id), onGridChange(items), dirty }`;
    - the new item's placement and size are the home `addWidget`'s: bottom, `w: 12`, `h` 5 for value cards and 9 for the rest.
  - `TimeWindowPicker({ value, onChange }: { value: DashboardTimeWindow; onChange(v: DashboardTimeWindow): void })`:
    - offers the `PERIOD_PRESETS` labels plus `Custom range…`, which opens from / to `datetime-local` inputs sent as instants (the `localInputToIso` rule);
    - refuses an end before its start, in place.
  - The page:
    - `PageHero`: title; description; `meta` = `sourceSummary.label` · `<n> in your view` (from `useTelemetryOverview(selection)` rows); actions = the `TimeWindowPicker` (session state, starting at `document.timeWindow`) and Refresh (`mutate` of every key).
    - For a SUPER_ADMIN only: **Edit**, **Settings** and **Assign**. Settings and Assign open Task 8's dialogs; until Task 8 they are absent.
    - The body is `PanelGrid` over `draft.items`, each a `WidgetPanel` with `selection = selectionForSource(draft.source, activeWindow)`.
    - Edit mode: `editActions` = **Add widget** (`WidgetDialog followLabel="Follow the dashboard"`), Edit/Remove per widget, **Save** and **Cancel**.
    - **Save** is `reauth.execute('UPDATE_DASHBOARD', …)` → `saveDashboard(id, { document: draft, expectedUpdatedAt: dashboard.updatedAt })` → `mutate()`.
    - **A 409** shows `DialogBanner tone="danger"`: "This dashboard was changed by someone else." with **Reload**, which `mutate()`s and discards the draft. Until then the draft is kept.
    - `?edit=1` opens in edit mode for a SUPER_ADMIN.
    - **Messages:**
      - `notFound` → `This dashboard is not available to you.` + a link to `/dashboards`;
      - `source === null` → a banner: `This dashboard's instruments could not be read. A super admin can choose them again in Settings.`;
      - no widgets → for the SA, `Add the first widget` (enters edit); for anyone else, `Nothing on this dashboard yet.`

- [ ] **Step 1: Write the failing tests.**
  - `use-dashboard-draft.test.ts`:
    - add / update / remove keep `items` and `widgets` paired;
    - `onGridChange` carries `style` and never stores a measured height;
    - `cancel` restores the stored document.
  - `dashboard-page.test.tsx`:
    - the stored widgets render;
    - a profile source makes the overview ask `profileId=<P>`;
    - a non-SA sees no Edit;
    - SA Edit → Add widget (value cards) → Save sends one PUT carrying `expectedUpdatedAt` and the document with that widget;
    - `a 409 keeps the draft and offers Reload`;
    - `one widget's 403 leaves the rest drawn` (one widget's request rejects with 403 and prints `Could not load this widget.`, another renders its value);
    - changing the window to 7d changes the trend widget's requested range;
    - `?edit=1` opens in edit mode for the SA only;
    - the `notFound` and `source: null` messages.
- [ ] **Step 2: Run** each. Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces and the chosen concept.
- [ ] **Step 4: Run** both files, then every `widgets/__tests__/*` file, one per process (PASS); then the web lint (exit 0).
- [ ] **Step 5: Mutation check.** Drop `expectedUpdatedAt` from the PUT body → the Save case fails. Record it.
- [ ] **Step 6: Commit** `feat(web): dashboard page — view, edit and save a built dashboard`.

---

### Task 8: Web — dashboard Settings and Assign dialogs

**Files:**
- Create:
  - `apps/web/src/routes/dashboards/settings-dialog.tsx`;
  - `apps/web/src/routes/dashboards/assign-dialog.tsx`;
  - `__tests__/settings-dialog.test.tsx`;
  - `__tests__/assign-dialog.test.tsx`.
- Modify:
  - `dashboard-page.tsx` (wire Settings + Assign);
  - `index.tsx` (an Assign row action for the SA).

**Interfaces:**
- Consumes: `dashboardSourceSchema`, `dashboardTimeWindowSchema`, `saveDashboard`, `saveAssignments`, `useHistoryScope` (the widget dialog's instrument picker).
- Produces:
  - `SettingsDialog({ open, dashboard, onClose, onSaved })`. Fields:
    - Title;
    - Description;
    - **Instruments**: radio `All instruments` / `A profile` (a `Select` over `GET /api/instrument-profiles`) / `A location` (Block, then optional Area, from `GET /api/functional-locations`, plus a `Direct only` checkbox) / `Pick instruments` (the `useHistoryScope` tick picker, at most 200);
    - **Default time window**: the `TimeWindowPicker`.

    It validates with the shared schemas and shows zod's message in place. Save is ONE `saveDashboard` PUT of `{ title, description, document: { ...draft-or-stored, source, timeWindow }, expectedUpdatedAt }` through `UPDATE_DASHBOARD`. A 409 is handled as on the page.
  - `AssignDialog({ open, dashboard, onClose, onSaved })`:
    - roles: checkboxes over the active roles, from the endpoint the Users pages already use for role options (verify it; `GET /api/roles/active` is the public one), with SUPER_ADMIN not offered;
    - users: a searchable multi-select over `GET /api/users` at `ALL_RECORDS` (the param the Users list uses);
    - it starts from `dashboard.assignments`;
    - Save is `saveAssignments` through `UPDATE_DASHBOARD`.

- [ ] **Step 1: Write the failing tests.**
  - `settings-dialog.test.tsx`:
    - each of the four sources produces the exact `source` JSON;
    - a custom window with the end before the start is refused and nothing is sent;
    - Save sends `expectedUpdatedAt`.
  - `assign-dialog.test.tsx`:
    - opens with the current roles and users ticked;
    - sends `{ roles, userIds }`;
    - SUPER_ADMIN is not offered.
- [ ] **Step 2: Run** each. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both files and `dashboard-page.test.tsx` and `list-page.test.tsx`, one per process (PASS); web lint (exit 0).
- [ ] **Step 5: Commit** `feat(web): dashboard settings and assignment`.

---

### Task 9: See it, document it, gate it

**Files:**
- Modify:
  - `CHANGELOG.md`;
  - `docs/feature-notes.md` (new note at the top: DASHBOARDS — the rules in Global Constraints, the [my call] list from spec §11, the open questions from spec §12);
  - root `CLAUDE.md` (System Stats: re-auth, sidebar, routes, type files);
  - `apps/api/CLAUDE.md` (a dated entry);
  - `apps/web/CLAUDE.md` (a section);
  - `packages/shared/CLAUDE.md` (type files 37 → 38, re-auth 57, sidebar 15);
  - `docs/recreation/06-api/endpoints.md` (the 7 routes and the retired 6, plus the new query parameters);
  - `tasks/todo.md` (an audit-log entry and the phase 2–4 items).

- [ ] **Step 1: Look at it.**
  - `npx vite build`.
  - Mount the list page and a dashboard page holding all five widget types (real components, SWR mocked to plausible data) in a throwaway vitest dump harness, and write `container.innerHTML`.
  - Load it with the built CSS in a 1240 × 880 box in headless Chrome and screenshot both.
  - Compare with the chosen concept and fix what differs.
  - Check for unaligned elements and for console errors (CLAUDE.md "Never").
  - Delete the harness.
- [ ] **Step 2: Stale-stat sweep.** Grep the active doc set for the old numbers derived on the spot (14 sidebar items, 56 re-auth actions, 54 routes, 37 type files), and update every match that describes today.
- [ ] **Step 3: Gates**, each judged by exit code:
  - the shared suite;
  - the API suite, single fork (`cd apps/api && npm test`);
  - every web file this plan touched or created, one per process;
  - `npm run lint` in all three packages;
  - `npm run check:migrations`.

  Record the counts.
- [ ] **Step 4: Commit** `docs: dashboard builder phase 1`. Update the project memory's ledger: built, not pushed, not deployed, and the AWS read-only check of `dashboards` / `dashboard_assignments` rows owed before the deploy.

## Rulings made in this plan

- **D1 — no new tree node.** The `dashboards` group's `visibilityPrivilegeIds` is `['dashboard.view']`, the existing node gated on `DASHBOARD_VIEW`, with `nodes: []`.
  - The Permissions tab therefore shows ONE "View Dashboards" toggle for both menus.
  - The Sidebar tab still shows or hides each menu per role.
  - This replaces the spec's "a new node `dashboards.view`", which would have been a second toggle moving with the first.
- **D2 — appended last.** The new sidebar item and tree group are appended at the END of `SIDEBAR_ITEMS`, `allNavItems` and the tree (the documented rule for the order-sensitive snapshot). A role with a stored Sidebar list sees "Dashboards" once it is ticked on Roles & Access → Sidebar; a SUPER_ADMIN sees it at once.
- **D3 — present-but-empty `instrumentIds` selects nothing** on both filtered routes; absent means no filter.
- **D4 — an unreadable stored source reads as `null`** and shows no instruments. It never falls back to `all`.
- **D5 — no paging on `GET /api/dashboards`.** A site holds tens of dashboards, and the response is the whole visible list.
- **D6 — the alarm table reuses `SelectionAlarms` through a `scope` prop** rather than a second component built from the same pieces. With no `scope`, its home query is byte-identical.
