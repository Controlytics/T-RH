# Widget data keys — any key an instrument sends, in any widget

**Date:** 2026-10-28 · **Status:** PROPOSED — awaiting the operator's approval · **Branch:** `data-layer`

## 1. Why

Operator, 2026-10-28:

> "in application dashboards widgets, if different keys data was coming to instrument where i can
> add those in widgets to see that data, like in time series widgets, latest value card widgets, in
> all widgets, in future new key was came to instrument, how can i see that new key data in
> dashboard, when user add that key in dashboard it should display, like in thingsboard, whenever
> new key came how we will add that key in dashboard like time series or attribute types keys i
> need same like this in this application"

Then, asked one question, they answered "give complete plan, how u do" — so every choice below that
they did not state is marked **[my call]** and is theirs to overturn.

### What exists today (verified against the tree 2026-10-28, `2ebb7d3`)

- **Nothing a device sends is lost.** Ingest stores every key as its own reading:
  `instrument_telemetry_history` (partitioned, one row per instrument/key/instant) and
  `instrument_telemetry_latest` (`@@id([instrumentId, key])`, with `value_type` and `ts`). A key
  nobody has configured is stored exactly like `t` and `h`.
- **Every widget is wired to the profile's temperature and humidity and nothing else:** the
  dashboard readings table, the floor-plan tiles, the trend page's band gauges, its two charts, its
  Time Series (raw readings) table, and the Data Report.
- **`GET /api/instruments/:id/telemetry-keys`** lists the keys one instrument has actually sent. The
  trend page still fetches it (`apps/web/src/routes/instruments/trend.tsx:331`) and renders nothing
  with it — a dead request.
- **A per-user "extra keys" picker existed on the trend page from 2026-08-24 to 2026-09-01**
  (`a87b7ff`, keys kept in `localStorage`, charts with no limit band). It went in `c3b9544`, the
  rebuild of that page to the operator's reference images. No instruction to remove it is recorded
  in the CHANGELOG or the feature notes, and `docs/feature-notes.md` (the "Instrument trend page"
  note) still says it exists. **This design brings the capability back, stored on the server and
  governed; it is not reversing an operator decision.** If it was removed on purpose, say so and
  Phase 3 changes.
- **A parked widget-dashboard module** (`/api/dashboards`; models `Dashboard`, `DashboardWidget`,
  `DashboardAssignment`) has CRUD and assignment, but its data fetcher returns an empty array for
  every widget type and no page uses it. Its Dashboards create / manage / assign toggles were taken
  off the Permissions tab on 2026-10-24 as dead, and `strip-unused-permissions.ts` removes
  `DASHBOARD_CREATE` / `MANAGE` / `ASSIGN` from ADMIN (applied locally; **still owed on AWS**).
- **Arranging the dashboard is SUPER_ADMIN-only on screen** (`routes/dashboard/index.tsx:345-346`,
  "Arrange is SUPER_ADMIN only (operator, 2026-08-29)"), although the server's
  `PUT /api/config/my-dashboard-layout` ("a personal preference, not audited, grants nothing")
  accepts any signed-in user. A role's default arrangement has an audited route
  (`PUT /api/roles/dashboard-layout/role/:name`) and, since 2026-10-12, no screen that calls it.
- **What a role sees on the dashboard is governed by panel assignment** (Roles & Access → Panels,
  `packages/shared/src/types/panels.ts`); `readItem` and `resolveLayout` in `dashboard-layout.ts`
  drop any grid item that is not an assigned panel key.
- **`value_type` does not say whether a reading is a number.** `classifyValue`
  (`payload-parser.ts:55`) stores `int` / `float` / `string` / `boolean` / `json`, and the plant's
  gateway firmware QUOTES every reading, so `t` and `h` from a gateway are stored as `'string'`.
  "A quoted number is a reading" (`coerceReading`, SQL `NUMERIC_READING`) is the rule that decides.
- **There is no per-key status on the server.** `buildTelemetryOverview()`'s `status` is the
  instrument's combined verdict over both quantities; the band gauge decides each quantity's own
  verdict from the server's limits and fault flags (`set-point.ts` `outOfSpec`, plus inherited
  STALE only), because inheriting the combined verdict once printed "Out of limit" over an in-range
  temperature (CWH/RDU/001-00, `band-gauge.tsx:248-285`).
