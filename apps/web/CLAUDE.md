# DigiLog Web — CLAUDE.md

## Overview
React 19 SPA built with Vite 6. In dev it runs on the Vite dev server (port 5175). For production-style builds it outputs to `apps/web/dist/`, which is also what Capacitor copies into the Android APK.

## Build & Deploy
```bash
# Local Development (Windows)
cd apps/web && npx vite --host         # Dev server on port 5175

# Build (consumed by the Fastify static-serve at :3000)
cd apps/web && npx vite build          # Outputs to apps/web/dist/
```

> ⚠️ **Correction (2026-08-24): the APK/Capacitor commands that used to be here are fiction.**
> `apps/android/` does not exist in this fork — verified `ls apps/` 2026-08-24 (only `api`, `web`).
> There is no Capacitor build, no APK, and no `cap`/`gradlew` step. Root `CLAUDE.md` confirms: no
> mobile app here. If you need APK build history, it's in `apps/web/DECISIONS.md` / `CHANGELOG.md`
> as a removed feature, not a live command.

## Testing
```bash
cd apps/web && npm test                # Run vitest once (CI-style, exit 0/1)
cd apps/web && npm run test:watch      # Re-run on file change

# Or run a single suite directly:
cd apps/web && npx vitest run src/routes/version-history/__tests__/diff.test.ts
```

- Runner: vitest 3.x with `environment: 'jsdom'` and `@vitejs/plugin-react`.
- Config: `apps/web/vitest.config.ts` (intentionally separate from
  `vite.config.ts` — the dev/build config reads HTTPS certs at module load
  and registers VitePWA, neither of which belongs in a unit-test runner).
- Setup: `apps/web/src/test-setup.ts` registers `@testing-library/jest-dom`
  matchers for component tests that arrive later.
- Workspace: `vitest.workspace.ts` at the repo root includes the web project,
  so `npm run test` from root picks it up alongside api / shared / integration.
- First suite (B7.1, 2026-05-02): `routes/version-history/__tests__/diff.test.ts`
  covers the `diffSnapshots()` engine in `routes/version-history/index.tsx` —
  8 cases across scalar / keyed-array / meta-filter / no-change branches across
  the three shown EntityKinds (cleaning-profile / checklist-profile /
  equipment-group). The `filter-profile` tab + its set-style diff branch were
  removed 2026-06-29 (no user-facing Filter Profiles page existed).

## Key Paths
- Source: `apps/web/src/`
- Entry: `apps/web/src/main.tsx`
- Routes: `apps/web/src/routes/` (**51 `<Route>` definitions** in `main.tsx`, verified `grep -cE "<Route"` 2026-08-29. 50 -> 51 on 2026-08-29: `/config/export-options`, which had a config def declaring customPagePath and a card on the Configuration dashboard but NO registered route — the card fell through to the dashboard, so the page had never been reachable. Earlier, verified 2026-08-27 — 49 → 50: new `/config/alarm-webhooks` page (target form with a placeholder picker rendered from `ALARM_WEBHOOK_VARIABLES`, a scope picker reusing the functional-location tree widget, Send test, and a status-filterable delivery log). Earlier, 2026-08-24, 48 → 49: new `/instruments/:id/trend` page (gradient identity strip, one period/interval row, two BAND GAUGES, full-width limit-lined charts, raw paged time-series + alarms side by side). The latest-value cards it launched with were replaced by `band-gauge.tsx` on 2026-08-24 — a bare number cannot answer "how close to the limit is it?", which is the page's whole question. **Restyled 2026-08-31 to an operator reference image, and the number leads again — but the band did NOT go away: the horizontal track became the ARC around the quantity icon (swept to the reading's place between its bounds, red on a breach) and the two bounds are named in a three-cell panel under it. See "The trend latest-value card" below.** `/config/role-assignments` removed 2026-08-19 as dead code (its 7 config defs went in the Phase 0 strip and `system_config` held 0 rows for them), 49 → 48; the previous "23 folders / ~84 pages / 77 Routes" was stale before 2026-08-11 and the shortfall has NOT been reconciled. 2026-08-13 added `/functional-locations`; 2026-08-14 added `/alarms` and `/config/alarm-rules`; 2026-08-16 added `/functional-locations/:id`)
- Hooks: `apps/web/src/hooks/` (auth, branding, datetime, pagination, reauth, session, single-tab, toast, field-labels)
- Components: `apps/web/src/components/` (layout, UI primitives, dialogs)
- API Client: `apps/web/src/lib/api-client.ts`

## Instrument dashboard (2026-08-11)

`routes/dashboard.tsx` became `routes/dashboard/` — `index.tsx` (stat cards +
Table|Graphical toggle), `telemetry-table.tsx`, `floorplan-view.tsx`,
`room-detail.tsx`, `time-series-chart.tsx`, `status.ts`, `use-telemetry.ts`.
Plus `routes/config/floorplans.tsx`, the placement editor.

**The graphical view DRAWS the floor as SVG and never renders the uploaded plan
image.** The first cut showed the image with transparent hotspots over it and
read as a scan with rectangles stuck on top. The image now appears only in the
editor, faded, as a tracing guide. Rooms store proportional `x/y/w/h`, so the
drawn layout is resolution-independent.

**"Live" is polling.** There is no browser-facing WebSocket or SSE channel here
(the `@fastify/websocket` registration is INBOUND device ingest), so every live
surface is an SWR `refreshInterval` and the UI says "updates every Ns".

The chart is hand-rolled SVG — no dependency, consistent with this app having
dropped `chartjs-node-canvas`, `reactflow` and `@monaco-editor/react`. Series
colours come from a fixed validated categorical order; status colour never
carries meaning alone (always a glyph + word).

