# Dashboard builder: many dashboards, a widget library, a dashboard per project

**Date:** 2026-10-29 · **Status:** APPROVED ("yes proceed" to the playback below). Every choice the
operator did not state is marked **[my call]** and is theirs to overturn · **Branch:** `data-layer`

## 1. The ask

Operator, 2026-10-29:

> "i feature new projects,creating as new profile, and instruments in that profiles,different keys
> will come, as per those keys i need to add dashboard widgets,like in thingsboard i need same
> feature like different dashboards creation and different types of widgtes,like charts,graphs,
> trends,time series,alarms and more whatever in thingsboard i need like that"

I played back what I understood, and they answered "yes proceed":

- a list of dashboards: as many as needed, each with its own name, widgets and layout;
- each dashboard chooses its instruments (by profile, by functional location, or a single
  instrument), and its widgets choose from those instruments' keys;
- a **profile dashboard**, designed once, that opens for any instrument of that profile;
- a ThingsBoard-like widget library: value cards, gauges, line and bar charts, time-series tables,
  alarm tables and counts, status lights, floor-plan maps;
- a SUPER_ADMIN builds dashboards (the 2026-10-28 ruling); each dashboard is seen by the roles and
  users it is assigned to, and only for instruments they can already see;
- the pieces that clash with Part 11 or with offline installs are raised before they are built.

**Stated assumption [my call]:** a "project" is a new profile plus its instruments **on the same
server**, with no separation between customers (the install stays single-tenant). If a project is
really a new customer on their own server, every feature here simply runs on that install. Phase 4's
JSON export/import is what makes copying a dashboard between servers cheap.

## 2. What exists today (verified against the tree 2026-10-29, `e46b57d`)

- **The home dashboard `/`** has dashboard widgets built by a SUPER_ADMIN, in four types:
  `value_cards`, `latest_table`, `trend_chart`, `timeseries_table`
  (`packages/shared/src/types/dashboard-widgets.ts:30`). They are stored inside each role's or
  user's layout JSON (`layout.widgets`, items `w:<uuid>`). A role sees them only if it has the
  `custom_widgets` panel.
  - All four renderers take `{ widget, selection }`. `source.mode === 'selection'` means "follow
    the dashboard's Block/Area drill-down". The renderer resolves the ids through
    `/api/instruments/telemetry-overview` (`routes/dashboard/widgets/use-widget-data.ts:40`).
  - Nothing in `widgets/` reads the URL, so they can be reused.
  - `WidgetDialog` and `KeyPicker` know nothing about the home layout. The only home-specific
    things are the wording "Follow the dashboard selection" and the preview.
- **A parked dashboards module** (`apps/api/src/modules/dashboards/routes.ts`, 573 lines;
  models `Dashboard`, `DashboardWidget`, `DashboardAssignment`; enum `AssigneeType {USER, ROLE}`):
  - **Usable:** CRUD, per-widget CRUD and assignment, each write paired with its audit row in one
    transaction. Its eight audit actions are registered and have templates (category
    `Configuration`).
  - **Broken data:** `/:id/data/:widgetId` returns an empty array for every widget type.
  - **Wrong visibility:** `visibleDashboardWhere` (:43-57) lets SUPER_ADMIN **and ADMIN** see
    every dashboard, and lets **a user with no assignment at all see every active dashboard**.
  - **Wrong guards:** the write routes are gated on `DASHBOARD_CREATE` / `MANAGE` / `ASSIGN`.
    Those were stripped from every non-SUPER_ADMIN role locally on 2026-10-24, but **the strip is
    still owed on AWS**, so ADMIN may still hold them there. The write routes also do not refuse
    a soft-deleted dashboard.
  - **Gaps:** no route declares a response schema. The `DASHBOARD_CREATED` row's `afterValue`
    has no `name` key, so the Audit Trail would print a blank target name.
  - **Unused:** no web code calls it, and the tables hold 0 rows locally.
- **`DASHBOARD_VIEW`** is held by every default role. It gates the Dashboard menu item (tree node
  `dashboard.view`, configurable) and the landing rule (`routes/dashboard/landing.ts`).