- **Profile measurements (phase 1, deployed `436fed8`)** made the instrument PROFILE own every key
  mapping (which key is temperature, its limits, range, offset, decimals, MKT). Phases 2 (any number
  of measurement types, e.g. pressure) and 3 (screens for them) are not started.

## 2. What success looks like

A device starts sending a key `p` tomorrow.

- **No one configures anything for it to be pickable.** The first stored reading puts `p` into the
  key picker of every widget that covers that instrument, shown as *Time series · number · last
  seen 12:04*.
- **A super admin** opens the dashboard, presses Arrange → Add
  widget, picks *Value cards*, the instruments
  (or "follow the dashboard's Block/Area selection"), ticks `p`, types a label and a unit, and the
  card shows the latest value, refreshed as the dashboard refreshes. A *Trend chart* widget plots
  its history.
- **A super admin** opens that instrument's trend page, presses the Keys pencil, ticks `p` for the
  instrument's profile, and every instrument of that profile shows `p` as a value card, a chart and
  a Time Series column.
- **Attribute keys** (`Location`, a firmware version, a setting the device reports over
  `attributes/report`) are pickable the same way, for the value widgets.

## 3. Goals, non-goals, anti-goals

**Goals**

- **G1 — one key picker, both kinds of key.** *Time series* keys are the keys the chosen
  instruments have sent; *attribute* keys are the keys they carry. A new key appears by itself.
  The same picker serves every widget, including the measurement screens of profile-measurements
  phase 3, so a second one is never built.
- **G2 — the dashboard takes user-built widgets.** Four types: *Value cards*, *Latest values table*,
  *Trend chart*, *Time series table* — over chosen instruments or the dashboard's current selection.
- **G3 — the trend page takes extra keys per profile**, as value cards, chart cards and Time Series
  columns, beside temperature and humidity.
- **G4 — any value type.** Numbers plot; text and true/false values show in cards and tables.

**Non-goals (this design)**

- **Judging a raw key.** No limits, status, alarm, offset or MKT for a key that is not one of the
  profile's measurements. That is profile-measurements phase 2 (a pressure measurement type, its
  limits and alarms). A raw key is shown, never judged.
- Extra keys on the dashboard's fixed readings table and on floor-plan tiles (profile-measurements
  phase 3).
- PDFs or downloads of the new widgets, until Phase 4 (separately approved).
- Several named dashboards per user, or reviving `/api/dashboards` (§9).
- Browser push. "Live" stays polling, as on every other screen.

**Anti-goals — a failure even if everything else works**

- A raw key shown green, or "In limit". Nothing is checking it.
- The browser inventing a unit, a precision or a status for a measured key, or rounding a raw key
  it was not told to round.
- A widget that shows an instrument outside the viewer's scope — including through a widget a super
  admin saved into a role's default.
- One unreadable widget resetting or blanking somebody's whole dashboard.

## 4. The concepts

- **Key reference** — `{ source: 'telemetry' | 'attribute', key }`. `key` is exactly as stored.
- **Measured vs raw.** A telemetry key is *measured* on an instrument when that instrument's profile
  maps it to a measurement (the existing resolver, `modules/instruments/profile-measurements.ts`).
  A measured key gets everything temperature and humidity get today, **from the server**: its unit,
  its decimals, its bounds, its status, its range/sensor-error words. A raw key gets the value as
  stored and nothing else: unit `null`, decimals `null`, status `null` ("not judged").
- **The decimals rule** (written down because the browser must not invent it): measured key → the
  instrument's resolved decimals, as now. Raw numeric key → `decimals: null`, which means *print the
  stored number as the device sent it*. A widget may set its own decimals for a raw key (an explicit,
  stored display choice). `TELEMETRY_DECIMALS_FALLBACK` (1) is never applied to a raw key silently —
  the 2026-08-24 extra-key charts did that, and it rounds a 0.05 kPa reading to 0.1.
- **Per-key display settings on a widget**: label, unit text, decimals (0–6), colour (from the chart
  palette). For a measured key only label and colour can be changed; the unit and decimals are the
  server's. **[my call]**
- **Text and boolean values.** Any key can feed a card or a table. A chart plots the readings that
  are numbers under the existing rule (`coerceReading` / `NUMERIC_READING` — a quoted number IS a
  number) and says how many it could not plot. The catalogue's *numeric* flag is a HINT shown in the
  picker, never a gate: a probe currently sending `NA` must not vanish from the chart picker.
  **[my call]**