**Chart colours live in `app.css` as `--chart-*` custom properties (2026-08-27),
and every consumer must read them WITH a literal fallback** —
`var(--chart-series-1, #2a78d6)`, never a bare `var()`. The PDF export
(`routes/instruments/chart-image.ts`) mounts `TimeSeriesChart` off-screen and
serialises its live SVG into a STANDALONE document with **no stylesheet
attached**, so the custom property is undefined there and only the fallback
resolves. The consequence, stated plainly because it is easy to rediscover the
hard way: **the exported chart can never follow a future theme.** It will always
print the fallback literals. That is an accepted limitation, not an oversight —
the indirection exists so a future dark theme need not touch chart code, and a
signed §11 record printing a black or invisible line would be far worse than one
printing yesterday's palette. The reasoning is also written beside the variables
themselves in `app.css`.

**Trend chart interaction (2026-08-27) — zoom REFETCHES, it does not magnify.**
`routes/dashboard/chart-zoom.ts` turns a drag selection into a time range; the
page sets a custom range and requests it fresh, so zooming into a sampled
30-day view reveals the true raw readings for the narrower window. `SampledNote`
("Showing N of M readings") takes `shown` from the RAW reading count, not from
the post-bucketing point count. Rendering the picture and the numbers from two
different populations is the defect these two rules exist to prevent.

`apiClient.postFormData()` is the ONE way to upload multipart — it reuses the
single definition of where the session token lives (`sessionStorage`). A
hand-rolled `fetch` reading `localStorage.getItem('access_token')` is why
profile photo upload silently 401'd until 2026-08-11.

## The trend page's Time Series (Raw Readings) card (2026-09-01)

`routes/instruments/timeseries-table-card.tsx`, lifted out of `trend.tsx` and
rebuilt to an operator reference image.

- **`pillTone()` is the whole design.** `unjudged` (neutral) means NO bound is in
  force — **not** "this bound is null". With `Enable_Temp_NMT` off and NLT on the
  server nulls only `tempMax`, and the evaluator still raises CRITICAL on a low
  breach; a neutral pill would tell the reader nothing is checking a value the
  alarm system is checking. Neutral iff no bound survives; green iff one survives
  and the value passes. **Both-bounds-null, extra telemetry keys, and the
  pre-load path (`overview` undefined) are all neutral** — green during load
  would flash "in limit" before anything had been checked. All pinned.
- **Row colour is computed, never copied from the mock.** The reference's reds
  are arbitrary (a red 24.2 beside a green 24.5); reproducing them would assert
  excursions that did not happen.
- **Timestamps go through `useDatetimeFormat`.** The old cell used
  `new Date(...).toLocaleString()`, silently ignoring the administered format,
  clock and TIMEZONE. This widget had zero tests before 2026-09-01, which is why
  that survived; look for the same mistake anywhere a date is rendered without
  the hook.
- The band's glyph is an explicit `icon` prop, never sniffed from the unit
  string — otherwise humidity gets a thermometer the day someone administers
  `degC`.
- Humidity is `--chart-series-2` (orange), not the mock's blue: a quantity's
  colour is app-wide identity, shared with the charts and the PDF export.
- The band is coloured by QUANTITY, not status — so a breaching latest reading
  shows a calm band above a red pill. Deliberate; the judgement lives in the
  pills.
- It uses a hand-rolled `<table>` rather than the shared `Table`/`.tbl`, whose
  header band and rhythm this design overrides. The one table in the app that
  does not follow the shared style.

**MUTATE THE CONSTANT, NOT JUST THE BRANCH.** This card is where that rule was
learned, on 2026-09-01. Its guard "a value nothing is judging must never render
green" PASSED while the one green mark it existed to catch went unseen: the
row's edge bar carried an inline hex, React serialises `#10b981` to
`rgb(16, 185, 129)` in the DOM, and the assertion tested the source string
rather than the rendered value. Mutating `pillTone` failed the test; mutating
the colour MAP did not — the bar was invisible to it.

- The fix was the cause, not a cleverer matcher: `ROW_EDGE` (inline hexes) and
  `ROW_DOT` (Tailwind classes) were two colour vocabularies for ONE mark, free
  to drift into a green bar beside an amber dot. They are now one class-based
  `ROW_ACCENT` used by both, so a class name appears in the markup verbatim and
  an assertion can actually see it.
- The general rule: a **logic** mutation proves the tests read the right values;
  a **data/palette** mutation proves they read the RENDERED OUTPUT. They catch
  different blindness, and a test that reads its input rather than its output is
  indistinguishable from a working one until something breaks.
- Same shape, same day, in the tooling rather than the tests: a file watcher
  that globbed `routes/instruments/*.tsx` reported a tree "quiet" while a file
  in `__tests__/` had been written seconds earlier. Neither instrument errored.
  Both reported success while looking at the wrong surface.

## The QC floor plan is TRACED, and carries an annotation layer (2026-08-31)

Every other plan is generated by `apps/api/scripts/draw-cwh-floorplan.ts`. The
`CWH — QC` plan is transcribed from a real drawing (`QC Layout.png`), and that
made `floorplan-view.tsx` render three things it never had to before.

- **`room.meta.fill` OVERRIDES the zone tint.** The draughtsman's colours say
  what a room is FOR; `grade` says how it is classified. Both are stored, and
  `grade` is still returned and still correct. This is only safe because the
  grade legend and the grade tab were both removed in August — **if a grade
  legend ever comes back it must not be keyed off the fill**, because on a
  traced plan the two disagree by design. NULL `meta` = the zone tint exactly as
  before.
- **`room.meta.fch` / `.dims` are printed verbatim, never computed.** The
  drawing is schematic and not to scale; deriving a size from `w`/`h` would put
  a number on screen that the plan does not carry.
- **`plan.annotations` is the rest of the drawing** — equipment, HVAC/exhaust,
  water points, airflow runs, free text — drawn AFTER the rooms so a symbol
  against a partition is not buried, and `pointerEvents="none"` throughout so
  none of it swallows a click meant for the room beneath. **Nothing in it ever
  takes a status colour**: an HVAC block marks where a unit is DRAWN, nothing in
  this install senses one, and colouring it would assert a health nobody
  measured. The plan-symbol legend renders only when `annotations` is present —
  a legend for symbols a plan never draws teaches a reader to look for equipment
  on a floor that has none.