- **Data routes that already exist** (all apply the viewer's instrument scope):
  - `POST /api/instruments/latest-values`: at most 200 ids and 20 keys.
  - `GET /api/instruments/data-keys`: ids, functional location, `profileId` or `all`.
  - `GET /:id/telemetry`: `keys`, LTTB `points`, per-key `summaries`.
  - `GET /api/instruments/telemetry-history`: `instrumentIds`, `keys`, paged.
  - `GET /api/instruments/telemetry-overview`: only `floorplanId` / `functionalLocationId` on the
    wire. Its builder already takes `instrumentIds` (`telemetry-overview.ts:373`); the route does
    not expose it, and there is no `profileId`.
  - `GET /api/alarms`: ONE `instrumentId` or a functional location, state, acknowledged, type,
    paged, with the four status-quadrant `counts`.
  - `GET /api/alarms/summary`: no filters.
- **Charts are hand-built SVG** (`TimeSeriesChart`, `band-gauge.tsx`). There is no chart library in
  `apps/web/package.json`, and no bar, pie or radial chart anywhere in the app.
- **Instrument scope:** `resolveVisibility` / `withVisibility` (`modules/instruments/visibility.ts`).

## 3. Goals, non-goals, anti-goals

**Goals**

- **G1 — many named dashboards.** A SUPER_ADMIN creates, renames, duplicates, deletes and assigns
  them to roles and users.
- **G2 — a dashboard covers a set of instruments:** a profile (a project), a functional location,
  a fixed list, or all of them. The set is resolved on every read, so a new instrument added to the
  profile appears without anyone touching the dashboard.
- **G3 — a widget library like ThingsBoard's, and ONE library.** A widget type is available on the
  home dashboard and on every built dashboard alike. Phase 1: the four existing types plus an alarm
  table. Phase 2: gauge, bar chart over time, comparison bars, pie, alarm counts, status grid,
  instrument list, text card, floor plan.
- **G4 — a dashboard time window** that every HISTORY widget follows unless it sets its own: trend
  chart, time-series table, and phase 2's bar chart. Widgets that show the PRESENT do not take a
  window: value cards, latest table, the alarm table (open and recent alarms by status, exactly as
  the "Alarms in this selection" panel), and phase 2's gauge, comparison bars, counts, status grid
  and instrument list. An alarm raised before the window must not vanish from a monitoring screen
  while it is still active. **[my call]**
- **G5 — instrument dashboards (phase 3):** designed once for a profile and opened for any of its
  instruments, with drill-down to them from fleet widgets.
- **G6 — nothing escapes governance:** every read stays inside the viewer's instrument scope, and
  every change is audited.

**Non-goals**

- Customer separation / multi-tenancy, and public (unauthenticated) dashboards.
- **Control widgets** that write to a device (ThingsBoard RPC / "update attribute"). An attribute
  write here is a governed §11 change with per-role editability and remarks. It needs its own
  design if wanted.
- **Custom HTML / JavaScript widgets.** They would be arbitrary code in a validated system.
- **Internet map tiles.** Installs run with no internet. The floor-plan widget is the map.
- Browser push. "Live" stays polling, as on every screen.
- PDF/CSV downloads of dashboards or widgets. That is widget-data-keys phase 4, separately
  approved.
- Judging measurement types other than temperature/humidity (profile-measurements phase 2).
  Until then, every pressure/CO₂ key is a raw key: shown, never judged.
- Any change to what the home dashboard `/` shows today. It only gains the new widget types in
  its Add-widget dialog.

**Anti-goals — a failure even if everything else works**

- A dashboard showing an instrument outside the viewer's scope.
- A dashboard opened by URL by someone it is not assigned to.
- A non-SUPER_ADMIN changing a dashboard on AWS because a stale `DASHBOARD_MANAGE` grant still lets
  them through.
- A raw key drawn green, or "In limit". Any verdict computed in the browser.
- One unreadable widget blanking a whole dashboard.
- An audit row with a blank target name.
- Any stored home-dashboard layout (including `{ mode: 'selection' }` widgets) parsing differently
  after this ships.

## 4. Concepts

- **Dashboard** = `{ id, title, description, document }`, where
  `document = { version: 1, source, timeWindow, items, widgets }`.
- **Dashboard source** (what instruments the dashboard covers):
  - `{ mode: 'profile', profileId }`
  - `{ mode: 'location', functionalLocationId, directOnly }`
  - `{ mode: 'instruments', ids }` (at most 200)
  - `{ mode: 'all' }`

  It is resolved on the server on every read, after the viewer's scope. A profile or location that
  no longer exists resolves to no instruments, and the page says so.
- **Widget source** is unchanged: `{ mode: 'selection' }` or `{ mode: 'instruments', ids }`.
  `selection` means **"follow the dashboard"**: on `/` that is the drill-down, on a built dashboard
  it is the dashboard's source. The stored token stays `selection`, so no home layout changes
  meaning. **[my call]**
- **Time window**: `{ mode: 'relative', period }` (a `PERIOD_PRESETS` value) or
  `{ mode: 'fixed', from, to }`. The default is `{ mode: 'relative', period: '24h' }`.
  - A history widget whose `options.period` is absent follows the dashboard, including a fixed
    window. One that sets `options.period` keeps its own.
  - The in-widget period picker stays, and changes the view for the session only, as zoom does
    today. On a built dashboard its first entry is "Dashboard window" (the default).
  - The header picker offers the `PERIOD_PRESETS` plus a custom from–to.
- **Raw vs measured keys:** exactly as in `2026-10-28-widget-data-keys-design.md` §4. A raw key is
  shown and never judged.

## 5. Storage [my call]

- **The document lives in the existing `dashboards.layout` JSONB.** Phase 1 has **no migration**.
- **One strict parser, `parseDashboardDocument`,** in a new shared file
  `packages/shared/src/types/dashboard-document.ts`. It is used on every write; a failure is a
  400 with a message naming the widget.
  - Items must be `w:` items. Panel keys are refused, because a built dashboard places widgets
    only.
  - Every widget passes `customWidgetSchema`, at most `WIDGETS_PER_LAYOUT_MAX` (20), and is
    placed exactly once.
  - The source and time window must be valid.
- **One forgiving reader, `readDashboardDocument`,** for display. It drops a bad widget and its
  item, keeps everything else, and falls back to a default source and window.
- **Built dashboards do NOT go through `normalizeLayout` / `resolveLayout`.** Those
  admit panel keys and gate `w:` items on the `custom_widgets` panel. (The document does reuse
  `readItem` for each item's geometry and style.) On a built dashboard,
  **assignment is the gate**. The home path is untouched.
- **The per-widget routes retire** (POST/PUT/DELETE `/:id/widgets…`, PUT `/:id/layout`,
  GET `/:id/data/:widgetId`, GET `/widget-types`). A save sends the whole document.
- **The `dashboard_widgets` table is left in place, unused.** Dropping it is a destructive change
  and AWS's row count is unchecked, so it is a question for the operator (§12). Models stay at
  **38**.

## 6. Server — phase 1

### 6.1 `/api/dashboards`, rewritten

| Route | Who | Does |
|---|---|---|
| `GET /` | `DASHBOARD_VIEW` | The dashboards visible to the caller: `id, title, description, sourceSummary {mode, label}, widgetCount, updatedAt`, plus `assignments` for a SUPER_ADMIN only |
| `GET /:id` | `DASHBOARD_VIEW` + visible | `title, description, document` (forgiving read); 404 when not visible |
| `POST /` | SUPER_ADMIN | Create `{ title, description?, document? }`. The default document is an empty set of widgets, `{ mode: 'all' }`, 24h |
| `POST /:id/duplicate` | SUPER_ADMIN | A copy titled "… (copy)", with new widget ids and **no assignments** |
| `PUT /:id` | SUPER_ADMIN | `{ title?, description?, document?, expectedUpdatedAt }`; strict parse. `expectedUpdatedAt` is the `updatedAt` the editor loaded, and a mismatch is a 409 `DASHBOARD_CHANGED` that writes nothing, so two editors cannot silently overwrite each other **[my call]** |
| `DELETE /:id` | SUPER_ADMIN | Soft delete (`isActive: false`) |
| `PUT /:id/assignments` | SUPER_ADMIN | Replace the whole set `{ roles: string[], userIds: string[] }`; a role or user that does not exist is a 400 |

- **Visibility rule (replaces `visibleDashboardWhere`):** only active dashboards are shown.
  SUPER_ADMIN sees all of them. Everyone else sees only the dashboards assigned to them or to their
  role. **No assignment means none**, and ADMIN is not special.
- **Writes check `req.user.role === 'SUPER_ADMIN'`**, whatever `DASHBOARD_*` grants the caller
  holds. They answer 404 for a soft-deleted or missing dashboard.
- **Re-auth:** a new action `UPDATE_DASHBOARD` (category `Configuration`), off by default like
  every action. It covers create, duplicate, update, delete and assignments. Reauth 56 → 57.
  No remarks are required: this is display configuration, not a decision on a record.
  **[my call]**
- **Audit:** every write and its audit rows go in ONE transaction, reusing the eight registered
  actions.
  - `DASHBOARD_CREATED` / `UPDATED` / `DELETED` carry `name` (the title) in `beforeValue` and
    `afterValue`.
  - A document save also writes `DASHBOARD_WIDGET_CREATED` / `UPDATED` / `DELETED`, one row per
    widget added, changed or removed (diffed by widget id), with `name` = the widget's title and
    the dashboard named in the details. A save that only moves items writes `DASHBOARD_UPDATED`
    alone.
  - `DASHBOARD_ASSIGNED` / `UNASSIGNED` are written per role or user added or removed, naming
    them.
- **Every route declares its response schema**, inner keys included.
- **Swagger:** the existing `Dashboards` tag.

### 6.2 Two existing routes gain filters

- **`GET /api/instruments/telemetry-overview`** gains `profileId` and `instrumentIds` (a comma
  list, at most 200). Both are declared in its schema, applied after visibility, and combinable
  with the existing filters (AND). With no filter it returns every visible instrument, as today.
- **`GET /api/alarms`** gains three filters, combinable with the existing ones (AND):
  - `instrumentIds` (a comma list, at most 200);
  - `profileId`;
  - `functionalLocationDirect=true` (the flag `telemetry-overview` and `data-keys` already take).
    Today a Block always expands to its Areas here, so an alarm widget on a "direct only" dashboard
    would show alarms the value cards beside it do not.

  The existing `counts` follow the same filters. The home panel "Alarms in this selection" is NOT
  changed; it keeps sending what it sends today.

A dashboard grants nothing. All of its data comes from these routes, under the viewer's own
permissions and scope.

## 7. Widget library

### Phase 1

- The four existing types, unchanged, now also on built dashboards.
- **`alarm_table` (new):** the alarms of the widget's instruments. It uses the same presentation
  pieces as the dashboard's "Alarms in this selection" panel (`routes/alarms/alarm-table.tsx`):
  - status filter (the four quadrants with their counts), type filter, paging;
  - acknowledge under the viewer's existing alarm permissions, through the existing flow;
  - options `{ pageSize?, status? }`; no keys (the schema accepts an empty key list for this type
    only);
  - it takes no time window (G4).

  On `/` it follows the drill-down, as `SelectionAlarms` does. **On `/` it is drawn only when the
  viewer ALSO has the `dashboard_alarms` panel.** A built widget never widens what Roles & Access →
  Panels grants a role. **[my call]** On a built dashboard, assignment is the gate.

### Phase 2 (its own plan; each one a `WIDGET_TYPES` entry available in both places)

- **`gauge`** — one radial gauge per instrument × key. A measured key draws its band from the
  server's limits and its colour from `quantityVerdict`. A raw key draws a neutral arc between a
  min and max set on the widget, and is never green.
- **`bar_chart`** — readings aggregated per bucket (hour / day / week; avg, min, max or count),
  per instrument or across them. It needs a new
  `GET /api/instruments/telemetry-buckets` (SQL `date_bin`, scope applied, at most 20 keys,
  50 instruments and 1,000 buckets).
- **`comparison_bar`** — each instrument's latest value side by side (`latest-values`).
- **`pie_chart`** — distributions the server already decides: instrument status
  (OK / out of limit / stale / no data) or alarm types. It never draws a pie of raw readings.
- **`alarm_counts`** — count cards (active, unacknowledged, per type). It needs a new
  `GET /api/alarms/counts` (groupBy type × state, the same filters and scope).
- **`status_grid`** — a tile per instrument with the server's status word and colour.
- **`instrument_list`** — ID, Area, Location, status, last seen. A row click opens the trend page
  (in phase 3, the instrument dashboard).
- **`text_card`** — a heading and plain text, for labels and instructions. No HTML.
- **`floorplan`** — the existing floor-plan drawing for one chosen layout (`FloorplanView` gains a
  `planId` prop).
- **Chart rendering — OPERATOR DECISION 2026-10-30: "start phase 2 with echarts".** The four new
  chart shapes (gauge, bars over time, comparison bars, pie) draw with **ECharts**:
  - pinned to an exact version (`6.1.0`, released 2026-05-19), tree-shaken through `echarts/core`,
    bundled (works offline, and the chunk must land in the service worker's precache);
  - lazy-loaded, so the main bundle every login downloads does not carry it;
  - fed the app's own series and status colours explicitly, never ECharts' default palette,
    because a raw key drawn in a default green would read as a verdict;
  - animation off: the widgets poll, and a redraw must not replay an animation.
  - `TimeSeriesChart` and the band gauge stay as they are.
- **Phase 2 rulings (settled in its plan, `docs/superpowers/plans/2026-10-30-dashboard-builder-phase2.md`):**
  - **Instruments the status rule cannot judge.** The server's instrument status reads only the
    temperature and humidity slots, so a reporting pressure-only instrument is `NO_DATA` today.
    The overview row gains a server-decided `judged` flag (does this instrument's profile measure
    temperature or humidity?) and `lastSeenAt`. The status grid, instrument list and status pie
    show an unjudged instrument as **"Not judged"** (neutral) while it reports and **"Offline"**
    when it does not, never "No data". The existing table and floor plan are unchanged.
  - **Bucket edges follow the site timezone** (the `datetime` config's `timezone`, default
    `Asia/Kolkata`), so a "day" bar is a local day and hourly edges fall on the local hour; weeks
    start on Monday.
  - **A bar is labelled as computed** ("Hourly average", "Daily maximum", "Weekly reading count").
    Every bar value is derived, never a stored reading.
  - **Gates on `/`:** the alarm counts widget and an alarm-type pie need the `dashboard_alarms`
    panel, as the alarm table does; the floor-plan widget needs `telemetry_floorplan`. On a built
    dashboard, assignment stays the only gate.
  - **Bars and gauges take series colours, not verdicts**, except the gauge of a MEASURED key, which
    takes the server's limits and the `quantityVerdict` colour exactly as the band gauge does.

### Phase 3 — instrument dashboards

- A dashboard of kind `INSTRUMENT` is bound to a profile. This needs a migration: `kind` text
  default `'FLEET'`, `profile_id` uuid NULL with a foreign key.
- The page has an instrument picker (that profile's instruments the viewer can see), and its
  `selection` widgets follow the chosen instrument (`?instrument=`).
- **Drill-down:** clicking an instrument on a fleet widget opens the `INSTRUMENT` dashboard of its
  profile when one is assigned to the viewer, otherwise the trend page.
- **The trend page stays the governed per-instrument record view** (its PDFs, report kinds,
  administered wording and per-profile keys). An instrument dashboard is a free monitoring layout
  and never replaces it or its reports. **[my call]**
- "Start from this profile": a starter dashboard with value cards for the profile's measured keys,
  a trend chart, a time-series table and an alarm table.

### Phase 4 — separate approval

- Export/import a dashboard as JSON (to copy it to another server).
- Widget downloads through a new `REPORT_KINDS` entry (Report Settings, approvers, download
  audit).

## 8. Screens — phase 1

- **Placement [my call]: a new sidebar item, "Dashboards" (`/dashboards`), beside "Dashboard".**
  `/` is NOT touched. That is ThingsBoard's own arrangement, and it is the only placement that
  keeps the non-goal above.
  - A switcher in `/`'s header was considered and dropped (builder check). The Overview's top
    level has no header since the operator's 2026-08-29 ruling (`dashboard/index.tsx:251-258`),
    and every login lands there. A switcher would either bring that bar back or be found only
    after a drill-down.
  - **Governance:**
    - a new permission-tree group `dashboards` whose visibility is the EXISTING node
      `dashboard.view` (gated on `DASHBOARD_VIEW`), with no node of its own. There is no new
      permission and no second toggle: the Permissions tab keeps ONE "View Dashboards" toggle,
      covering both menus (plan ruling D1);
    - the Roles & Access Sidebar tab shows or hides "Dashboards" per role independently of
      "Dashboard", so a project role can get its dashboards without the plant Overview.
- **`/dashboards`** (the dashboard list):
  - a table with Title, Instruments (the source summary), Widgets, Assigned to, Updated;
  - for a SUPER_ADMIN, New, Duplicate, Rename, Delete and Assign;
  - for everyone else, only their assigned dashboards, read-only.
- **`/dashboards/:id`**:
  - header: title, the source summary ("Pressure Sensors · 24 instruments"), the time-window
    picker and refresh;
  - for a SUPER_ADMIN, **Edit**, which reuses `PanelGrid` (drag/resize), "Add widget" (reusing
    `WidgetDialog`, with the wording "Follow the dashboard"), Edit/Remove per widget, and
    Save/Cancel;
  - also for a SUPER_ADMIN, **Settings** (title, description, source, default time window) and
    **Assign** (roles + users).
- **Look:** the UI v3 primitives and the dashboard's `PanelCard`. **2–3 concept images of the
  list and the dashboard page come before the web tasks** (operator rule: a new visual starts as
  concept images, and must be premium on the first cut).

## 9. Tests (phase 1)

- **API e2e** (each file owns its super admin, roles, profile and instruments):
  - visibility: SA sees all; assigned by user and by role; an unassigned OPERATOR gets 404 and an
    unlisted dashboard; ADMIN without an assignment sees none;
  - an ADMIN **granted** `DASHBOARD_MANAGE` still gets 403 on every write;
  - a write to a soft-deleted dashboard is 404; strict-parse 400s;
  - audit rows carry `name`; the per-widget diff rows; the assignment diff rows;
  - `telemetry-overview` and `alarms` with `profileId` / `instrumentIds` for an Area-scoped
    OPERATOR (negative plus positive control);
  - each new response field is mutation-checked by deleting its schema line.
- **`dashboards-module.e2e.test.ts` and `__tests__/mass-assignment.test.ts` pin the OLD rules**
  ("no assignment sees all", ADMIN sees all, per-widget routes). They are rewritten to the new
  rules on purpose; that is not a regression.
- **Shared unit:** the strict and forgiving document readers. The existing home-layout tests pass
  **unchanged**.
- **Web** (one file per process, judged by exit code):
  - the Dashboards list shows only what the server returned;
  - the sidebar item follows `dashboards.view` and the role's Sidebar list;
  - Edit / Settings / Assign appear only for a SUPER_ADMIN;
  - `alarm_table` renders the server's rows and counts;
  - a malformed widget keeps the rest of the dashboard.
- **Visual check:** each new screen rendered with the built stylesheet at 1240 × 880 and looked at
  before it is called done.

## 10. Touch points (phase 1)

| Area | Files |
|---|---|
| Shared | new `types/dashboard-document.ts` (+ test); `types/dashboard-widgets.ts` (`alarm_table`, its options, the empty-keys rule); `types/reauth-actions.ts` (`UPDATE_DASHBOARD`); `types/sidebar-items.ts` (`dashboards`); `types/permission-tree.ts` (a group reusing `dashboard.view`, no node) with `permission-tree.test.ts` and `__snapshots__/legacy-maps-snapshot.ts` (`SIDEBAR_PRIVILEGE_MAP_SNAPSHOT`, appended); `index.ts` |
| API | `modules/dashboards/routes.ts` (rewrite) + a service/repository beside it; `modules/dashboards/__tests__/mass-assignment.test.ts`; `e2e/dashboards-module.e2e.test.ts`; `modules/instruments/routes.ts` + `telemetry-overview.ts` (overview filters); `modules/alarms/routes.ts` + `list-query.ts` (`instrumentIds`, `profileId`, `functionalLocationDirect`); `modules/config/config.service.ts` (sidebar auto-grant, checked) |
| Web | `main.tsx` (+2 routes); `components/layout/sidebar.tsx` (`allNavItems` + icon; `sidebar-parity` / `sidebar-visibility` tests run); new `routes/dashboards/` (list page, dashboard page, settings dialog, assign dialog); `routes/dashboard/index.tsx` (ONLY the `alarm_table` + `dashboard_alarms` gate on a `w:` item); `widgets/use-widget-data.ts` (`selection` → a dashboard source); `widgets/widget-common.tsx` (the dashboard window in `useWidgetRange`); `widgets/widget-dialog.tsx` (wording, alarm type); `widgets/widget-panel.tsx`; new `widgets/alarm-table-widget.tsx` (built from the `alarm-table.tsx` pieces and the acknowledge flow, the filter set passed in) |
| Docs | `CHANGELOG.md`; `docs/feature-notes.md` (new note); root, `apps/api` and `apps/web` `CLAUDE.md`; `packages/shared/CLAUDE.md` (type files 37 → 38); `docs/recreation/06-api/endpoints.md`; `tasks/todo.md` |

**Counts that move in phase 1:**

- re-auth actions 56 → 57;
- `<Route`s 54 → 56;
- shared type files 37 → 38;
- sidebar items 14 → 15;
- permission-tree groups 14 → 15 (nodes stay 56, feature privileges stay 39).

No model, enum, permission, audit action, config def or config page moves, and there is no
migration.

**Before the deploy:** check AWS's `dashboards` and `dashboard_assignments` row counts, read-only.
Under the new rule, an unassigned dashboard there would become SUPER_ADMIN-only. No screen ever
existed, so any rows are expected to be zero.

## 11. Calls I made that the operator did not

1. Projects share one server; there is no customer separation.
2. Dashboards get their own "Dashboards" sidebar item, gated on the existing `DASHBOARD_VIEW`;
   `/` is not touched.
3. Seeing a dashboard = `DASHBOARD_VIEW` + an assignment. Only a SUPER_ADMIN sees unassigned
   dashboards; ADMIN gets no exception.
4. Building = SUPER_ADMIN, checked by role, never through `DASHBOARD_*` grants.
5. The dashboard document is stored in `dashboards.layout`; `dashboard_widgets` is left unused, not
   dropped.
6. One widget contract and one library for the home dashboard and built dashboards.
7. The alarm table comes in phase 1; the rest of the library in phase 2.
8. ~~ECharts is recommended for phase 2's new chart shapes~~ — the operator chose ECharts on
   2026-10-30 ("start phase 2 with echarts"); no longer my call.
9. Re-auth action `UPDATE_DASHBOARD`, off by default; no remarks.
10. Instrument dashboards (phase 3) never replace the trend page or its reports.
11. Excluded: control widgets, custom HTML/JS, public dashboards, internet maps.
12. Duplicating a dashboard does not copy its assignments.
13. History widgets follow the dashboard window; present-state widgets, the alarm table included,
    take none.
14. On `/`, an alarm widget also needs the `dashboard_alarms` panel.
15. A save carries `expectedUpdatedAt`; a stale save is a 409.
16. A widget's own fixed instrument list need not sit inside the dashboard's source. It is still
    limited to the viewer's scope.

## 12. Open questions for the operator (none blocks phase 1)

1. Should the unused, empty `dashboard_widgets` table be dropped? AWS's row count was checked
   read-only on 2026-10-30: 0 rows, so nothing would be lost. Still the operator's call.
2. ~~ECharts for the phase 2 charts, or hand-built SVG?~~ **Answered 2026-10-30: ECharts.**