- **A measured key's verdict is the band gauge's rule, in one place.** The server supplies the
  limits, `sensorError`, `rangeError` and `reporting`; the per-quantity verdict (breach → fault word
  → STALE inherited → in limit; never the instrument's combined status) is the existing
  `outOfSpec` + band-gauge precedence, lifted into ONE exported function in
  `routes/dashboard/set-point.ts` that the band gauge and every new widget call. A second,
  server-side per-key verdict would be a new resolver able to disagree with the gauge beside it.
  **[my call]**

## 5. Phase 1 — the server: key catalogue and values

### 5.1 `GET /api/instruments/data-keys` — what can be picked

- Query: exactly one of `instrumentIds` (comma list, at most 200), `functionalLocationId` (a Block
  expands to its Areas via the existing `resolveLocationIds`), `profileId`.
- **Visibility first.** The id set is narrowed with `withVisibility` before anything is read; an
  instrument outside the caller's scope is absent, never a 403. `INSTRUMENT_READ`, like its siblings.
- **Telemetry keys come from `instrument_telemetry_latest`**, one row per instrument/key:
  `SELECT key, array_agg(DISTINCT value_type), count(*), max(ts) … GROUP BY key`. Not
  `getDistinctKeys`, which runs a `GROUP BY` over the whole partitioned history.
- **Attribute keys come from `instrument_attributes`**, grouped case-insensitively (the
  `attribute-labels` rule), labelled through the administered display-name map.
- Each entry: `source`, `key`, `label`, `numeric` (true when the latest reading of at least one
  instrument in the set is a number under `NUMERIC_READING`; attributes are always false — a hint,
  §4), `instruments` (how many in the set carry it), `lastSeen`, and `measurement`
  (`{ typeId, name, unit }` when ANY instrument in the set measures it, else `null`). The picker
  labels a measured key by its measurement name ("Temperature — `t`").
- `GET /:id/telemetry-keys` moves to the same latest-table query and gains `numeric` and
  `measurement`; its existing fields are unchanged.
- Sensor-offset attribute keys stay hidden from non-super-admins, as the attributes route already
  hides them (`load-offsets.ts`).
- **Every field is declared in the response schema** — Fastify drops undeclared fields without an
  error, which has cost this repo nine times.

### 5.2 `POST /api/instruments/latest-values` — the values widgets show

- Body `{ instrumentIds: uuid[] (≤ 200), keys: KeyRef[] (≤ 20) }`. POST because the id list is
  long; it is read-only and writes no audit row.
- Per visible instrument: `id`, `code`, `name`, `functionalLocationName`, `locationAttribute`,
  `reporting`, `lastSeenAt`, and per requested key `{ source, key, value, ts, unit, decimals,
  judged }`. `judged` is `{ limitMin, limitMax, sensorError, rangeError }` for a measured key —
  the bounds and fault flags `buildTelemetryOverview()` already resolves for that quantity (the ONE
  definition; the function gains a per-measurement read-out, not a second resolver) — and `null`
  for a raw key or an attribute. The verdict is drawn from these by the §4 rule. The new route is
  added to the "every server resolver agrees about a bound" e2e in
  `instrument-telemetry-range.test.ts`.
- A key the instrument has never sent: `value: null, ts: null` (the widget prints NA).

### 5.3 History

- `GET /:id/telemetry` gains `keys` (comma list, ≤ 20) beside the existing single `key`. On the
  chart path (`points`) every requested key gets its LTTB sample and its `summaries[key]`; a raw
  key's summary has `belowCount` / `aboveCount` / `outOfSpecCount` = `null` (the existing
  "no limit resolved" meaning).
- The chart path adds `nonNumericCount[key]`, so a chart can say "12 text readings not plotted"
  instead of dropping them silently.
- `GET /api/instruments/telemetry-history` gains a `keys` filter; the pivot stays in SQL.

### 5.4 Tests (API, e2e, each file owning its own super admin, profile and instruments)

1. A key never seen before, ingested over HTTPS, appears in `data-keys` with no config write.
2. An OPERATOR scoped to one Area does not see the other Area's instrument in `data-keys` or
   `latest-values` (paired with a positive control).
3. A text key reports `numeric: false` and its value passes through untouched; a QUOTED number
   (`"21.5"`, as the gateways send) reports `numeric: true`.