**`captionHeader()` in `room-geometry.ts` is where the readings-vs-captions
fight is settled, and READINGS WIN.** A traced room wants four header lines
where a generated one prints one, and that space comes out of the tile grid. The
helper costs the captions against `tileLayout` and DROPS them if reserving the
space would show fewer instruments. It replaced a fixed `h >= 78` threshold that
happened to hold for all twelve QC instrument rooms but encoded no reason — one
resize and it would have hidden a temperature behind a ceiling height with
nothing to catch it. `tileLayout()` gained a matching `headerH` parameter; it
defaults, so no generated plan moves by a pixel.

Pinned in `__tests__/room-geometry.test.ts` (mutation-checked: removing the
readings-win comparison fails it) and, on the API side, by
`src/e2e/floorplan-annotations.e2e.test.ts`, which asserts the data survives
Fastify's response filter.

## Alarms page (rebuilt 2026-08-31)

`routes/alarms/` is `index.tsx` + `alarm-stat-cards.tsx` + `alarm-filters.tsx` +
`acknowledge-dialog.tsx` + `alarm-table.tsx`, over the pure `alarm-display.ts`.

**`alarm-table.tsx` is the table's presentation, and it is SHARED (2026-09-01)**
— the banner, `Th`/`Stack`/`UnitLine`, the state marker, the `ACCENT`/`VALUE_INK`
tone maps and one component per cell, imported by this page AND by the trend
page's `routes/instruments/alarms-widget.tsx`. Until then those were two
hand-written tables, and the copy had drifted exactly as copies do: the widget
keyed its status pill off `severity`, the defect this page had fixed one day
earlier. `AlarmStatusCell` is the single reason that is now structurally
impossible on either screen.

It is **presentation only** — no fetch, no filter, no sort state, no acknowledge
mutation. The two screens get their rows in genuinely different ways (this page
filters, counts, sorts and pages SERVER-side; the widget windows one instrument's
alarms on `raisedAt` in the browser), and a configurable `<AlarmTable
columns={...}>` would have meant reshaping a data flow that is correct. **Do not
move the query wiring into it.** The widget shows NINE of these twelve columns —
Instrument ID and Location are redundant for a single-instrument view, and the
sticky Acknowledge cell needs the gate, the re-auth dialog and a revalidation,
none of which a read-only widget carries. Its state marker therefore rides on the
TYPE cell, not Instrument ID.

**Nothing on this page filters, counts, sorts or pages in the browser.** It used
to do all four over `GET /api/alarms?limit=500`, which made the four state boxes
count the newest 500 alarms while reading as plant-wide totals. `filterByQuadrant()`
and `quadrantCounts()` were DELETED and a comment stands where they were —
reintroducing a client-side count is the obvious "improvement" and it will be wrong
again the moment this installation passes one page of alarms.

- The four cards and the Status dropdown read and write ONE value, so they cannot
  claim different things about what is shown.
- `counts` and `total` come from the same response as the rows.
- **There is deliberately no sparkline and no "from yesterday"**, though the
  supplied mock had both: nothing in this system stores alarm-state history.
- **Cleared-Unacknowledged is AMBER, never neutral** — the overnight excursion
  nobody answered for is the one row that must not look finished. `QUADRANT_TONE`
  in `alarm-display.ts` is the single source for that, read by the card, the row's
  left accent and the status pill.
- The status pill takes the four-state tone. It was keyed off `severity` until
  2026-08-31, so on an installation where every alarm is CRITICAL every pill on
  the page rendered red.
- The dark table banner is `color-mix(... var(--theme-primary) ...)`, not a
  hardcoded indigo, so it follows all ten colour presets.
- Sortable headers offer only the columns the SERVER can order on — sorting one
  page of a paged result would rearrange twelve rows and call it a sort of five
  hundred.
- The date range is sent as an INSTANT (`localInputToIso`): `datetime-local` gives
  zoneless text, and sending it raw would let the API resolve it in its own zone.
- **Inactivity alarms** (source `INACTIVITY`, 2026-08-31) render as Type
  `Inactivity`, Value `No data` (raised by the absence of a reading), Limit
  `quiet > 15m` from the frozen snapshot and Cleared Value `Data resumed`.
  **All three of those wordings are administered** (Config → Inactivity Alarms →
  Column Wording, served by `GET /api/config/inactivity-alarms/display-texts`
  to every authenticated user), and all three helpers take an optional trailing
  texts argument — omit it and you get the shipped wording, never a blank.
  Two rules that are not style: the **Limit** wording is a TEMPLATE with a
  REQUIRED `{minutes}` token substituted from the frozen snapshot, and one
  without it is refused in favour of the default — it states the threshold the
  alarm fired against, and that cannot be typed out of a §11 record; and
  **Cleared Value is gated on `clearedAt`**, because "Data resumed" on a still-
  open outage says the opposite of what the row means.
  `alarmTypeText()` checks the source
  FIRST — their metric is OFFLINE with no limitKind, so they would otherwise fall
  through to `conditionText()` and read "offline out of limit", which is not a
  limit. The `OFFLINE` filter token is labelled `Inactivity` and still matches on
  METRIC, so one token catches both these and any rule-based offline alarm.