4. An attribute key is listed under its administered display name.
5. A measured key returns the server's decimals and status; a raw key returns `judged: null` and
   `decimals: null`.
6. `keys` on `/:id/telemetry` returns only those keys, with summaries and `nonNumericCount`.
7. Each new response field is mutation-checked by deleting its schema line.

## 6. Phase 2 — dashboard widgets

### 6.1 Where a widget is stored — inside the existing layout, no migration **[my call]**

- `DashboardLayout` (`packages/shared/src/types/dashboard-layout.ts`) gains an optional
  `widgets: CustomWidget[]`; a grid item names one as `i: "w:<uuid>"`.
- `CustomWidget` = `{ id, type: 'value_cards' | 'latest_table' | 'trend_chart' | 'timeseries_table',
  title, source: { mode: 'selection' } | { mode: 'instruments', ids }, keys: (KeyRef & display
  settings)[], options: { period?, pageSize? } }`, validated by one zod schema in `@digilog/shared`.
  Caps: 20 widgets per layout, 50 fixed instruments, 20 keys, 10 series on a trend chart.
- **Governed like a panel.** One new `PANELS` entry, `custom_widgets` ("Built widgets", page
  `dashboard`), appended so the frozen key order holds. Roles & Access → Panels then decides whether
  a role sees built widgets at all: `readItem` / `resolveLayout` keep `w:` items only when
  `custom_widgets` is among the viewer's panels. A role with a stored panel list does not see them
  until it is ticked — the catalogue's documented default for new capability. **[my call]**
- **`normalizeLayout` must stay forgiving.** Today one unreadable item throws the whole layout back
  to the default. A malformed widget, or a `w:` item without a definition, is DROPPED with its item
  — the same treatment as a retired panel key — and everything else stays where it is.
- **`widgets` must be declared** in the `/api/config/my-config` response schema
  (`roles.routes.ts:208-238`), or Fastify strips it before it reaches the browser.
  `LAYOUT_VERSION` does not move: the field is additive and old layouts simply have none. The two
  PUT routes run the strict schema as well, so a bad widget is a 400 when saved, not a silent drop.
- **A widget grants nothing.** Its data comes only from §5's routes, which require
  `INSTRUMENT_READ` and apply the viewer's own scope. A role-default widget that names an instrument
  outside a viewer's scope shows the rest; one whose every instrument is outside it shows "No
  instruments in your view".
- **Who may add one: a SUPER_ADMIN only** (operator, 2026-10-28: "super admin only" — the
  2026-08-29 Arrange rule stands). The add / edit / remove controls exist only in Arrange mode,
  which only a SUPER_ADMIN reaches; the two layout PUT routes refuse a layout whose `widgets`
  differ from the caller's stored ones unless the caller is a SUPER_ADMIN (the screen hiding them
  is presentation; the 403 is the control). A widget a SUPER_ADMIN builds sits in their own layout
  — seen by them alone — until they press *Save as role default* (new, in Arrange mode, through
  the existing audited `PUT /api/roles/dashboard-layout/role/:name`); every user of that role then
  sees it, subject to the `custom_widgets` panel. Other users keep their role's layout (they cannot
  arrange, so none of them should hold a layout of their own; any that does keeps it whole and
  meets the role's widgets after *Reset to role default*).
- **No new permission, and no reuse of `DASHBOARD_*`.** Reusing those would reverse the 2026-10-24
  strip, which is still owed on AWS and would remove the grant again on its first run. **[my call]**

### 6.2 What a person sees

- **Arrange → Add widget** opens one dialog:
  1. **Type** — four tiles.
  2. **Instruments** — *Follow the dashboard selection* (the Block/Area drill-down in `?fl=`), or
     *Pick instruments* (Block → Area → tick list, the Data Report's `history-selection.ts`).
  3. **Keys** — the catalogue for those instruments in two groups, *Time series* and *Attributes*,
     searchable; each row shows label, key, kind, last seen and a *Measured* badge. A text-only key
     is disabled for a Trend chart with the reason beside it.
  4. **Display** — per key: label, unit and decimals (raw keys only), colour; the widget's title.
  A live preview renders from §5 before Add.
- A widget is a `PanelCard` (the site band header, menu: Edit, Remove), moved and sized like any
  panel, shown in BOTH the Tabular and Graphical views (it is not in `hiddenPanelsFor`).
- **Value cards** — one card per instrument × key: value, unit, the instant (`useDatetimeFormat`),
  instrument ID and Location. Measured → the server's status colour and word. Raw → a neutral grey
  rule and the words "Not judged"; **never green**. NA when the key has no reading; Offline when the
  server says the instrument is not reporting.
- **Latest values table** — a row per instrument (ID, Area, Location), a column per key; the
  default `.tbl-grid` look; search across every visible column. The rows are the server's whole
  answer for a bounded set (≤ 200), so paging them on screen counts the true total.
- **Trend chart** — `TimeSeriesChart` (`variant="trend"`), a period chosen in the widget, the
  `points` path with `SampledNote` and a Current / Min / Max / Average strip per series, limit lines
  only for a measured key, "N text readings not plotted" when there are any. Zoom refetches, as on
  the trend page.
- **Time series table** — `telemetry-history` with `keys`, paged on the server, newest first, at the
  instrument's decimals for a measured key, as received for a raw one.
- **Refresh** — each widget polls at the dashboard's existing readings interval
  (`use-telemetry.ts`), one request per widget (a chart: one per instrument).
- **Height** — the two table widgets follow their content (they join `AUTO_HEIGHT_PANELS`'s rule,
  observing the content wrapper); cards and charts keep a dragged height.

### 6.3 Tests (web: one file per process, judged by exit code)

The dialog produces the widget JSON it shows; the catalogue's two groups; a text key refused for a
chart; **a raw key never renders green** (mutate the palette, not only the branch); a measured key
prints the server's decimals; an instrument missing from the response is not drawn; a stored layout
with one malformed widget keeps every other item (shared unit test); *Save as role default* only for
a SUPER_ADMIN. Each widget rendered once with the built stylesheet at a dashboard panel's size
(1240 × 880) and looked at before it is called done.

## 7. Phase 3 — the trend page, per profile

- **Stored on the profile** **[my call]**: `instrument_profiles.display_keys JSONB NULL` — up to 12
  key references with display settings. One hand-authored migration (the partitioned-table DROP that
  Prisma emits is stripped, as every time); applied to `compliance_core_db` and
  `compliance_core_db_test`. Models and enums unchanged.
- **Written by** `PUT /api/instrument-profiles/:id/display-keys`: SUPER_ADMIN (as the profile's
  measurements, offset keys and device-certificate switch are; the plain profile PUT is
  `INSTRUMENT_UPDATE`) **[my call]**, re-auth action `UPDATE_INSTRUMENT_PROFILE` (exists, ships OFF),
  audit `INSTRUMENT_PROFILE_UPDATED` with before and after (existing action — registries unchanged).
- **On the trend page** a SUPER_ADMIN *Keys* pencil opens the §6.2 key picker over this instrument's
  keys and says what it applies to: "all 105 instruments of T&RH Sensors". Then:
  - extra **value cards** after the two band gauges (no arc for a raw key — there is no band);
  - an extra **chart card** per numeric key (limit lines only for a measured key);
  - extra **columns** in the Time Series card (`pillTone` already renders "nothing judging this"
    neutral).
- The page's PDFs are unchanged in this phase and print temperature and humidity only (Phase 4).
- The dead `telemetry-keys` request becomes the picker's source; the stale "per-user extra keys in
  `localStorage`" line in `docs/feature-notes.md` is corrected.

## 8. Phase 4 — downloads (separate approval, not designed here in detail)

- The Data Report and the Instrument Trend PDF include the profile's extra keys; the frozen snapshot
  records which columns were printed. Existing report kinds; nothing new to approve.
- A widget's own download is a new `REPORT_KINDS` entry (`dashboard-widget`), which means Report
  Settings (Direct / Request), approvers, `deliverReport` and the download audit. Until then a
  widget has no export icon.

## 9. Alternatives considered

- **Revive `/api/dashboards` as a ThingsBoard-style builder** — named dashboards, each assigned to
  roles or users. Closest to ThingsBoard, but it is a second dashboard beside `/`, its data fetcher
  would have to be rewritten anyway (it returns nothing for every type), and it reverses the
  2026-10-24 permission strip. It can come later on top of §5 and the §6 widget renderers; nothing
  here blocks it.
- **A global telemetry-key display-name map**, like Attribute Display Names. Deferred; a label per
  widget comes first.
- **Per-user trend-page keys** (the 2026-08-24 design). Rejected: kept in one browser, lost on
  another PC, and one instrument's page would then differ per person while its PDFs do not.

## 10. Touch points

| Area | Files |
|---|---|
| Shared | new `types/data-keys.ts` (+ test); `types/dashboard-layout.ts` — `normalizeLayout`, `readItem`, `resolveLayout` (+ test); `types/panels.ts` (`custom_widgets`, frozen-order test re-pinned by appending); `index.ts` |
| API, Phase 1 | `modules/instruments/routes.ts` (`telemetry-keys`, `/:id/telemetry` `keys`, `telemetry-history` `keys`); new `modules/instruments/data-keys.ts` + its routes (a child plugin of the instruments routes, so no `app.ts` / `test-helper.ts` registration); `telemetry.repository.ts`; `telemetry-overview.ts` (a per-measurement read-out of the bounds and fault flags it already resolves); `e2e/instrument-telemetry-range.test.ts` (resolver-agreement case) |
| API, Phase 2 | `modules/config/static-routes/roles.routes.ts` (`my-dashboard-layout` PUT; `my-config` response schema declares `widgets`); `modules/roles/routes.ts` (role layout PUT); `modules/config/panel-access.ts` (reads the new panel key) |
| API, Phase 3 | `prisma/schema.prisma` + one migration; `modules/instrument-profiles/routes.ts` (`display-keys`, `profileProps`) |
| Web, Phase 2 | `routes/dashboard/index.tsx`, `panel-grid.tsx`, `panel-card.tsx`, `panel-auto-height.ts`; `set-point.ts` (the per-quantity verdict lifted into one function) and `routes/instruments/band-gauge.tsx` (calls it); `routes/config/role-access.tsx` Panels tab (the new entry appears by itself — checked, not changed); new `routes/dashboard/widgets/` (dialog, key picker, four renderers, their hooks) |
| Web, Phase 3 | `routes/instruments/trend.tsx`, `band-gauge.tsx` (or a sibling value card), `trend-chart-card.tsx`, `timeseries-table-card.tsx`, `use-trend-data.ts`, `trend-series.ts` |
| Docs | `CHANGELOG.md`; `docs/feature-notes.md` (new note + the stale line); root, `apps/api` and `apps/web` `CLAUDE.md`; `docs/recreation/06-api/endpoints.md`; `tasks/todo.md` |

**Counts that move:** API routes +2 (`data-keys`, `latest-values`) and +1 in Phase 3; one migration
in Phase 3; one `PANELS` entry. No model, enum, permission, re-auth action, audit action, sidebar
item, config def or config page moves.

## 11. Order and rollout

Phase 1 → 2 → 3, each in its own commits, with the full API suite and every touched web test file
run before each push. Phase 4 waits for its own go-ahead. AWS: Phase 3's migration rides the normal
deploy; nothing has to be run by hand. Independent of the owed 2026-10-24 permission strip.

## 12. Calls I made that the operator did not

1. Widgets live on the existing dashboard and trend page, not in a revived `/api/dashboards`.
2. Dashboard widgets are stored in the layout JSON, not a new table.
3. Built widgets are governed by one new panel, `custom_widgets`, on Roles & Access → Panels, and the layout routes refuse a widget change from anyone but a SUPER_ADMIN.
4. No new permission; `DASHBOARD_*` is not reused.
5. Trend-page extra keys are per PROFILE, set by a SUPER_ADMIN, not per user.
6. A raw key is never judged and prints as received unless the widget sets decimals.
7. A measured key's unit and decimals cannot be overridden on a widget.
8. A measured key's verdict is the band gauge's existing rule, lifted into one function.
9. "Numeric" is a picker hint, never a gate; the chart says what it could not plot.
10. Four widget types first: Value cards, Latest values table, Trend chart, Time series table.
11. No downloads until Phase 4.

## 13. Answered by the operator (2026-10-28)

1. **Who may add a dashboard widget:** "super admin only" — read as: only a SUPER_ADMIN builds,
   edits and removes widgets, and shares them by saving a role's default (§6.1). If it meant that
   only super admins should ever SEE built widgets, *Save as role default* is simply never used;
   nothing else changes.
2. **Trend page extra keys:** "Yes, per profile" — Phase 3 stays as written (§7).