- **RS485 sensor-failure alarms** (source `RS485_FAILURE`, 2026-08-31) render as
  Type `RS485 Temperature Failure` / `RS485 Humidity Failure`, Generated Value
  **the administered failure word** (`Error` by default, from `useFailureText()`),
  Limit the constant `numeric`, and Cleared Value the real reading that ended the
  fault. That word is used by the dashboard table, the floorplan tiles and the
  trend raw table too — one hook, so they cannot show three words for one fault.
  **Never hard-code `'Error'` in a component**: the only fallback is the shared
  `RS485_FAILURE_TEXT_DEFAULT`, for "not loaded yet". It briefly showed the raw
  `NA` the sensor sent; that read identically to a slot with no reading, which is
  what `NOT_AVAILABLE` already means.
  `alarmTypeText()` checks this source FIRST as well — these carry metric
  TEMPERATURE or HUMIDITY, the SAME values a limit alarm carries, so without the
  check a dead probe would read "High Temperature" and name a breach that never
  happened. The evidence is deliberately NOT administered wording (unlike the
  three inactivity cells): no configurable phrase beats the value itself. One
  filter token, `RS485`, matching on source.
- **Sensor range failures** (source `SENSOR_RANGE`, 2026-08-31) render as Type
  `Temperature Failure` / `Humidity Failure`, value **`OL`** (administered,
  separate from RS485's `Error`), and Limit the SPAN the reading left, from the
  frozen snapshot. `alarmTypeText()` checks this source early for the same reason
  it checks RS485: the metric is TEMPERATURE or HUMIDITY, so a saturated probe
  would otherwise read "High Temperature" — naming an excursion the system
  deliberately declined to call. `useSensorWords()` serves both words; the
  dashboard cells and floorplan tiles read `rangeError` from the server, never
  re-deriving it, and the numeric slot arrives null in that case.
- **Alarm RULES are gone (2026-08-31)** — no `/config/alarm-rules` page, no RULE
  filter token. `alarmTypeText()` still names a legacy RULE row from its snapshot,
  because the enum value survives in the database.
- **Alarm type names come from config** (`useAlarmTypeNames()`, 2026-08-31) and
  are passed through the same `AlarmDisplayTexts` bag as the other wordings.
  `ALARM_TYPE_OPTIONS` is now `alarmTypeOptions(names)` — **do not turn it back
  into a module-level constant**, which is built once at import and never sees a
  rename. The option VALUES stay hardcoded: they are the API's tokens and an
  unknown one is a 400.
- **The Location column shows the FUNCTIONAL location alone.** The drawn room was
  removed 2026-08-31: it is geometry, not a grouping, and every `floorplan_rooms.code`
  in this installation is its instrument's own code with `label` blank, so the line
  repeated the Instrument ID column. `roomLabel` went from the API response with it.
- **The action column is `sticky right-0`** and the `Generated Value` /
  `Cleared Value` / `Acknowledged by` headings are stacked one word per line.
  Twelve columns overflow a laptop screen and the page's ONLY action was what
  fell off the end of it. The stacking narrows the table; the pinned column is
  what guarantees the button is reachable at any width.
- **Units live in the column HEADERS only** — `Generated Value (°C / %RH)`,
  `Cleared value (°C / %RH)` — never on the cells. The row's metric is already
  named in the Type column, so a per-cell unit repeats it and widens the widest
  columns on the page. A helper for per-cell units has been written and deleted
  TWICE (2026-08-29 as `metricUnit`/`triggeredWithUnit`/`clearedWithUnit`,
  2026-08-31 as `alarmUnit`, the second time after a mockup showed them in the
  cells). Do not add a third; put the unit in the header.

## The trend CHART cards (restyled 2026-08-31)

`routes/instruments/trend-chart-card.tsx`, over `TimeSeriesChart`'s new
`variant="trend"`. Built to an operator reference (`trends.png` at the repo
root). Read these four before touching either file:

- **`TimeSeriesChart` IS SHARED — every new visual is behind `variant`.** Its
  other callers are `dashboard/aggregate-trend-card.tsx`,
  `dashboard/room-detail.tsx` (×2) and `instruments/chart-image.ts`, which mounts
  it OFF-SCREEN to rasterise the signed §11 PDF. `variant` defaults to `'plain'`
  and nothing about that path changed. A download button or a status pill printed
  into a regulated report would be absurd.
- **`PADS` is per-variant and must be threaded EVERYWHERE.** ~12 sites read
  `PAD.*` — `geom`, both `pixelToTime` calls, the pointer-bounds test, the drag
  clamp, grid, axis text, limit lines, crosshair, drag rect. One left on a module
  constant and a drag selects a window the chart never showed, silently.
- **The status pill is NOT "Live"** (the reference hardcodes one on both cards).
  It prints `statusClasses(status).label` from the SERVER-resolved
  `overview.status` — the same value `TrendHeader` and both band gauges print, so
  one instrument cannot carry four status words on one page. Green only when
  genuinely in limit; STALE reads "Offline".
- **`lastReading` is a PROP, and that is the point.** The "Last Reading" box must
  show the latest STORED reading, which the page supplies from
  `latestValueForKey` — the same source as the summary strip's "Current". Reading
  it off `series` would print a bucket MEAN under those words whenever a chart
  interval is selected.

Also: the limit line is drawn at the TRUE bound, never the gridline nearest it
(the reference's own pill and line disagree — that is a mock error, pinned by a
test); a null bound draws no line and no pill, because the server has already
withheld a switched-off bound and the browser must never fill one back in; the
subtitle is deduped against the instrument code by `chartCardSubtitle`, since
every `floorplan_rooms.code` here IS its instrument's code; and humidity stays
`--chart-series-2` (orange), not the reference's teal — a quantity's colour is
app-wide identity, the same call the band gauge made. Green-high/red-low limit
colours ARE the reference's and DO fight this app's red-means-out-of-limit
semantic; they are drawn as supplied only because the pill names each bound in
words, and they are reversible in `app.css` alone.

`ExportMenu` gained a real `iconOnly` prop — not a `className` that hides text,
because the label is emitted in BOTH branches. It carries `aria-label` + `title`;
`trend-downloads.test.tsx` now queries the five export triggers by ACCESSIBLE
NAME, which is what catches an icon button that lost its name.

## The trend latest-value card (restyled 2026-08-31)

`routes/instruments/band-gauge.tsx`, rebuilt to an operator reference image
(`latest value cards.png` at the repo root). Big reading beside a ringed
quantity icon, timestamp under it, status pill top-right, and a three-cell
HIGH LIMIT / STATUS / LOW LIMIT panel. Four rules survive the restyle and are
the ones to read before touching it:

- **The ARC is the band, and it is real data.** It sweeps clockwise from 12
  o'clock for `state.position` — the reading's place between its two bounds —
  and goes red on a breach. **The reference's own arc encodes nothing**: measured
  off the image, the temperature card carries two disjoint arcs and the humidity
  card one, and none matches its reading. An arc around a number reads as a
  gauge whether or not it is one, so this one is wired to the band. No arc at all
  for a slot with no reading or no usable band — an empty ring would draw a band
  nobody administered.
- **ONE status word, printed twice.** The reference shows a "Not reporting" pill
  above a green "WITHIN LIMITS" panel — one instrument, two judgements, one
  screen. The card resolves a single status (breach wins; otherwise the
  instrument's own server-resolved status wins over a local "In limit") and the
  pill and the panel print that same `statusClasses` label. The wording is
  `statusClasses`' own, never a second vocabulary. `data-testid="band-status"` is
  on the PILL ONLY; the panel cell is `band-status-word`.
- **A dead probe is not an unwired one.** `sensorError` / `rangeError` come from
  the server; the card shows the ADMINISTERED word (`Error` / `OL`, via
  `useSensorWords()`) where the number goes, with no unit. **Never a literal** —
  `faultWord()` in `routes/dashboard/set-point.ts` is the ONE place the
  range-before-failure precedence lives, shared with `telemetry-table.tsx`.
- **ONLY `STALE` is inherited from the instrument's status** (fixed 2026-08-31).
  `computeInstrumentStatus` judges BOTH slots, so its `OUT_OF_SPEC` means "one of
  them breached" — inheriting it printed "Out of limit" over a temperature of
  24.5 inside 18–27 whose HUMIDITY had breached (CWH/RDU/001-00, reported live).
  `PARTIAL` is excluded too: if the missing slot were this one, `no-reading`
  returns NO_DATA first, so a PARTIAL here is always about the other slot.
  **`TrendHeader` still prints the instrument-level word, so it can legitimately
  read "Out of limit" above a card reading "In limit"** — different subjects, and
  that is why the card narrowed rather than the header.
- **The timestamp is an INSTANT, not a relative age** (2026-08-31). `formatTs` is
  the page's own `useDatetimeFormat` formatter, passed in — format, clock and
  TIMEZONE are administered, so never `toLocaleString` here. `TrendHeader` still
  shows "updated Nd ago"; that is about instrument freshness, not one reading.
- **The card does NOT narrate a band it cannot draw** (operator, 2026-08-31).
  "Limits are not a usable band (0 - 0)", "No limits set" and "Only one limit is
  set" are gone, and `BandGaugeState` no longer carries a `note` at all — the
  panel names the surviving bounds and the status word says whether anything is
  judging the reading, so all three were redundant. **The one caption that
  remains is the switched-off-bound line**, because nothing else on the card can
  distinguish "never administered" from "administered but not enforced".
- **The panel names only the bounds IN FORCE, and its columns follow them.** A
  bound the instrument switches off (`Enable_Temp_NLT` = 0) arrives as a NULL —
  the SERVER withholds it — so the cell is not drawn at all and the grid becomes
  two columns, or Status alone. `boundEnabled` is passed for WORDING only:
  without it the note read `bandGaugeState`'s "Only one limit is set", false when
  both are administered and one is off. **Never gate display on it.**
- **The provenance is a TOOLTIP on the bounds panel**, not a visible line
  (operator, 2026-08-31). A set point with no source reads as asserted, so the
  fact is kept;
  `telemetry-table.tsx` already keeps the same fact the same way. Note a tooltip
  is reachable by neither touch nor keyboard, so on a wall display this is a
  downgrade, not a neutral move.
- **STALE's word is "Offline"** (operator, 2026-08-31), set in `status.ts` and
  therefore app-wide. It also de-duplicates a vocabulary, which is why it was
  made there rather than in the one card that prompted it:
  `telemetry-table.tsx:487` renders
  `r.reporting ? 'Online' : 'Offline'` off the SAME boolean, since
  `computeInstrumentStatus` returns STALE for exactly `!reporting` (verified, not
  assumed). OK stays "In limit" — a different question, and "Online" there would
  drop the limit judgement. **The two screens can still disagree about one
  device**: the table has separate reporting and limit columns, while on the
  composite surfaces `OUT_OF_SPEC` outranks `STALE`, so an offline instrument
  last seen out of limits reads "Out of limit" on the floor plan and "Offline" in
  the table.

Series colours are the app's own `--chart-series-1/2`, not the mock's brighter
pair — a quantity's colour is app-wide identity. `.band-arc` /
`@keyframes band-arc-sweep` in `app.css` animate `stroke-dashoffset`; the
keyframe's `to` is the value the element already carries statically, so the
resting position is correct with the animation absent, disabled or finished.
That block is deliberately UNLAYERED: it sets no colour and no spacing, so there
is no utility for it to outrank.

## E-signature password fields — `autocomplete="off"` DOES NOT WORK

Every §11 password box must be `components/ui/signature-password-input.tsx`.
Never a bare `<input type="password">`, with or without `autoComplete="off"` —
**Chrome deliberately ignores that attribute on credential fields.** The Alarms
acknowledge dialog shipped one on 2026-08-31 and the browser filled the saved
password into it, which makes a §11.200 signature executable by whoever is at an
unlocked workstation. The field looks entirely normal while this happens.

Second symptom, which is how it was found: a `type="password"` input that is NOT
inside a `<form>` makes Chrome scan the whole document for a username field and
fill an unrelated text box. It typed the logged-in username into the Alarms
search box. That looks like a bug in the search box and is not.

Four measures, each defeating a different heuristic — do not drop any one:
mount as `type="text"` and switch to `password` a tick later (the one that
actually stops the fill); `autoComplete="one-time-code"`; a `name` generated per
MOUNT; `secureField`. Pinned by `components/ui/__tests__/signature-password-input.test.tsx`,
which asserts all four separately and has been mutation-checked.

## Boolean config settings are TOGGLES, not checkboxes (2026-08-31)

`dynamic-config.tsx` renders `type: 'boolean'` with `components/ui/toggle.tsx`.
That covers EVERY dynamic config page — one control style everywhere, which is
the point rather than a side effect.

The distinction is about when a change takes effect: a **checkbox** states an
intention a Save button later commits, a **toggle** reads as something you have
just done. Use `Toggle` for a setting that turns a behaviour on or off; keep
`Checkbox` for selecting items from a list or a set of options submitted
together — which the same page still does for dynamic option sets.

`Toggle` is built on a real `<input type="checkbox">` with `role="switch"`, drawn
over with `peer-*` styles, for the same reason `Checkbox` is: keyboard operation,
form participation and screen-reader semantics come from the platform rather than
from a re-implementation that always misses one of them.

**Green for on, red for off** (operator, 2026-08-31), from `--status-ok-dot` /
`--status-danger-dot`. `Toggle` is the ONE control here that deliberately does
NOT follow `--theme-primary`: it reports a STATE, and a state colour that changes
with the site palette stops meaning anything. The word "On"/"Off" sits beside it
in the same colour — status colour never travels alone, and red/green is the pair
a colour-blind reader is most likely to lose. **Consequence to know:** a setting
merely switched off now reads RED on every config page, which is right for
"alarms are not being raised" and stronger than "require an uppercase letter" 
deserves. Change off to `--status-idle-*` if that becomes a problem.

## Design system (Stage 1 `7ed8329`, Stage 2 2026-08-28)

Tokens live in `src/app.css` `@theme`; primitives in `src/components/ui/`.

- **The type is Inter, self-hosted** (`@fontsource-variable/inter`). **Do NOT
  reintroduce a CDN font `<link>` in `index.html`** — this runs on a factory
  network that may have no internet route, and a webfont fetched at runtime
  falls back to a system face on exactly the machines that matter. That was a
  real shipped bug: Inter was bundled but `body` read `--font-body`, which named
  Sora from Google Fonts, so Inter rendered nowhere. `--font-display` and
  `--font-body` are now the same family, separated by tracking and weight.
- **Radius: two values.** `--radius-control` (6px) and `--radius-card` (10px).
  `--radius-sm/md/lg/xl` are **aliases** onto those — they are not a second
  vocabulary and must not be deleted, because Tailwind generates
  `rounded-lg`/`rounded-xl` from them and ~700 call sites use those utilities.
  `rounded-2xl` is left alone: it is the dashboard panel cards.
- **`.ctl` / `.ctl-sm` / `.ctl-check` / `.ctl-radio`** (`app.css`) are for the raw
  `<input>`/`<select>`/`<textarea>` that have not migrated to the primitives.
  Prefer `Input`/`Select`/`Checkbox` in new code.
- **`.tbl`** styles the raw tables' header band, separator, hover and rhythm, and
  deliberately sets no alignment, font size or cell colour.
- **⚠ THESE LIVE IN `@layer components`, AND MUST STAY THERE.** Tailwind v4 emits
  utilities into `@layer utilities`, and in the CSS cascade an **unlayered rule
  beats every layered rule at any specificity**. While these classes sat outside
  a layer they silently outranked every Tailwind class on the same element — the
  `.tbl` zebra was erasing the `bg-amber-50/20` tint Admin Requests puts on a
  PENDING row, and wrapping the selectors in `:where()` did NOT fix it, because
  specificity was never what decided it. If you add a shared class here, put it
  in the layer, or a call site will not be able to override it.
- **Elevation is `--elev-1/2/3`.** Don't reach for `shadow-lg` etc.
- Status colour never travels alone — always colour + glyph + word.

## Architecture
- React Router v6 with AppLayout wrapper for auth + session management
- **Sidebar collapse** state is in `localStorage` (`compliance-core.sidebarCollapsed`),
  read through a try/catch — a browser blocking site data throws on access, and an
  exception there takes the whole shell down. The auth token deliberately stays in
  `sessionStorage`; do not conflate the two.
- The sidebar item list is **flat on purpose**. `config.sidebarItems` is an
  operator-ordered array (Config → Roles & Access → Sidebar), so adding section
  headings would silently override an arrangement someone chose.
- SWR for data fetching with auto-revalidation
- **`react-grid-layout` was ADDED 2026-08-28** — the first UI dependency taken on
  here in a long time, and a deliberate reversal of the habit recorded below. It
  powers the draggable/resizable dashboard; drag, resize, collision and
  responsive reflow are weeks of fiddly work and a half-working drag is worse
  than none. **Written against the 2.x API, not the v1 one every example shows:**
  v2 replaced `isDraggable`/`isResizable`/`draggableCancel` with
  `dragConfig`/`resizeConfig`, dropped `WidthProvider` for `useContainerWidth`,
  and requires an explicit `width`. A `legacy` entry point keeps the v1 shape;
  `routes/dashboard/panel-grid.tsx` does NOT use it. Both its CSS and
  `react-resizable`'s must be imported or the resize corner is invisible.
- Cleaning-profile pipeline editor uses a custom hand-rolled canvas (the
  `reactflow` + `@monaco-editor/react` deps were removed 2026-05-30 — 0 imports
  remained after the 2026-05-17 rule-chain tear-out)
- Tailwind CSS (no component library) — unified light theme throughout
- Lazy-loaded heavy pages (assets, UNS, checklists, filter management, etc.)
- Permission-based route guards via `<RequireRole permissions={[PERMISSIONS.*]}>`

## Auth Flow
- Token stored in sessionStorage (not localStorage — for shared workstation security)
- Auto-redirect to `/` (dashboard) after login, or returnUrl from query param
- 30-minute JWT refresh cycle
- Session timeout warning dialog
- Single-tab enforcement per user (BroadcastChannel)
- Force login (`force: true`) to terminate existing sessions

## Key Features
- **24** files in `routes/config/` (25 -> 24 on 2026-08-28: `dashboard-cards.tsx` deleted — panel assignment moved to a Panels tab on `role-access.tsx`, stored on `role_configs`/`user_configs` rather than in `system_config`, and gained a per-USER layer. Config -> Appearance lost its second tab with it.) Earlier: **25** files (re-verified `ls apps/web/src/routes/config/*.tsx | wc -l` 2026-08-27 — `alarm-webhooks.tsx` added 2026-08-27, 24 → 25. It has **no config def of its own**: alarm webhooks are a CRUD module with their own tables, not a `system_config` row, so the def count stays at 25 and this page is not driven by the dynamic config page. Its `/config` card is **SUPER_ADMIN-only** — `index.tsx` reads `const visibleSuperAdminCards = isSuperAdmin ? superAdminCards : []` (the delegation allow-list went 2026-08-19) and the card is in `superAdminCards`, so a non-SUPER_ADMIN NEVER sees it and no Configuration Access grant will surface it; `/config/alarm-webhooks` is still reachable by URL, where `RequireRole permissions={[ALARM_RULE_READ]}` admits them. Same as Alarm Rules, which is in the same array. **This line said "default-deny … until `alarm-webhooks` is granted under Configuration Access" until 2026-08-27; that was FALSE.** Earlier: re-verified `ls` 2026-08-19 — `role-assignments.tsx` removed as dead code, 25 → 24; `alarm-limits.def.ts`, added 2026-08-17 for the instrument-limit alarm work, is an auto-discovered def rendered by the dynamic config page, so it adds no file here. Earlier verified `ls` 2026-08-14; the "34" was inherited from DigiLog and was never true here). Most config surfaces are auto-discovered defs rendered by the dynamic page; `alarm-rules.tsx` (2026-08-14) is a real CRUD page, like `floorplans.tsx`
- Entity tree with drag-and-drop hierarchy
- Cleaning-profile pipeline editor (STAGE / CHECKLIST nodes on a custom canvas)
- Notification system (email/SMS/Telegram/Slack)
- Debug trace page for pipeline visibility
- Home / Module Guide (`/home`, `routes/home/`, 2026-07-06): a `home` sidebar
  item defined in `components/layout/sidebar.tsx`'s `allNavItems` AND registered
  in `packages/shared/src/types/sidebar-items.ts` (first entry). **2026-07-13:**
  Home was made a normal, Roles-&-Access-managed sidebar item — the previous
  `if (item.id === 'home') return true` force-show in `sidebar.tsx` was removed,
  so it now follows the same per-role/user `config.sidebarItems` governance as
  every other item (visible-to-all by permission since it has no `PERMISSION_TREE`
  group; toggleable per role on Config → Roles & Access → Sidebar; SUPER_ADMIN
  still bypasses). Existing role_configs were backfilled with `home` at the front
  so nothing regressed. NOT added to the Permissions/Feature-Privileges tab — it
  grants no capability, so visibility is governed on the Sidebar tab only.
  Renders per-module cards via `FlowChart.tsx` (no new deps) in one of **two
  layouts** chosen by each module's `layout` field in `module-flows.ts`
  (2026-07-13): `'sequence'` — a true ordered workflow (the 7 modules with
  review/approve `branch` steps: filter-operations, filter-replacements,
  pm-schedules, approvals, stage-approvals, report-reviews, admin-requests) —
  numbered cards joined by arrow connectors, branches drop below via a
  down-arrow, horizontal scroll + "Scroll for more" cue; `'actions'` (the
  default when omitted, all other modules) — INDEPENDENT capabilities
  (Create / Edit / Delete) as a wrapping grid of cards with **no arrows and no
  step numbers**, so the layout never implies a false order. A test guard
  (`module-flows.test.ts`) enforces that any module with a `branch` step is
  `layout: 'sequence'`. For each operation it
  shows the role(s) **configured live** to perform it, from
  `GET /api/roles/access-matrix` (active roles + permissions + per-role sidebar
  config; authenticated, not ROLE_MANAGE-gated). A role shows on a step only if
  it can see that module's sidebar item AND holds the step's gate; SUPER_ADMIN
  always. Custom roles appear automatically with their own colour. Each viewer
  sees only the modules their own role can access (mirrors their sidebar), via
  `routes/home/viewer-access.ts`. A **"My modules | All modules (audit)" toggle**
  switches to a full auditor view: every module + every role permitted by the
  backend gate, ignoring any role's sidebar (`ignoreSidebar` flag on
  `rolesForStep`/`rolesForGate`). The catalog (`module-flows.ts`) carries each
  step's real backend `gate` (traceable to routes/`PERMISSION_TREE`); the prior
  static `default-roles` map + drift-guard were retired for the live matrix.

## Theme
- Unified light theme: bg-white cards, bg-slate-50 sections, border-slate-200
- Gradient dialog headers are acceptable
- No dark theme anywhere in the application

## Frontend Pages

> ⚠️ **Stale — re-verified 2026-08-24, this list is a 2026-05-17 snapshot.** `assets`,
> `checklists`, `cleaning-cycles`, `filter-management`, `mobile`, `pm-schedules`, `tenant` do not
> exist under `apps/web/src/routes/` any more (Phase 0 strip). The live top-level folders are:
> `admin-requests, alarms, audit, auth, config, dashboard, debug, functional-locations, home,
> instruments, notifications, profile, system-health, users` (verified `ls
> apps/web/src/routes/` 2026-08-24 — 14 folders, not the list below).

admin-requests, assets (dialogs/tabs/hooks), audit, auth, checklists, cleaning-cycles (history/timeline), config (branding/notification-rules/notification-settings/roles), debug, filter-management (operations/profiles/status/scan/traceability/AHU-dashboard/cleaning-profile-editor/retirement/replacement/bulk-upload/equipment), mobile, notifications, pm-schedules, profile, system-health, tenant, users (alarms + rule-chains route folders removed 2026-05-17)

## Phase 2 Pages

> ⚠️ **This entire section (Phase 2 Pages, and Phase 3/parts of Phase 4 below) describes pages
> that no longer exist** — the filter/checklist/PM/RFID domain was removed in the 2026-07-18 Phase 0
> strip. Verified `ls apps/web/src/routes/` 2026-08-24: none of `filter-management`, `cleaning-cycles`,
> `checklists`, `pm-schedules` exist. Kept as history.
- `routes/filter-management/filter-operations.tsx` — Main operations page (8 stages, scan, checklist dialog, reason selection)
- `routes/filter-management/cleaning-profile-editor.tsx` — Visual pipeline editor (canvas, drag, wire, properties panel)
- `routes/filter-management/cleaning-profile-list.tsx` — Profile list with status badges
- `routes/filter-management/filter-profile-list.tsx` — Filter profile management
- `routes/filter-management/ahu-dashboard.tsx` — AHU filter set view with equipment groups
- `routes/filter-management/filter-traceability.tsx` — Per-filter history with full event timeline
- `routes/filter-management/filter-status.tsx` — Filter status overview
- `routes/filter-management/filter-scan.tsx` — QR/barcode scan for filter identification
- `routes/filter-management/retirement.tsx` — Filter retirement workflow
- `routes/filter-management/replacement.tsx` — Filter replacement workflow
- `routes/filter-management/bulk-upload.tsx` — CSV bulk import for filters
- `routes/filter-management/equipment.tsx` — Equipment group management
- `routes/cleaning-cycles/history.tsx` — Expandable cycle history
- `routes/cleaning-cycles/timeline.tsx` — Cycle event timeline with performer names
- `routes/checklists/list.tsx` — Checklist profile list
- `routes/checklists/detail.tsx` — Checklist detail with questions
- `routes/pm-schedules/` — PM schedule pages with monthly entries
- `routes/config/filter-lifecycle.tsx` — Lifecycle state config
- `routes/config/filter-cleaning-reasons.tsx` — Cleaning reasons config

### Phase 2 Patterns
- All routes wrapped in `<RequireRole permissions={[PERMISSIONS.ASSET_READ]}>` or more specific permissions
- SWR for data fetching with refresh intervals
- Toast notifications for success/error (not alert())
- Checklist dialog: no skip, no backdrop dismiss, mandatory submission
- Pipeline editor uses a custom canvas with node types (START, END, STAGE, CHECKLIST)
- Stage types: WASH_IN, WASH_OUT, DRY_IN, DRY_OUT, STORAGE_IN, STORAGE_OUT

---

## Phase 3 Update (2026-04-07)

> ⚠️ **Removed — `rfid_scan_app/` does not exist** (verified `ls rfid_scan_app` 2026-08-24: no such
> file). No mobile app, RFID, or offline sync exists in this fork. Kept as history.

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

> ⚠️ **Themes and Granular Permissions below are current in spirit (still 10 presets, verified
> `grep -c "name:" apps/web/src/lib/themes.ts` 2026-08-24); the per-page examples naming
> filter-list/checklists/cleaning-profiles are stale — those pages are gone. Report Configuration
> below is mostly stale too**: `routes/config/report-config.tsx`, `report-labels.tsx`, and
> `report-signatories.tsx` do not exist (verified `ls apps/web/src/routes/config/` 2026-08-24 — only
> `report-page-titles.tsx` survives, matching root `CLAUDE.md`'s note that it replaced
> `report-settings.def.ts`). `report-page-wrapper.tsx` still exists and is still used (by
> `routes/audit/index.tsx`), but its other listed consumers (Filter Traceability, Quality
> Notifications, RFID Track Record) are gone with their pages.

**Configurable Color Themes:**
- 10 presets in `lib/themes.ts`, applied via CSS custom properties
- Theme selector on Branding page, `use-branding` hook applies on load
- ~~Replaced hardcoded cyan/teal with CSS vars on: filter-list, PM schedules, dashboard, approvals, checklists, cleaning profiles~~ (those pages are gone; the CSS-var theming mechanism itself is still live on remaining pages)

**Granular Permissions:**
- SUPER_ADMIN bypasses all frontend permission checks
- 7 pages have `isSuperAdmin || perms.includes()` pattern
- Feature toggles: Filters Page Controls, Checklist/Cleaning Profile/Equipment Group/PM Page Controls

**Report Configuration** — one page (`routes/config/report-config.tsx`, `/config/report-config`) combining three tabs, each an independent editor with its own config key + Save (consolidated 2026-06-29, replacing three standalone pages; "Report Settings" was removed earlier the same day):
- **Identity** tab (`routes/config/report-page-titles.tsx`, key `report-page-titles`) — company + application name shown in every report header + footer; `hooks/use-report-page-titles.ts` resolves override → Branding. The former configurable common labels were removed; the chrome uses fixed defaults (`By:` / `records` / `Page X of Y`).
- **Labels** tab (`routes/config/report-labels.tsx`, key `report-labels`) — per-report title / subtitle / column headers (view + PDF).
- **Signatories** tab (`routes/config/report-signatories.tsx`, key `report-signatories`) — per-report × role signature label.
- `components/report-page-wrapper.tsx` — shared on-screen report chrome (header always shown; footer suppressible via `hideFooter` / `hideFooterStats`). Applied to: Audit Trail, Filter Traceability, Quality Notifications, RFID Track Record (RFID hides the footer).
- Report-page default page size comes from Pagination Settings (`usePaginationDefaults().defaultLimit`).

**Reauth Fixes:**
- Added `useReauth` + `ReauthDialog` to checklists (list + detail) and cleaning profiles (list + editor)
- Reauth dialog: password autofill prevention, focus management on close
