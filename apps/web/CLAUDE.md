# compliance-core Web (T&RH-Monitoring) — CLAUDE.md

> This file was headed "DigiLog Web" and described port 5175 and a `:3000` backend
> until 2026-10-05 (audit WEB-16). Those are the SIBLING DigiLog checkout's; root
> `CLAUDE.md` corrected them on 2026-08-24 and this file was never re-synced.

## Overview
React 19 SPA built with Vite 6 (`"vite": "^6.1.0"` in `apps/web/package.json`). In dev it runs on the Vite dev server on
**port 5176** — and only if `WEB_PORT=5176` is set: `vite.config.ts` defaults to 5175 and proxies
`/api` to `https://localhost:3000`, the sibling DigiLog backend, so a bare `npx vite` here serves an
app reading the WRONG database. `start-app.bat` sets both. Production-style builds output to
`apps/web/dist/`.

## Build & Deploy
```bash
# Local Development (Windows) — or just start-app.bat, which sets both variables
cd apps/web && WEB_PORT=5176 API_PROXY_TARGET=https://localhost:3001 npx vite --host

# Build (consumed by the Fastify static-serve at :3001 — PORT in apps/api/.env)
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
- Routes: `apps/web/src/routes/` (**54 `<Route>` definitions** in `main.tsx`, 53 → 54, 2026-10-24: `/config/attribute-access`; re-derived `grep -cE "<Route"` 2026-09-16 — unchanged that day (a `/config/attribute-labels` route lived for a few hours and was folded into the Instrument Attributes page); 52 → 53 on 2026-09-08 with `/settings`; 51 → 52 on 2026-09-07 with `/reports` (the report review workflow) after 50 → 51 with `/data-report`; it had gone 51 → 50 on 2026-08-31 with `/config/alarm-rules` and THIS line was never re-synced, so the number here was right by coincidence for a week. Earlier: 50 -> 51 on 2026-08-29: `/config/export-options`, which had a config def declaring customPagePath and a card on the Configuration dashboard but NO registered route — the card fell through to the dashboard, so the page had never been reachable. Earlier, verified 2026-08-27 — 49 → 50: new `/config/alarm-webhooks` page (target form with a placeholder picker rendered from `ALARM_WEBHOOK_VARIABLES`, a scope picker reusing the functional-location tree widget, Send test, and a status-filterable delivery log). Earlier, 2026-08-24, 48 → 49: new `/instruments/:id/trend` page (gradient identity strip, one period/interval row, two BAND GAUGES, full-width limit-lined charts, raw paged time-series + alarms side by side). The latest-value cards it launched with were replaced by `band-gauge.tsx` on 2026-08-24 — a bare number cannot answer "how close to the limit is it?", which is the page's whole question. **Restyled 2026-08-31 to an operator reference image, and the number leads again — but the band did NOT go away: the horizontal track became the ARC around the quantity icon (swept to the reading's place between its bounds, red on a breach) and the two bounds are named in a three-cell panel under it. See "The trend latest-value card" below.** `/config/role-assignments` removed 2026-08-19 as dead code (its 7 config defs went in the Phase 0 strip and `system_config` held 0 rows for them), 49 → 48; the previous "23 folders / ~84 pages / 77 Routes" was stale before 2026-08-11 and the shortfall has NOT been reconciled. 2026-08-13 added `/functional-locations`; 2026-08-14 added `/alarms` and `/config/alarm-rules`; 2026-08-16 added `/functional-locations/:id`)
- Hooks: `apps/web/src/hooks/` (**26** entries incl. `__tests__`, `ls apps/web/src/hooks/ | wc -l` 2026-10-05 — 25 → 26 that day with `use-row-keys.ts`, stable React keys for editable rows with no id of their own (audit WEB-14); 23 → 25 on 2026-10-01 with `use-report-downloads.ts` (the ONE reader of the per-type report download policy) and `use-offset-keys.ts` (which keys get the + / - offset input); this line was not re-synced that day. Earlier 22 → 23 on 2026-09-16 with `use-attribute-labels.ts`, the ONE browser reader of Configuration → Attribute Display Names: `labelFor(key)` returns the administered name or the KEY, never a literal; consumed by the New Instrument form, the Attributes panel, the Settings widget and the Attribute Access picker; since 2026-09-21 it also returns `settingsHidden` / `isHiddenInSettings(key)` — the Settings page's hidden set, from the SAME response, nothing hidden until it arrives. Earlier list: auth, branding, datetime, pagination, reauth, session, single-tab, toast, field-labels)
- Components: `apps/web/src/components/` (layout, UI primitives, dialogs)
- API Client: `apps/web/src/lib/api-client.ts`

## Instrument dashboard (2026-08-11)

`routes/dashboard.tsx` became `routes/dashboard/` — `index.tsx` (stat cards +
Table|Graphical toggle), `telemetry-table.tsx`, `floorplan-view.tsx`,
`room-detail.tsx`, `time-series-chart.tsx`, `status.ts`, `use-telemetry.ts`.
Plus `routes/config/layout-designer/` (2026-09-22; it REPLACED `routes/config/floorplans.tsx`,
the rectangle placement editor, at the same `/config/floorplans` path — see the
Layout Designer section below).

**The entry cards are FULL-COLOUR and the dashboard ground is theme-tinted
(2026-09-25, operator: "all instruments card, active alarms cards, blocks
cards and areas cards and background should be fully colorfull").**
`entry-cards.tsx`: every card is a 135° gradient with white type — All
Instruments wears the theme (`--band-gradient`'s 78 % black mix, diagonal),
Active Alarms is green at zero and red above as a WHOLE card (`data-tone`; the
words beside the figure still say which), and **every Block card is teal and
every Area card is sky** (`KIND_ACCENTS`, `cardKind` from `nav.level`,
`data-kind`; operator, later the same day: "blocks card colors should be one
color, and areas cards should one color" — the six-hue by-position cycle is
gone). 700 → 900 gradients: the 500s would fail the white eyebrows. Medallion,
split chips and View Details are white/15 glass.
**The ground is WHITE on every page** (`bg-white` on `<main>` in
`components/layout/app-layout.tsx`; operator: "make dashboard background
white color in all pages"), after a grey gradient, a theme tint and a deep
theme ground behind the dashboard cards each lasted hours that day. The
colour is on the cards, the bands and the tables, never behind them. A
wallpaper still wins.

**Every widget HEADER wears the site band (2026-09-25, operator: "do it same
for trends page and time series in other pages entire dasboard").**
`.widget-band` / `.widget-band-btn` in `app.css` (`@layer components`): the
trend page's chart cards, Time Series card and alarms widget, the Data Report
widget's toolbar, and every dashboard panel on the DEFAULT tint —
`PANEL_TINTS[0].head` is `var(--band-gradient)` with `headInk: '#ffffff'`
(`@digilog/shared`; `panel-card.tsx` paints `background: tint.head`, ink
`headInk ?? text`; the seven named tints keep their pastel plates). Bodies
stay white. The latest-value cards tint their reading block with the
quantity's series colour instead (dark ink on a wash). Locked by
`trend-chart-card.test.tsx` and the shared tint test. The readings table, panels
and floor are untouched. Tests re-pointed to the card's gradient; not seen on
screen.

**The Tabular | Graphical toggle HIDES panels, and WHICH ones is one pure rule
— `view-panels.ts` `hiddenPanelsFor()` (2026-09-22).** Tabular hides the
floorplan; Graphical hides the table AND the alarms widget (operator: "in
graphical view dont show the alarm widget"; until then only the two reading
panels swapped). The trend shows in both. A hidden panel keeps its stored
position and `onGridChange` carries the whole hidden SET back into the draft —
react-grid-layout reports only what it was given, so without that carry a Save
made in one view would persist a layout missing the other view's panels, and a
panel absent from the layout never comes back. Add to the set there, never by a
second filter on the page. `__tests__/view-panels.test.ts`, mutation-checked.

**Readings on the floor: the font fills the tile, and a sensor fault is
VIOLET (2026-09-22, operator: "show instruments live temperature and humidity
values … in limits green … crossed red … error other color … offline other
color").** Every placed instrument already had a tile; the font was capped at
12 in rooms 100-500 wide. `room-geometry.ts` `fillFont()` now grows it to the
tile (height-, width- and `MAX_TILE_FONT`-bounded — 16 since the operator's
"decrease values font sizes" later that day, exported and pinned — never
below the step's base); the
chip's background is as wide as its TEXT, capped at the tile (it spanned the
tile for a few hours on 2026-09-22 — operator: "just card background should
come till the value only"). `tileValues()` in `floorplan-view.tsx` is the
ONE rule for a chip's tone: green in limit, red crossed, `ERROR` (violet,
`ChipTone`, not an `InstrumentStatus`) for the server's `sensorError` /
`rangeError`, amber offline / partial, and **grey `NA` for a slot with no
reading, so a tile always has both rows**; **a chip prints the value WITH ITS
UNIT and no glyph** (`21.5 °C` / `45 %RH` via `formatSlot`; operator, "just
show value with units") — on the floor, status is colour alone, named only by
the legend under the plan, so do not remove that bar (the same day's correction: 98 of
100 instruments had never reported and their tiles printed the code over
nothing). Legend entry **Sensor error**. **The instrument ID is small and
FIXED** (`TILE_CODE_FONT` 10 in a `CODE_LINE_H` 12 strip; it was 0.85 of the
reading font and "looking so large"). **The plan is CONTAINED in its panel**
(flex column, SVG `h-full w-full` with `xMidYMin meet`; it was `w-full
h-auto` and a portrait plan scrolled at ~1,500px) — enlarge the panel to
enlarge the plan, or press the title bar's **Full screen** button (fixed
overlay, Escape leaves; `data-fullscreen` on the view's root) to see the
whole layout at the screen's size. The chip geometry constants are exported from
`room-geometry.ts` and imported by the renderer and the tests; do not copy
the literals again. Tests: `floorplan-values.test.ts`, `tile-font.test.ts`,
both mutation-checked. Not seen on screen.

**A room prints NOTHING of its own; each tile prints the instrument ID, its
`Location` ATTRIBUTE and the two readings (2026-09-22, operator: "in rooms
show Instrument ID, Location and Values dont show any other things").** The
room code, the room name, the traced captions (`fch`/`dims`) and the door
IN/OUT word are gone from the floor; `captionHeader` is unused by the view
(`headerH = 0`); the tile strip is `TILE_HEADER_H` (ID line + Location line)
and the chip-fit maths and tests count it. The `captionHeader()` paragraph
below is therefore HISTORY as far as the dashboard is concerned. A room with
no instrument prints ONE centred label — its name, else its code — the
"Location" for that room (operator, same day: "which doesnt have instrument
ids for rooms there show Location"); a corridor continuation piece prints
nothing.

**The graphical view has NO "Not placed on any plan" tray (removed
2026-09-22, operator: "in graphical view dont show not placed on any panel
section").** It listed the selection's room-less instruments under the plan so
none could be silently absent from the floor; now a room-less instrument shows
only in the Tabular view and on the Instruments page (one of 101 here, the
gateway `IOTGW01`). The comment where the tray stood in `floorplan-view.tsx`
says so; do not put a summary of it back in the legend or the header either.

**The graphical view DRAWS the floor as SVG and never renders the uploaded plan
image.** The first cut showed the image with transparent hotspots over it and
read as a scan with rectangles stuck on top. The image now appears only in the
editor, faded, as a tracing guide. Rooms store proportional `x/y/w/h`, so the
drawn layout is resolution-independent.

**The tabular view carries TWO placement columns (2026-09-01).**
`telemetry-table.tsx`: **Area** is `functionalLocationName`, the authoritative
Block > Area grouping; **Location** is `locationAttribute`, the instrument's own
`Location` ATTRIBUTE — **never `Instrument.location`**, the superseded free-text
COLUMN of the same name. Both arrive resolved from the server; nothing here
re-derives them.

**There is no Room column, and the reason is a query, not a preference**
(operator, 2026-09-01). The cell's primary text was the instrument's `name`, and
on this installation `name` equals the `Location` attribute on **100 of the 100**
instruments that carry one — so the two columns printed the same string. Its
secondary line was blank on 88 of 101 rows (`room.code` equals the instrument
code, `label` NULL) and, on the 12 traced QC rooms, printed the room LABEL
("DISSOLUTION ROOM-II" beside a name of "QC-II (Dissolution lab-II)"). The room
NUMBER (`CWH-I/218`) never rendered: `label` won whenever it existed.

**It had been kept under a reason that already lapsed** — "the SET POINT columns
come FROM the room, so without it 18.0-27.0 has no visible source". That
provenance is the `setPointSource()` TOOLTIP, and limits resolve from the
instrument's own attributes first, with `limitSource` naming which. A column
defended by an expired comment is the hardest kind to spot; re-read the reason
before repeating it.

The room stays SEARCHABLE with no column showing it — the same call the Alarms
page made, and the search comment says so. The DRAWN room is untouched and is
still the graphical view's entire subject.

**Readings and set points are CHIPS since 2026-09-25** (operator: "increase
font sizes and make bold and temperature and humidity values and ranges
should be visible like highlighted"): `.tv-chip` in the unlayered `.tv-*`
block, tinted from the cell's own ink via `currentColor` — green in spec, red
on a breach. The SET POINT is a `RangeBadge` (same file; `.tv-range*`): two
figures with a bar between them on a plate in the column's hue, `NMT` /
`NLT` small beside a lone bound, bare NA for none; its `aria-label` is
`formatSetPoint`'s string (a blue chip lasted an hour — "not good"). A slot
with no reading prints a bare grey `NA` (`tv-val-na`), never a chip. Cell
text is 15px; temp / rh columns are 10 % x 2 each, Location 16 %, ID and
Area 12 %. Pinned in `telemetry-table.test.tsx`.

Two mechanical rules for that table. Columns are declared ONCE in
`COLUMN_GROUPS` and the `<colgroup>` is generated from it, so the two cannot
drift — but the WIDTH PERCENTAGES are hand-balanced and must total 100, which
`columnWidthTotal()` computes and a test asserts; `table-fixed` silently scales
an over-100 table down, so nothing looks broken while every reading column gets
narrower. And the SEARCH must match every visible text column, with the
placeholder naming them: a column the reader can see and cannot search reads as
a broken search box.

**Every link from the dashboard into the trend page carries the dashboard's
breadcrumb TRAIL (2026-10-03, operator: "when i click on its not going to all
instruments page its going to instruments page", "same in area trends
also").** The selection lives in `?fl=`; `trailFor(nav.breadcrumb)`
(`location-nav.ts`, pure) turns it into links and `index.tsx` passes it as
`trail` to BOTH `TelemetryTable` (the Trend arrow's router state, beside
`from: 'dashboard'`) and `FloorplanView` (ONE `goTrend()` for the room click,
the tile click and both keyboard paths — four bare `navigate()` calls sent no
state until then, so the floor's trend page claimed a path through
Instruments). The trend page reads it with `trailFrom(location.state)` and
`trendCrumbs()` heads its crumbs with it: Dashboard / All Instruments /
<code> / Trend. **From the dashboard the <code> crumb is PLAIN, not a link**
(same day, operator: "still its going to instrument page not going to all
instruments widget" — that crumb was the one pressed to go back, and the
detail page was never on the path); from the Instruments list it links to
the detail page as before. Add a new way into the trend page and it MUST
carry both; the two destination-probe tests (`telemetry-table`,
`floorplan-empty-rooms`) are the pattern.

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

## Built dashboard widgets (2026-10-28) — `routes/dashboard/widgets/`

Widget data keys phase 2 (spec §6, plan `docs/superpowers/plans/2026-10-28-widget-data-keys-phase2.md`).
A SUPER_ADMIN arranging gets **Add widget** and **Save as role default** in the edit row
(`PanelGrid editActions`); every other role gets neither (pinned by `dashboard-widget-controls.test.tsx`,
mutation-checked). Files: `widget-dialog.tsx` (type / instruments / keys / display + live preview,
validated by the shared `customWidgetSchema`), `key-picker.tsx` (the server catalogue, Time series /
Attributes, Measured badge; numeric is a HINT — a text key is warned, only an attribute is refused for
the two history widgets), `role-default-dialog.tsx` (UPDATE_ROLE_CONFIG re-auth with all three
outcomes), `widget-panel.tsx` (`WidgetPanel` = `PanelCard` + Edit widget / Remove while arranging;
`WidgetBody` = the renderer, also the preview), the four renderers, `widget-common.tsx`,
`use-widget-data.ts` (latest-values batched in 200s; selection ids from the readings table's own
overview query; one catalogue URL builder), `key-value.ts` (`keyCell` / `formatKeyValue`).

- **Measured = `judged !== null` from the server.** `quantityVerdict` in `set-point.ts` is the band
  gauge's verdict, lifted; `band-gauge.tsx` calls it. A raw key is NEVER a `statusClasses()` colour
  (`UNJUDGED_CLASSES`, "Not judged"; tests compare with the palette, not a hex). A unit only beside a
  number ("true kPa" was caught by the render check).
- **Definitions live in `layout.widgets`, never on a grid item** — react-grid-layout hands back
  geometry only. `carryStoredFields` (panel-auto-height.ts) now keeps each item's `style` through a
  drag; before 2026-10-28 a drag silently dropped a card's tint and renamed heading.
- **Table widgets follow their content** (`autoHeightIds(widgets)`); cards and charts keep a dragged
  height. Widgets show in BOTH views.
- **Never cut silently**: 60 cards, 10 series, 50 table instruments, each with "Showing X of Y".
  A chart window's `to` is rounded up to the next minute (a stable SWR key; the window moves once a
  minute). Period and zoom chosen on a widget are session state; only the default is stored.

## Instrument detail — the Details card (trimmed 2026-09-16)

Edit offers TWO fields — Instrument ID and Is Gateway — and the PUT carries
only those (code only when changed); the Profile select went the same day
(operator: "remove profile change option in instrument page") and the profile
changes nowhere on this page. Block / Area / Location /
Description / Expected interval and the Active checkbox are gone from the form
and the read view (operator); Enable / Disable stays its own confirmed action.
`detail-edit.test.tsx` pins the field set and the payload; run the three
`detail-*.test.tsx` files INDIVIDUALLY — together they manufacture "multiple
elements" failures (the known runner artefact).

Later the same day: the **Type row left the read view** (operator: "remove
type in instrument details section") — `instrumentType` is still stored and
still on the API row, nothing on this page prints or edits it; pinned in the
same test beside the rows that must exist. And the **grid no longer
stretches**: `lg:items-start`, with Access token, Connection, Latest readings
and Rejected payloads stacked UNDER Details in the left column and the
Attributes panel alone on the right (operator: "details section taking so
much empty space … adjust below cards in that empty space"). The Gateway
panel stays full width below the grid — a gateway's roster is a wide table.
Note `detail-token-reveal.test.tsx` carried four cases for the profile PICKER
inside the edit form, a control `f1650bb` removed; they were red on the
committed tree (`c97633c` repointed only `detail-edit`) and are gone — the
replacement behaviour was already pinned in `detail-edit.test.tsx`.

The header's amber **development-build chip is gone** (operator: "remove
development text on nav bar on top"). It printed Vite's `MODE` on every
non-production build; nothing else read it.

**The header's "AWS testing" chip is GONE (2026-10-03, operator: "remove
aws testing testing on top nav bar").** It was added 2026-09-18 ("Add aws
text word on nav bar"; "do it local application" when offered an AWS-only
build flag) as a plain chip in the left cluster on every build. Nothing read
it. `__tests__/header.test.tsx` now pins its ABSENCE in both sidebar states
(the header's first render test; the `user` fixture needs `fullName` — the
avatar splits it).

## Functional Locations pages (restyled 2026-09-17)

`routes/functional-locations/` — `index.tsx` (hero band + one card per
Block), `detail.tsx` (hero band + Areas tiles + two instrument lists),
`instrument-tile.tsx`, `dialog-banner.tsx`, the three dialogs. Operator:
"best professional and colorful screen and inside screens also", then
"remove live status".

- **The hero band is the Settings widget's language** — `themeGradient`,
  `PageHeader inverted` (the Roles & Access precedent), figures as
  `bg-white/12` tiles. The Block card's top plate is the same gradient so a
  Block reads as a Block from across the room; Areas sit on white with a
  teal rule (`tv-h-loc`'s hue, the dashboard's location colour).
- **No live state on these pages, by instruction.** A reporting / silent /
  disabled split per location and a status badge per instrument tile were
  built and removed within the hour ("remove live status"). Nothing here
  reads `/api/instruments` or `instrument-activity`. The instrument tile's
  left rule is the THEME colour — identity, not status — and both page tests
  assert `queryByRole('img')` is absent, which is where a health bar would
  land. If live state is ever wanted back, it is a fresh request.
- **Two instrument lists on a Block, still SEPARATE.** The direct list is
  the membership editor (`PUT /:id/instruments` sets membership wholesale);
  the read-only "in this block's areas" list tags each tile with its Area.
  The test asserts the Block's own instrument is NOT in the second list —
  the mutant that dropped the filter passed until that line existed.
- `DialogBanner` uses `-mx-6 -mt-6` to run full-bleed inside `Dialog`'s
  `p-6` panel; it depends on that padding, which is why it is local to this
  folder rather than a primitive.
- Tests: `__tests__/index-page.test.tsx`, `__tests__/detail-page.test.tsx`
  (run individually, by exit code). Not seen on screen.

### Deleting a location (2026-10-03, operator: "add delete option for functional locations for super admin")

`delete-location.tsx` is the ONE flow: `deletePlan(loc, isSuperAdmin)` (pure)
reads the tree's own counts — an empty location confirms plainly; one that
holds areas or instruments is, for a SUPER_ADMIN, a confirm that names the
areas and the instruments that become unassigned and sends `?cascade=true`;
for any other role it is the refusal toast and no request. `useDeleteLocation(
reauth, onDeleted)` takes the page's `useReauth()` so one `ReauthDialog` serves
every write, and returns `request(loc)` + the `dialog` to mount. Used by the
list page (a *Delete block* footer action on each card, a trash button BESIDE
each Area row — never inside the row's `<Link>`) and the detail page's Delete
(which then goes to the Area's Block, else the list). **Both pages' create /
edit writes go through `reauth.executeWithResult` now**; they were bare, and a
role that required re-auth got a 401. The list page's Arrange buttons are
gated on `functional_locations.edit` — they named a `.update` node that does
not exist in the tree, which `useCan` denies, so every non-super-admin had
lost them. Tests: `index-page.test.tsx` (11), `detail-page.test.tsx` (7); the
cascade flag and the non-super-admin refusal mutation-checked.

## The report review workflow (2026-09-07)

Every PDF download is a REQUEST an approver signs. Spec:
`docs/superpowers/specs/2026-09-07-report-review-workflow-design.md`.

- **SUPERSEDED 2026-10-01 — there is no Send to and no View draft.** The
  dialog takes a `kind`, reads `use-report-downloads.ts` (Direct or Request,
  remarks, password — Configuration → Report Downloads), collects the password
  itself, and every page hands the built report to `lib/report-delivery.ts`
  `deliverReport()`. Approvers are configured and frozen on the request; a
  PENDING row on Reports opens its snapshot beneath it. The rest of this bullet
  is history; see root `CLAUDE.md`.
- **`ReportDownloadDialog` collects Send to** (`components/assignee-picker.tsx`
  — a user or a role, never SUPER_ADMIN; lifted from the removed
  `SendForReviewButton`) and its button reads *Request approval*.
  `ReportDownloadRequest` carries `assignee` and `assigneeLabel` (for the toast).
  **The picker offers only the ADMINISTERED approver roles and the enabled
  users holding one** (`GET /api/config/report-approvers/current`, through the
  shared `coerceApproverRoles` — the same reader the server applies, so what is
  offered is what will be accepted). With none configured it renders the shared
  `REPORT_APPROVERS_NONE_MESSAGE` as an alert and NO control — a silent empty
  dropdown would read as "no roles exist". Presentation only; the server's 400
  is the control (operator, 2026-09-07: "set by super admin in configurations").
  Every trigger replaces `logReportExport` + `report.save()` with
  `submitReportForReview` (`lib/report-review.ts`) inside the same
  `DOWNLOAD_REPORT` re-auth, sending `report.getSnapshot()`, the period,
  interval, instruments, the PRINTED row count and the remarks. **No page
  calls `save()` any more** — grep for it; the only one is `downloadApproved`.
  The Audit page's Excel export keeps `logReportExport`: it is not a PDF.
- **`ReportSnapshot` v2 is the record.** `createReport` records every drawing
  call (`table` with `bold`, `pairs`, `title`, `note`, `image`, `page-break`)
  and the chrome; `renderSnapshotToPdf(snapshot, { formatDateTime, draft?,
  signatures? })` replays it through the SAME `ReportDoc`. `addNote` and
  `addImage` moved into `ReportDoc` for that reason. `draft: true` prints
  `DRAFT — NOT APPROVED` diagonally on every page (centred by measured width:
  jsPDF rotates about the text's START, and `align: 'center'` is ignored with
  an angle) and no signature line. Pinned by `lib/__tests__/pdf-report-snapshot.test.ts`;
  mutation-checked (no watermark → the draft case fails).
- **`routes/settings/index.tsx`** (sidebar `settings`, route `/settings`, gate
  `INSTRUMENT_READ`; 2026-09-08): a Common settings bar with a **Block →
  Area → instrument cascade** (since 2026-10-03, operator: "in settings page
  give block/area/instrument wise selection" — two native `Select`s over
  `GET /api/functional-locations` using `history-selection.ts`'s `scopeIdFor`
  / `areasOf`, the Area disabled until a Block is chosen, then the
  `SearchableSelect` picker over `GET /api/instruments?limit=<ALL_RECORDS>
  [&functionalLocationId=<scope>]` — the server's scope IS the selection and
  the server expands a Block to its Areas; `instrumentListKey()` is the ONE
  builder of that URL; Block, Area and the last pick remembered in
  `localStorage` (`settings.scope`, `settings.instrumentId`), else the first
  in scope; an empty scope reads "No instruments in this selection.") and
  ONE full-width widget (was square for an hour — operator: "remove the square shape, make widget full width")
  of key / value rows: Instrument ID, then every attribute from
  `GET /api/instruments/:id/attributes` as TILES (accent + ink by the server's
  `slot`: temperature = `.tv-h-temp` orange, humidity = `.tv-h-rh` green, else
  theme; `Updated <updatedAt>` per tile) printing `display ?? value` — Building
  and Area are attributes on this installation and print ONCE (a synthesised
  Block / Area pair beside them drew "why area and building coming 2 times").
  With `useCan('settings.edit')` an Edit button turns the tiles into inputs IN
  PLACE (2026-09-16 — it opened the `AttributesPanel` in a `Dialog` until the
  operator said "another edit popup was showing"): the Instrument ID and every
  attribute the role may edit (`canEditAttributeKey` over
  `/attribute-access/me`), Save/Cancel in the header, ONE remark for the batch
  (`RemarkDialog` `changes` prop), one `reauth.execute` whose callback is
  idempotent because the hook replays it after a 401, each changed KEY PUT with
  the reason, the code PUT last to `/api/instruments/:id`. Test:
  `routes/settings/__tests__/settings-page.test.tsx` — 23 cases: 13 (picker, rows,
  display names, inline edit: inputs in place, Cancel, batch remark + PUTs by
  key, no-op Save, code PUT + list refresh, wildcard refused, SELECTED and
  ALL_VIEW rules); mutation-checked (no write and no wildcard guard each fail);
  + 3 hidden-field cases (below) + 7 cascade cases (2026-10-03: Block options,
  Area waits for a Block, the scope id sent per level, the picker narrowing to
  the server's answer, an empty scope, the fallback pick, the remembered and
  the malformed scope; dropping the scope from the list request fails five).
  The picker's entries are read from its LISTBOX, since the native selects'
  `<option>`s share the role. The first cut was a table with
  expandable rows and an inline details form (`bee0363`) — replaced the same
  day on the operator's restatement. **Which tiles it draws is administered
  (2026-09-21)**: `useAttributeLabels()` also returns `settingsHidden` /
  `isHiddenInSettings(key)` from the same route, the widget filters its
  attribute tiles and the Instrument ID tile by it, and in Edit a hidden field
  has NO input, so nothing here can write it (3 cases, mutation-checked: no
  filter fails all three). Toggled on Configuration → Instrument Attributes
  (Show in Settings per row + one for the Instrument ID). Presentation over
  this page only; the attribute is still served and still on the detail page.
- **`routes/reports/index.tsx`** (sidebar `reports`, route `/reports`, gate
  `REPORT_REVIEW_READ`): three lists as tabs, each the SERVER's party-scoped
  answer via `useSWR('/api/report-reviews?list=…')`. Approve / Reject appear
  only on a PENDING row assigned to me (user id or my role), with the
  `reports.approve` gate, and never on my own request — unless I am
  SUPER_ADMIN, who decides any pending request, their own included
  (2026-09-08; `isSelfDecision` mirrors the server's); View draft for any
  party **while the request is PENDING only** (2026-09-25, operator: "if
  request is approved or rejected then view draft should not come")
  (`openDraft` → `report.toBlobUrl()` in a new tab; nothing saved or
  audited. **`toBlobUrl` FINALISES the document** — the watermark, page numbers
  and end block are painted at finalisation, and the raw `doc.output('bloburl')`
  it used to call skipped all three, so the approver's tab opened a clean
  unwatermarked PDF (review, 2026-09-07). Any new output path goes through
  `finalise()`, never `doc.output` directly);
  Download on APPROVED (`downloadApproved` — audits through
  `/download-log` BEFORE `save()`, refuses a non-approved row; since
  2026-09-25 it passes `signatureTable: reviewSignatures(r, fmt)` — one
  `SignatureColumn` per signer (Reviewed By / Approved By: name, the FROZEN
  `requestedByRole` / `decidedByRole`, date-time) that `pdf-report.ts` draws
  as an autotable in the end block, Name / Role / Date & Time down the left;
  the `signatures` line form still exists for other callers). **Clicking an
  APPROVED row opens its report DATA beneath it** (2026-09-25, operator:
  "once approved then if user click on that row, that report data should be
  shown in below that row in table format"): `report-snapshot-view.tsx`
  renders the frozen v2 snapshot from `GET /api/report-reviews/:id` — the
  signed record, never a re-query — as `.tbl-grid` tables; one row open at a
  time, the action cell stops propagation so Download does not toggle it.
  The decision
  dialog (`decision-dialog.tsx`) collects remarks + `SignaturePasswordInput`
  in one act with the request restated, the acknowledge dialog's shape.
- **Tests replay the submitted snapshot.** The three page tests
  (`trend-downloads`, `generate-report-card`, `alarms-page`) stub
  `submitReportForReview` with a stand-in that records the request and then
  replays `input.snapshot` through the real renderer and saves as
  `replay-<type>.pdf`, so every content assertion reads the document the
  approver would see and every saved name proves the page saved nothing.

## The Data Report page and the Instrument History widget (2026-09-05; own page since 2026-09-07)

`routes/data-report/index.tsx` (route `/data-report`, sidebar item `data-report`,
gated on `INSTRUMENT_READ`) is a page header plus
`routes/instruments/history-widget.tsx` — the trend page's Time Series card for
MANY instruments, with a Block / Area / instrument selection and the Data Report
for the whole Area or a ticked subset. Operator's idea; two decisions put to them
(one PDF section per instrument; a full merged readings table on screen). It
lived on the Instruments page for a few hours (2026-09-05), on the dashboard as
panel `dashboard_history` for two days, and became its own page on 2026-09-07
(operator: *"in dashboard Instruments history widget was there that widget
removed there and add one side bar option Data Report, in that it should come"*).

- **It is NOT a dashboard panel any more.** `dashboard_history` is out of
  `PANELS`, `DEFAULT_DASHBOARD_LAYOUT` and `AUTO_HEIGHT_PANELS` — removing the
  key is what takes it off the dashboard AND off Roles & Access → Panels (the
  `dashboard_trend` precedent); 0 stored layouts named it. The `embedded` prop
  and the `usePanelToolbarSlot()` portal went with it as dead code. **The widget
  prints no title of its own** — the page header names the screen — and the
  page test asserts exactly ONE heading, so a second title fails it (mutation-
  checked). Its Block/Area selection is its OWN, not the dashboard's drill-down.
- **`appendMissing` in `@digilog/shared` inserts, not appends.** A panel a stored
  layout does not know lands under its shipped-layout predecessor with the rest
  shifted down; the bottom only when the predecessor is absent. Written for this
  widget's dashboard interlude; the rule stays, and its test is now exercised on
  the floorplan.

- **Selection lives in `history-selection.ts`, pure.** `selected === null`
  means "everything in scope"; a Set means those ids; re-ticking the last one
  collapses back to null, and ticks for instruments that left the scope are
  dropped. The scope is the Area, else the Block, else everything, sent as
  `functionalLocationId` to the LIST route — the Block → Areas expansion is
  the server's (`resolveLocationIds`), never re-derived here.
- **The table comes from `GET /api/instruments/telemetry-history`**, pivoted
  server-side (one row per instrument-instant) so a page cannot split an
  instant. Each row is judged with ITS OWN instrument's limits, precision and
  span from `telemetry-overview` — two instruments in one Area can differ, and
  the widget test uses exactly that. It reuses `ROW_ACCENT`, `PILL_CLASS` and
  `FAULT_PILL` from `timeseries-table-card.tsx` (exported for it) — one
  vocabulary for one mark; do not restyle a verdict here without the card.
- **Period and interval are `useTrendPeriod`'s URL state**, shared with the
  trend page — the same presets, custom range and interval keys.
- **Restyled 2026-09-16** (operator: "make it more professional … more
  colorful") to the Settings widget's language: the Generate card is the
  page's theme-gradient hero band with the selection it would report stated
  beneath the title (`generate-report-summary`); the widget has a tinted
  toolbar, tick CHIPS (`history-chip`, real checkboxes inside labels, NOT a
  scroll box — "all instruments should be display directly, i dont need scroll
  option") and the dashboard's quantity colours on the two value headings. The
  four summary tiles lived for an afternoon ("remove counts cards"). The old
  `history-subtitle` line survives as `sr-only` text. A toolbar toggle makes
  the widget a fixed full-viewport overlay; Escape leaves it.
- **The selection is the PAGE's — `routes/data-report/use-history-scope.ts`
  (2026-09-07).** Block, Area, ticks, the instruments in scope and the
  per-instrument overview live in one hook the page passes to BOTH the widget
  and the Generate Data Report card, so the card downloads exactly what the
  table shows. The widget is controlled (`scope` prop); rendered bare in a test
  it needs a harness that calls the hook, and the widget test has one.
- **The download is the GENERATE DATA REPORT CARD** (`generate-report-card.tsx`,
  above the widget; operator: *"one card only text should be there Generate
  Data report and one download icon"*): the page's ONE trigger — the widget's
  own icon went, because two buttons making one document is a "which one"
  question on a §11 screen. The icon is `ExportMenu` icon-only on surface
  `instrument-history`, so Export Options gating still applies. Same dialog as
  the trend page's Time Series card (period, interval, remarks), same
  `DOWNLOAD_REPORT` re-auth, same audit row BEFORE the file; each instrument is
  read through `data-report-fetch.ts` and the dialog's `progress` prop says
  which one it is on. **The document is `renderDataReports`: one Data Report
  page per instrument, each byte-for-byte the trend page's, NO cover block** —
  the 2026-09-05 cover (Block / Area / period / count) was dropped when the
  operator asked for "the same report of time series widget"
  (`instrumentHistoryCoverRows` and `scopeNames` went as dead code). Audit
  `reportType` is therefore **`Instrument Time Series`** — it IS that report,
  for each instrument; the `search` column names them. Rows from 2026-09-05..07
  read `Instrument History` / `Data Report` and were not rewritten. File
  `data-report-<date>.pdf`; export surface KEY stays `instrument-history`
  (stored per role in `system_config`), label `Data Report`. Nothing selected →
  the dialog refuses ("Select at least one instrument") and no audit row is
  written. The card test is mutation-checked: putting the cover page back fails it.
- **The trend page's HEADER "Export as PDF" is the Data Report too
  (2026-09-07).** Operator: *"in that report trends also coming remove those
  and add interval feature"*. It used to build the combined charts document
  (`Instrument Trend — Temperature & Humidity`, `TrendSlot` value `both`); it
  now opens `{ kind: 'timeseries' }` — the same dialog with the interval, the
  same document and audit type as the Time Series card. `both` is gone from
  `TrendSlot`; the per-chart icon downloads on the two chart cards are
  unchanged. Pinned in `trend-downloads.test.tsx` (header → `Instrument Time
  Series`, interval offered, zero chart rasters), mutation-checked.

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
- **`SlotColumn` lost `unit`, `accent`, `icon` and `last` on 2026-09-01**, with
  the last-reading BAND they fed and the per-value unit (the column heading
  already carries it). All four survived the band's removal as props that were
  passed, threaded through `ValueCell` and destructured, but never rendered —
  and `last` kept `latestValueForKey()` alive in `trend.tsx` with no reachable
  caller. **An unused prop is a decoy**: the next reader wires something to it
  and cannot see why nothing happens. If you delete a surface, delete what fed
  it in the same pass.
  Two rules those props carried are still TRUE and now live elsewhere, so do not
  relearn them here: a quantity's glyph is an explicit `icon` prop and is **never
  sniffed from a unit string** (humidity gets a thermometer the day somebody
  administers `degC`) — that prop is live on `BandGauge`; and humidity is
  `--chart-series-2` (orange), not the mock's blue, because a quantity's colour is
  app-wide identity shared with the charts and the PDF export.
- **A "last reading" is taken from the RAW rows, never from a chart series.**
  `toChartSeries` bucket-averages when an interval is selected, so its last point
  is a MEAN, and a mean labelled "Current" states a derived number as a stored
  one. `latestValueForKey()` enforced that and was removed with its callers; the
  reasoning now lives in exactly one place — the doc comment on
  `TimeSeriesChart`'s `lastReading` prop. Read it there before reinstating any
  last-reading readout. **That prop currently has NO production caller** (only a
  test passes it) — it is the next thing to check if it is still dead.
- It uses a hand-rolled `<table>` rather than the shared `Table`/`.tbl`, whose
  header band and rhythm this design overrides. The one table in the app that
  does not follow the shared style.
- **Its download is the DATA REPORT (2026-09-04)**, built to `Data Report.pdf`
  at the repo root: `routes/instruments/data-report.ts` (pure, tested against the
  reference's own values) laid out by `renderDataReport` in `trend-report.ts`.
  **Rows are a SCHEDULE, newest first (2026-09-05):** with an interval the first
  row is the earliest reading in the period, each later slot one interval on to
  the period's end, each holding the FIRST STORED READING inside it or `NA` —
  never averages. The page always fetches the WHOLE period down the paged path
  (at Raw too, since 2026-09-05 — the chart path drops non-numeric readings
  before sampling, so `Error` could never print from it). A reading that crossed
  its limit, and the `Error` / `OL` words, print BOLD (`addTable`'s `bold`
  grid). Max/Min print the server's whole-range extremes. Its typography is its
  own (`DATA_REPORT_TYPOGRAPHY` — bigger, bold headings, centred column heads,
  no app-name line); every other report keeps `DEFAULT_TYPOGRAPHY` (bold, raised 2026-10-07; a stored snapshot replays at its frozen scale). The interval
  is chosen IN the download dialog (`showInterval`), seeded from the page. The
  audit type is unchanged (`Instrument Time Series`); the filename is
  `data-report-…`. It prints the Location ATTRIBUTE; the Instrument Trend PDF
  still prints the room.

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

## Layout Designer (2026-09-22) — `routes/config/layout-designer/`

Replaced `routes/config/floorplans.tsx` at the same `/config/floorplans` path
(operator: "in configurations give one configuration prepare layouts. like
starts with empty one, draw shapes room redesigns and room to room linking,
or empty space in between rooms like corridor …"). Spec
`docs/superpowers/specs/2026-09-22-layout-designer-design.md`; the root
`CLAUDE.md` note carries the data rules. Files: `index.tsx` (data, saves,
panels), `canvas.tsx` (the SVG surface; every callback receives PLAN UNITS),
`properties-panel.tsx`, `tools.ts` (pure reducer), `snapping.ts` (pure),
`types.ts`. **Since 2026-10-05 also `plan-panel.tsx`** (style / floor / north,
shown when nothing is selected) **and `structure-panel.tsx`** (the selected
column / window / wall stub / equipment / label, editable in place) — the 2D
design model. Rules: the five structure tools show ONLY on a 2D plan
(`isArchitectural`); every structure edit PUTs the plan's WHOLE
`annotations` object (`saveAnnotations`, the `doors` rule — the API replaces
it whole and refuses `null`); the canvas draws the 2D look (navy walls with a
light core, hatched columns, glazed windows, outlined equipment) itself and
never imports the dashboard renderer; the Delete key takes a selected
structure element before a selected room. Tests: `plan-panel.test.tsx`,
`structure-tools.test.tsx`, `door-controls.test.tsx`, and the dashboard's
`floorplan-designer-2d.test.tsx` proving the same 2D path as a traced floor.

- **`tools.ts` is a pure reducer and `snapping.ts` is pure** — the drawing
  rules are tested one at a time without the DOM. Snap priority is a
  neighbour's CORNER, then its EDGE, then the 2 % grid; a shared wall is only
  ever exact (within `sharedEdges`' half-unit tolerance) by snapping to the
  neighbour, so the neighbour beats the grid. Mutation-checked.
- **A bad outline is refused IN PLACE** (`closedPolygon` → the shared
  `validatePolygon`), with the reason under the canvas (`role="status"`), and
  stays open for correction; nothing reaches the server. The server runs the
  same validator, so a 400 there means a client that bypassed the designer.
- **Every save is the existing audited, re-authenticated request** through
  one `run()` helper (`reauth.execute`, revalidate, toast): geometry on
  release (`onMoveRoom` / `onCornerChange` → PUT with `points` + the derived
  box), a room on close (the panel asks the code first → POST, then
  membership), a door on placement (PUT), a link on the second click (POST),
  properties on Save. A failed geometry save revalidates so the room springs
  back. Undo covers the OPEN outline only — a saved change is a §11 record.
- **Merge pieces** (two adjoining CIRCULATION pieces, or two pieces of one
  code) unions their outlines with the shared `unionRectilinear`, PUTs the
  union onto the selected room, moves the other's instruments, deletes the
  other — three requests under one confirm.
- **jsdom has no `PointerEvent`.** `designer-page.test.tsx` installs a
  MouseEvent-backed polyfill before importing the page; without it every
  `fireEvent.pointerDown` carries no `button` and no coordinates and every
  handler ignores it — all five cases fail with nothing posted, which reads as
  a broken page and is not. Stub the canvas's `getBoundingClientRect` (the
  page maps pixels to plan units through it).
- The dashboard's `floorplan-view.tsx` links to this page as
  "Configuration → Layout Designer" (three places) and so does
  `room-detail.tsx`.
- **Remove** (toolbar, 2026-09-22, operator: "add remove option for lines or
  links or any other things"): removes the SELECTION — room, corner, door or
  link — the same act as the Delete key; doors are selectable on the canvas
  (the placement keeps the stored index). Same day on the dashboard:
  `planExtent()` fits the viewBox to the drawn rooms (no blank band under the
  last row), and full screen shows the drawing ALONE with one Normal screen
  button — the SVG is one `floorSvg` constant rendered in both modes.

## The 2D ARCHITECTURAL style (2026-10-01) — "CWH — QC", "CWH — QC Microbiology", "CWH — QC 3"

A plan whose `annotations.style` is `'architectural'` draws differently; every
other plan is untouched. Operator chose concept A of three
(`Layouts/CWH/concepts/concept-a-2d.png`): *"2d layout was good replace with
that QC layout"*; the Microbiology floor followed the same day (*"same like
qc"*).

- **THE LOOK IS "VIVID STATUS" (2026-10-01, operator: "these layouts look wise
  not good, make those layout more professional and beautiful and colorful
  ui"; shown three concept images, chose A — `Layouts/CWH/concepts/look-*.png`).**
  All of it is paint, in the `ARCH` palette and `readingPill()`:
  - **Floors**: `url(#fp-wash-<tone>)`, a top-to-bottom gradient `wash` →
    `washTo` per status; an empty room `#fp-wash-empty`; a corridor
    `ARCH.corridor`. The plate is plain white and **the grid is gone** — the
    colour is on the rooms, never behind them (the same rule the dashboard
    ground ended on).
  - **Readings sit in PILLS, and the pill's colour has ONE rule**: in limit
    it is a soft tint of the QUANTITY (`ARCH.pill.temperature` orange,
    `.humidity` blue, dark ink of the same hue); in ANY other state it is
    SOLID in the status colour (`CHIP[st].bg`) with white ink. Do not give a
    non-OK state a tinted pill: offline amber beside an in-limit
    temperature's orange is the pair that reads alike. The text is centred
    in its pill and its font shrinks to the pill (`100.0 %RH`). Geometry is
    `PILL_ABOVE` / `PILL_HEIGHT` in units of the reading's font; a test walks
    every `CARD_SHAPES` entry for room under the Location, inside the card,
    and between two stacked pills — change a shape's `valY` and it tells you.
  - **Card band** `url(#fp-band-<tone>)` (lighter → the chip colour); border
    the chip colour. **Walls** navy `wallOuter` + light `wallInner`; a
    `walls` stub is drawn with the same core (`data-structure="stub-core"`).
  - The legend names the two pill tints, because they carry a meaning.
  - The standard style has none of it (byte-identical render).
  To restyle again: make concept IMAGES first by repainting a dumped SVG
  (parse it, change fills / strokes, screenshot) and let the operator pick —
  it took one question. Tests pin what each colour MEANS, not its hex.
- **Layers, not per-room groups.** The room `<g>` keeps only its fill (and its
  click / aria); walls, empty-room names, cards and doors are drawn in passes
  over ALL rooms from one `geoms` map, so a neighbour's floor can never cover
  half of a thick wall drawn before it.
- **The floor IS tinted by status here** (`roomTone`, worst instrument first) —
  a reversal of this file's "status lives on the chips" rule, by the chosen
  design; the card still shows both readings, so nothing is hidden.
- **`placeCard` (room-geometry.ts) places a one-instrument room's card**: the
  largest scale the inscribed rect allows, at the clear position nearest its
  centre, avoiding every door swing on the plan (`swingSquare`) and the columns;
  it steps down in size only when nothing is clear. Several instruments keep the
  tile grid. The standard style shrinks its tile box instead (`avoidDoorSwings`,
  `avoidObstacles`).
- **Two card shapes** (`CARD_SHAPES`): portrait, and a WIDE one for short
  rooms; a one-instrument room keeps whichever prints its Location larger, and a
  long Location wraps to two lines (`splitLabel`). Added for CWH/RDU/018-00,
  whose 44-character Location printed at ~5 units.
- **Two MORE shapes for rooms those two cannot serve — `tall` and `compact`
  (Microbiology, same day).** The three LAF / BSC rooms are ~100 units wide and
  WATER WET ANALYSIS has a door swing in one corner and a column in the other;
  the design cards printed their Locations at 5.7–6.1 units. `tall` is narrow
  with the two readings STACKED (`stack`, `val2Y`); `compact` is the wide card
  with less air (its own `idFont` / `locFont` / `valFont`). **`chooseCard` tries
  them ONLY when `std` / `wide` print the Location under `LEGIBLE_LOC_FONT`
  (9)** — remove that gate and `compact` wins in every mid-size room, which
  changes QC's approved cards (smallest Location there: 9.1). `splitLabel` also
  breaks before a bracket (`LAF-1(Microbiology)` has no space). The QC plan's
  rendered SVG was byte-identical before and after.
- **An empty room's name steps clear of door swings and columns**
  (`placeRoomName`, room-geometry.ts): centred as before unless something is in
  the way, then the nearest clear spot. Microbiology's four change rooms are
  ~97 x 65 units and a swing swept through every name.
- **No alarm halo in this style** — it showed through door gaps; the wash and
  the red card carry the alarm.
- **The side panel's arrow is PLAN north** and says so: the drawing marks no
  true north.
- `cardTone` / `roomTone` / `archSummary` bucket the SERVER's statuses; nothing
  is re-derived. Tests: `floorplan-arch.test.tsx` (65 since the look and the
  L-room card; was 49, mutation-checked: the
  growing mini card and its tier, the legend under a square plan, a name
  wrapped along a narrow room, the
  mini card and its two-line ID, the
  wrapped names, the three-line Location, the
  landscape strip, the line weights, the turned name, the
  style switch, the obstacle test, the legibility gate, the bracket break, the
  stacked readings, the name placement, the outlined plant, the outward
  door's frame) and `floorplan-polygon-render.test.ts` (18; the outward leaf
  and its arc).
- **A LANDSCAPE plan's legend is a STRIP under it (same day, operator: "width
  is small,rooms and text are slightly no space and look is not good").** A
  plan wider than `LANDSCAPE_RATIO` (1.5) times its height is sized by the
  panel's WIDTH, and the 224px side panel cost it a fifth of that; `ArchSidePanel
  strip` lays the same legend, counts and north mark out in a row under the
  drawing. A portrait plan (QC) is sized by height and keeps the side panel.
  **Line weights scale with the canvas** (`lineK = min(1, ARCH_REF_CANVAS_W /
  imageWidth)`): the viewBox is always 1000 units wide, so a fixed 8-unit wall
  is heavier on a wider drawing; QC's canvas (1069) is the reference and gets
  exactly 8. **A tall narrow empty room prints its name up its length**
  (`placeRoomName` returns `vertical`; gated on the across-size being under 9,
  which is what keeps QC's corridor name across).
  **SUPERSEDED IN PART the same day: the legend is under every 2D plan that
  is not PORTRAIT** (`LEGEND_UNDER_RATIO` 0.9 replaced `LANDSCAPE_RATIO`;
  operator, on QC 3, which is 1.02 wide to tall: "increase widgth and give
  legend on below the layout"). QC (0.74) keeps the side panel. On a
  near-square plan this is a trade, not a gain: every stored layout has the
  floor panel full width and 880 px tall, so that plan is sized by HEIGHT
  and the strip takes some. Do not "optimise" it back to the side without
  being asked; a taller panel or Full screen is what enlarges the plan.
- **FULL SCREEN lays a 2D plan out to the SCREEN's proportions (same day,
  operator: "microbiology layout in full screen its exactly filt to full
  screen but, QC 3 and QC layouts only there is center of the screen not
  adjusted to full screen").** A plan is always 1000 units wide, so its
  viewBox HEIGHT sets its proportions; `fillHeight(naturalVbH, extentAt,
  box)` returns the height at which the drawn extent has the shape of the
  full-screen box (`fp-full-box`, measured in a layout effect and on window
  resize; a few rounds, because an outward door's swing makes the extent
  depend on the height). Everything downstream already reads `vbH`, so the
  ROOMS re-proportion and cards / names / arcs are placed again inside them
  at their own shapes - **never `preserveAspectRatio="none"`, which would
  squash the type.** Three rules: (1) the PANEL keeps the drawing's
  proportions - the stretch is `fullscreen && arch` only, and the panel
  renders of all three traced floors are byte-identical; (2) **2D style
  only** - the standard style's fixed tiles drop IDs, overflow Locations
  and get door arcs over the readings when a portrait generated plan is
  drawn at 1.9:1 (tried on Stability, withdrawn); (3) no measured box (first
  frame, jsdom) = the drawing's height. `planExtent` clamps only its MARGIN
  to the canvas now: drawn content past the edge (an outward swing in the
  stretched frame) is inside the frame. To see it without the browser, the
  dump harness clicks Full screen with `getBoundingClientRect` stubbed for
  `fp-full-box` and writes `document.body.innerHTML` (the overlay is a
  portal). Tests: `floorplan-arch.test.tsx` (53) and
  `floorplan-polygon-render.test.ts` (20); mutation-checked eight ways.
- **A long room NAME wraps; a very long Location takes three lines (QC 3,
  same day).** `placeRoomName(box, obstacles, name, hasCode)` returns `lines`:
  one line while that is legible (9 units), else turned (tall narrow room),
  else two or three balanced lines (`balanceLines`). **It compares on `fit` —
  the size at which the text stays inside the room — not on the printed size**,
  which has a floor of 7: a name that does not fit prints at 7 and runs across
  its neighbours, and on printed sizes that ties with the wrapped name that
  stays inside (mutation-checked). `splitLabel` gives a card's Location a third
  line only when its halves are still over 1.5 times the wrap length, so every
  two-line card is unchanged; `cardSpec.extra` counts each extra line. The QC
  and Microbiology renders are byte-identical before and after.
- **A room too narrow for the ID gets the `mini` card (QC 3, same day,
  operator: "rooms are very small at top").** QC 3's two LCMS rooms are ~65
  units wide, as drawn; "CWH/RDU/012-00" on one line needs ~80 at a legible
  size and printed under 5 on every shape. `mini` (a fifth `CARD_SHAPES`
  entry, in `SMALL_ROOM_SHAPES`) prints the ID on TWO lines, broken after its
  last slash (`splitCode`), stacked readings, no captions: ID 4.7–4.9 → 8.2–8.5.
  **`chooseCard` now scores a shape by the SMALLER of its Location and its ID
  font (`codeFont`)** — on LCMS ROOM-II the Location printed the same on `tall`
  and `mini`, so the Location alone never chose it. The rooms themselves are
  NOT enlarged: they are the drawing's size, and the card's width is what
  binds, so making the row taller would not help. QC and Microbiology render
  byte-identically (their IDs were never the smaller heading).
- **The `mini` card GROWS with its room, and is the LAST resort (same day,
  operator: "rooms are very small and those data was showing very small",
  "increase widgth").** The rooms WERE then enlarged (QC 3's north row, see
  `qc3-layout.ts`), and the card could not use them: a card is scaled DOWN
  to its room, never up, and `mini` was drawn 60 x 55. It is now drawn at
  the other cards' type sizes (120 x 108; each shape has its own `line`, the
  height an extra Location line adds) and sits in its own tier,
  `NARROW_ROOM_SHAPES`, tried only when `tall` / `compact` still leave a
  heading under 9. LCMS rooms: ID 8.2–8.5 → 13.0, readings → 13.0.
  **Consequence, accepted: Microbiology's three LAF / BSC cards take it too**
  (ID 8.0–8.5 on one line → 13.0–13.6 on two; Location and readings as
  they were). QC is byte-identical. The gate matters both ways — always
  trying `mini` takes over rooms `tall` serves legibly; never trying it
  loses the two-line ID (both mutation-checked).
- **A tall narrow room wraps its name ALONG the room (same day).** The
  glass-ware rooms beside the widened LCMS rooms are 45 units across and
  100 along with thirty-character names. `placeRoomName` now tries two or
  three lines turned (they run up the room side by side; the renderer's
  rotated group already stacks `lines`), takes that only when it fits a
  third larger than the best across AND is clear of what stands in the
  room (`placeNameAcross` returns `clear`: false when it had to stay
  centred over an obstacle), and never prefers a wrap that runs through an
  obstacle to one that does not. One turned line is refused when it does
  not FIT (`MIN_NAME_FONT`) — with the across name crushed by an obstacle
  it used to look a third larger and ran out of the room.
- **A card in an L-shaped room goes in the arm that holds it best (Module-E,
  same day).** `chooseCard(inner, obstacles, location, code, others?)`:
  `inner` is `largestInscribedRect(outline)`; `others` (lazy) is
  `inscribedRects(outline).slice(1, 6)` — every other MAXIMAL rectangle
  inside the room, new in `@digilog/shared`. They are tried, tier by tier
  like the first, ONLY when the largest leaves the smaller heading under 9.
  Module-E's API DISPENSING: its tall bay is 2 % larger than the room
  proper, and the card sat in the bay with the Location at 4.9 units; 8.5
  now. The gate is what keeps every other floor's cards where they are
  (byte-identical; mutation-checked both ways).
- **A building of several FLOORS, and only the selected location's layouts
  (Module-F, same day, operator: "give option in Module F like Ground Floor
  and First floor"; "only that area layout should be displayed other areas
  should not displayed").** `plansForSelection(plans, placedRoomIds,
  scoped)`: with a location selected only the plans holding one of its
  instruments are offered (the rows are the server's scope; this is a
  lookup) — a selection on no plan renders `fp-no-layout`, and NOT while the
  rows are loading. `planEntries(plans)`: plans sharing
  `annotations.floor.group` are ONE entry, at the first's place, floors by
  `order` (the server lists "First" before "Ground"); the title bar names
  the entry and shows a `fp-floor-switch` (aria-pressed) when it has several
  floors; the other entries are the buttons beside, a building opening on
  its lowest floor. Full screen: the plan's own name, no switch. `northMark(
  annotations.north)`: the compass turns and reads "North"; absent = "Plan
  north" as before. **Cards**: `chooseCardOverPlant` draws a card OVER the
  outlined plant only when clear of it is under `LEGIBLE_LOC_FONT` — so the
  plant layer (`fp-plant`) now sits between the walls and the cards, not
  last; `chooseCard` lets `mini` win a tie on the smaller heading when its
  two-line ID is a quarter larger; `CARD_SHAPES[*].three` (1.5; `mini` 1)
  is how far a two-line half may run over the wrap before `splitLabel`
  takes three lines. The four older 2D floors and Stability are
  byte-identical in panel and full screen. Layout Designer: **Delete plan**
  (confirm with room / link / unplaced-instrument counts; `DELETE
  /api/floorplans/:id` through `run('UPDATE_FLOORPLAN')`; next plan
  selected). Tests: `floorplan-floors.test.tsx` (19, four mutations caught),
  `designer-page.test.tsx` 6 → 8; one baseline in `floorplan-arch.test.tsx`
  re-pointed (the mini three-line wrap raised the L-room's bay card from 4.9
  to 6.4, still illegible).
- **Judge a floor at a PANEL's size, not at 2000px.** The first Microbiology
  renders were checked at ~2000px wide and looked roomy; in the dashboard the
  drawing was 1000px wide. Dump the mounted view's `container.innerHTML`, load
  it with the BUILT stylesheet (`dist/assets/*.css`, after `vite build`) inside
  a 1240 x 760 box, and screenshot that.
- **A door may swing OUT (`swing: 'out'` on `RoomDoor`, same day).**
  `polygonDoorPlacements` flips the leaf to the far side of the wall and turns
  the arc the other way; the plan's frame (`planExtent`'s `extra`) takes the
  outward leaf in, or it is cut off. For an EXTERIOR door only (Microbiology's
  emergency exit) — an interior door is stored on the room it swings into.
- **The 2D style outlines fixed plant** (`annotations.equipment`, with
  `labels` as captions): thin opaque boxes drawn in the structure layer, so a
  wall an autoclave stands in stops at it; they are obstacles for cards and
  room names. The standard style still draws none of it (the 2026-09-22 "other
  symbols remove those" stands there).
- **To SEE a floor without the browser session:** mount the real
  `FloorplanView` in a throwaway vitest file with `useFloorplans` /
  `useTelemetryOverview` mocked to the stored plan, write the SVG's `outerHTML`
  to a file, and screenshot it with headless Chrome. **Then lay it OVER the
  drawing, half transparent, at the same scale** (drawing px → viewBox units
  through the plan's canvas) — the first Microbiology floor was checked side by
  side only, looked right, and had four wall / door mismatches the overlay
  showed at once. `Layouts/CWH/concepts/applied-*.png` are the results.

## The QC floor plan is TRACED, and carries an annotation layer (2026-08-31)

> **SUPERSEDED IN PART, 2026-09-22 (operator: "other symbols remove those
> border line should auto adjust"):** the dashboard NO LONGER DRAWS the
> annotation layer or its legend, and `planExtent()` fits the viewBox to the
> ROOMS only, ignoring slivers under `SLIVER` (1.5 %) in either axis. The
> `meta.fill` / `fch` / `dims` and annotation DATA below is still stored and
> served; the drawing rules for them are history as far as the dashboard is
> concerned.

Every other plan is generated by `apps/api/scripts/draw-cwh-floorplan.ts`. The
`CWH — QC` plan is transcribed from a real drawing — **`Layouts/CWH/QC
Layout.png`, since the 2026-09-21 re-trace; the `QC Layout.png` at the repo
root is a MOCKUP made from it and was the (wrong) source until then** — and that
made `floorplan-view.tsx` render three things it never had to before. The plan
is now PORTRAIT (578x786), so a traced room is shorter on a wide screen than it
was; `captionHeader()` below decides whether its four caption lines fit.

- **Adjoining CIRCULATION rooms draw as ONE space (2026-09-21, operator: "in
  layout image corridor single line, not divided into separately").** A room is
  one rectangle, so an L-shaped corridor is stored as three; `sharedOpenings()`
  in `room-geometry.ts` returns the stretches where two such rooms' walls
  coincide and the view passes them to `wallSegments` beside the doors, so the
  seam is an ABSENCE of wall — no leaf, no arc. Only the rooms actually drawn
  are neighbours (a scoped view must not open a wall onto nothing). A
  continuation piece — `continuationBase(code)` non-null and its base on the
  plan — prints no code and no name. **`sameSpace(a, b)` is the ONE rule** for
  which pair joins: both CIRCULATION, or pieces of one code whatever the grade
  (`INCUBATOR-01` + `INCUBATOR-01 (2)` on the Microbiology floor, an L-shaped
  lab). So a service band that touches a corridor must not be CIRCULATION
  (QC's `SHAFT-E` is UTILITY for exactly this reason). Pinned in
  `room-geometry.test.ts` and `floorplan-continuation.test.ts`;
  mutation-checked. QC 3 and Microbiology are traced too since 2026-09-21
  (`qc3-layout.ts`, `microbiology-layout.ts`); Microbiology carries
  annotations (a legend), QC 3 stores NULL and draws none. (Since 2026-10-01
  Microbiology is a POLYGON trace in the 2D style: INCUBATOR ROOM-01 is one
  L-shaped room and there is no `INCUBATOR-01 (2)` piece any more; QC 3 still
  has two continuation pieces, `CWH-I/187 (2)` and `CWH-I/235 (2)`.)

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
tone maps and one component per cell, imported by this page, by the trend page's
`routes/instruments/alarms-widget.tsx`, and by the dashboard's
`routes/dashboard/selection-alarms.tsx`. Until then those were hand-written
tables, and the copies had drifted exactly as copies do: the trend widget keyed
its status pill off `severity`, the defect this page had fixed one day earlier.
`AlarmStatusCell` is the single reason that is now structurally impossible on any
of the three.

It is **presentation only** — no fetch, no filter, no sort state, no acknowledge
mutation. A configurable `<AlarmTable columns={...}>` would have meant reshaping
three data flows that are correct. **Do not move the query wiring into it.**

**All THREE now filter, count and page SERVER-side (2026-09-01).** They did not
until then: this page did, while the trend widget fetched `limit=500` and windowed
the period with an `Array.filter` in the browser, and the dashboard panel fetched a
flat `limit=25` and showed whatever came back. Both are the shape this page was
rebuilt on 2026-08-31 to remove — **a `limit` and a range meeting in one query** —
and both were invisible: the widget's own comment claimed its filtering was
server-side, and the panel had no count on screen to contradict its cap. Each
counts the server's `total`; **`rows.length` is one page** and a count taken from
it describes the page while reading as the period or the selection.

Moving the trend widget's window to `from`/`to` was a PREREQUISITE for paging it,
not a tidy-up: a server paging 500-row blocks under a browser thinning each one
yields page numbers and row counts describing different populations.

Each caller still shows a different subset and each subset has a reason:

- **This page: THIRTEEN** (Area added 2026-09-01), with the action column
  `sticky right-0`. `COLUMNS` in `index.tsx` must move with it — every
  whole-width message row spans it, and a colSpan one short leaves a hairline of
  unpainted table. A test derives the expected value from the rendered header
  count, so the constant cannot drift from the `<thead>`.
- **The trend widget: ten.** Instrument ID and Location are redundant for a
  single-instrument view named in the page header, so its state marker rides on
  the TYPE cell instead. Not sticky — ten columns at full width do not overflow.
- **The dashboard's selection panel: ELEVEN** (nine from 2026-09-01 until
  2026-09-25). It KEEPS Instrument ID and Location — it spans every instrument
  in the drill-down. Cleared and Cleared Value came back on 2026-09-25 when
  its query WIDENED from `state=ACTIVE` to every state (operator: "cleared
  value and cleared time was not there in widget"); Duration and Area are
  still omitted. The panel is titled "Alarms in this selection" now (the
  `dashboard_alarms` KEY is unchanged).

**The shared cells have a SIZE MODE (2026-09-25, operator: "active alarms in
this selection alarm widget make that also proper colorful and table format
and fonts size increase and bold").** `AlarmTableSizeProvider size="lg"`
around the dashboard panel's table: every cell steps its type up one size
and one weight and the reading sits in the readings table's `.tv-chip`. The
panel's table is `.alarm-grid` (`app.css`: a line around every cell, a
zebra) with the readings table's `.tv-h-*` column-header hues, so the two
dashboard tables read as one family (a tone wash over each row lasted an
hour — "colorin was not good"). The Alarms page and the trend widget pass
nothing and are unchanged — one set of cells, two sizes; do not fork a cell
to size it. Pinned in `selection-alarms.test.tsx`.

**The two WIDGETS also share one filter toolbar** — `alarm-widget-filters.tsx`,
search + type + status (operator, 2026-09-01). Extracted, not copied, for the same
reason `alarm-table.tsx` was: the trend widget's hand-written copy of the table
was the one that drifted. **It is not `alarm-filters.tsx`** — that is the Alarms
PAGE's bar, with a date range, a location tree and an advanced disclosure, which
is a page-sized control set. The Alarms page keeps it.

- **Both widgets offer all FOUR statuses** (the component's default). The
  selection panel passed `ACTIVE_QUADRANTS` — two options — while its query was
  pinned to `state=ACTIVE` (2026-09-01 to 2026-09-25), because `quadrantWhere`
  emits `state: 'CLEARED'` for the other two and ANDed they matched nothing:
  two controls that can only empty the table read as a filter that found
  nothing rather than one that could not. The query spans every state now, so
  the decoy rule no longer bites. `ACTIVE_QUADRANTS` was kept exported "for
  any future ACTIVE-only surface" until 2026-10-05 and then DELETED as dead
  code (audit WEB-9); the rule is written on the component instead.
- **`searchName` is required and distinct per surface.** An unnamed text input
  beside a password field is what Chrome reaches for when it hunts for a username
  to fill — it typed the logged-in username into the Alarms search box on
  2026-08-31, which looked like a bug in the search box and was not.
- The export icon and the settings pencil ride in the toolbar's `trailing` slot:
  they belong to the trend page, not to the toolbar.

All three use the canonical `<Pagination>` at the administered `defaultLimit`, not
a second hardcoded page size that would drift from the Alarms page. **The two
widgets render no pager at all when `total` is 0** — "Showing 0–0 of 0" beneath a
"No active alarms" line is two ways of saying nothing, one of them noisier — and
both reset to page 1 when what they are filtering on changes, because page 3 of the
previous selection is usually past the end of the next one. On the dashboard the
Rows selector also resizes the panel, since panel height follows content.

**Two of the three now acknowledge, and both got the WHOLE flow.** The button
needs four things — the `alarms.acknowledge` gate, `AcknowledgeDialog`,
`postWithReauth`, and a revalidation of that surface's own SWR key. Both the
trend widget and the selection panel shipped WITHOUT it first, correctly, because
they had none of the four: a button that renders but cannot complete a §11
signature invites an operator to try and fail. **If you strip one of the four,
strip the button in the same pass.** Each revalidates only its own key; do not
reach for another surface's URL.

**Only THIS page's action column is sticky, and the column count is not why.**
Nine columns in a resizable `PanelCard` can overflow more easily than twelve at
full width, so on the selection panel that heuristic pointed AT pinning. What
decides against it there is the tint: a sticky cell needs an OPAQUE background or
rows scroll through it, `ALARM_ROW_CLASS` is `hover:bg-slate-50/70` by design,
and that panel's wrapper is deliberately transparent so the operator's chosen
PanelCard colour shows. A white stripe down its right edge would paint over
exactly what that transparency exists to reveal.

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
  **the administered failure word** (`Error` by default, from `useSensorWords().failure` — the one-word `useFailureText()` wrapper went 2026-10-05, audit WEB-9),
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
- **The Location column shows the instrument's own `Location` ATTRIBUTE, falling
  back to the functional location (2026-09-01).** It showed the functional
  location ALONE until then, so a column headed "Location" printed an AREA —
  reported by the operator, and the same word meaning two things on two screens
  they read side by side, since `telemetry-table.tsx`'s Location column already
  printed the attribute. `locationText()` is the one resolver and
  `AlarmLocationCell` its only caller, so **the two surfaces that HAVE a Location
  column — this page and the dashboard's selection panel — changed from one
  edit.** The trend page's alarms widget renders no Location cell at all (ten
  columns; instrument identity is redundant on a page named for one instrument),
  so it is untouched. Counting the shared-cell consumers rather than the cell's
  actual call sites is how "three" gets written down; `grep -c AlarmLocationCell`
  is the check.
  - **Whether the Area is a FALLBACK depends on whether an Area column is shown,
    and `AlarmLocationCell` takes `areaShown` to say so.** With one placement
    column — the dashboard's selection panel — the Area is the only remaining fact
    and beats "Not set". With an Area column beside it — this page since
    2026-09-01 — the same fallback prints the Area TWICE on every instrument with
    no typed Location, which is the duplicate-column defect the dashboard's Room
    column was removed for. **Pass `areaShown` wherever `AlarmAreaCell` is on the
    row.** One flag, because the two surfaces genuinely differ; a single
    unconditional rule is wrong on one of them. Mutation-checked — dropping it
    fails with "Found multiple elements with the text: …".
  - **Both of the things this cell can display are SEARCHABLE**, and the server
    matches both (`list-query.ts`). Adding the attribute to the column without
    adding it to the search made it visible-but-unsearchable for as long as it took
    to notice — the exact failure this repo already wrote down for the dashboard
    table. Check the search clause whenever a column's SOURCE changes, not only
    when a column is added.
  - The key match is case-INSENSITIVE and the pick is ORDERED (`orderBy: key`):
    this installation's attribute keys have drifted, so an instrument carrying both
    `Location` and `location` is a case that arises, and an unordered `take: 1`
    would show an arbitrary one of the two and could flip between requests.
  - The drawn room was removed 2026-08-31: it is geometry, not a grouping, and
    every `floorplan_rooms.code` in this installation is its instrument's own code
    with `label` blank, so the line repeated the Instrument ID column. `roomLabel`
    went from the API response with it.
  - **The signed trend PDF still prints the ROOM under a heading that says
    "Location"** (`trend-report.ts`, fed from `overview.room`). Untouched here: it
    is a separate path that consumes neither `locationText()` nor `AlarmRow`. If
    it is ever addressed, RELABELLING the row `Room` is the smaller and more honest
    change — it does not alter what a signed record asserts.
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

## Trend page widget labels are administered (2026-09-01)

Every title, subtitle and column heading on `/instruments/:id/trend` comes from
`system_config['trend-widgets']` through `hooks/use-trend-widgets.ts`, and each
widget can override its DATE/TIME FORMAT. `routes/instruments/widget-settings-button.tsx`
is the pencil in each widget's header.

- **No component defaults a label.** The only fallback is
  `TREND_WIDGET_LABEL_DEFAULT` in `@digilog/shared`, applied by
  `trendWidgetLabel()` server-side and by `coerceTrendWidgetTexts()` in the hook.
  A `?? 'Status'` anywhere in a widget is a second, drifting definition — the same
  rule as `RS485_FAILURE_TEXT_DEFAULT` and the alarm type names.
- **The widgets stay presentational.** They take their wording as props and take
  the pencil as a `settingsButton` ReactNode; the role check and the config write
  live in one component, not five. `BandGauge`, `TrendChartCard`,
  `TimeseriesTableCard` and `AlarmsWidget` all follow this.
- **The pencil is `user?.role === 'SUPER_ADMIN'`**, the same check
  `routes/config/index.tsx` makes — NOT `useCan`, because the gate is the def's
  own `requiredRole`, and two checks for one rule drift. Hiding it is
  presentation; the server's 403 is the control and is tested separately.
- **`useDatetimeFormat(override)` — there is still ONE formatter.**
  `makeDatetimeFormatters(config, override)` is the pure core, extracted so the
  inheritance rule can be unit-tested rather than inferred from a rendered date.
  Each field falls through independently; **the TIMEZONE is not overridable**, and
  the type has no field for one. `TimeSeriesChart` gained an optional
  `dateTimeFormat` for its tooltip; every other caller passes nothing.
- **An unrecognised format INHERITS.** `formatDateValue`'s `default:` branch
  prints en-GB, so passing a stale override through would render DD/MM/YYYY on a
  site set to MM/DD/YYYY — the mutation test for this fails with
  `expected '04/03/2026' to be '3/4/2026'`, which is the bug itself.
- **The alarms table's `<UnitLine>` legends and the H/m tooltip are NOT
  renameable** and survive a rename. `Heading` stacks a multi-word heading one
  word per line — `Th` is `whitespace-nowrap`, so an unstacked two-word heading
  is the widest cell in the table and drags its column out with it. A single word
  renders as a bare text node, so the shipped headings are byte-for-byte what
  they were.
- **A save MERGES the whole row.** `/api/config/dynamic/:key` replaces
  `configValue` rather than patching it, so a PUT of one widget's fields erases
  the other five. Pinned and mutation-checked.

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

## UI v3 — one visual language on every screen (Batch 1 landed 2026-09-21)

Spec: `docs/superpowers/specs/2026-09-21-ui-design-system-v3-design.md`; plan
`docs/superpowers/plans/2026-09-21-ui-v3-batch-1-foundation-shell-auth.md`.
Operator: "update all the screens ui more professionally"; chose a new design
system in the language of their mockups (`Alarms.png`, `screen-2.png`,
`cc-dashboard.png`).

- **Tokens** (in `@theme`): `--text-figure`, `--text-figure-lg`,
  `--surface-tint-1/2`, `--band-gradient` — every one derived from the
  `--theme-*` variables, so all ten presets work. **The band's ends are the
  preset's gradient mixed 78% with black, not the raw colours**: body-size
  white text on the raw band failed WCAG AA on five of ten presets.
  `npm run check:contrast` (`scripts/contrast-check.mjs`) holds the same
  0.78 and proves white-on-band and ink-on-tint for every preset — keep the
  two numbers in step.
- **SINCE 2026-10-01 `grid` and `size="lg"` are the DEFAULTS** — every table
  in the app is the Audit Trail's (operator). Hand-built tables carry
  `.tbl-grid` themselves. The zebra / hover are on the `<tr>`, not the `<td>`:
  a cell background hid every row tint (selected, pending). Do not move them
  back onto the cell.
- **`Table grid` / `size="lg"` (2026-09-25)**: `grid` puts `.tbl-grid`
  (`app.css` — a line around every cell, a zebra; the same rules as the
  dashboard alarms panel's `.alarm-grid`) on the table, `size="lg"` is 15px
  base type. The Audit Trail uses both (operator: "table format … table
  lines shoud be visibl"); every other caller passes nothing and is
  unchanged.
- **Primitives** in `components/ui/`: `PageHero` (the band every screen
  starts with; the screen's toolbar goes INSIDE it as `children`), `StatCard`
  (ONE figure; no sparkline — nothing stores that history), the rebuilt
  `Table` (`TableHeader band`, `TableGroupRow`, `TableHead sortable` with
  `aria-sort`, `TableRow accent`, `TableEmpty`, `TableFooter` — the eight
  existing callers render with the new band and nothing else), `FormSection`
  (gradient plate, field grid, no description), `DialogBanner` (moved here;
  `tone="danger"` for a destructive act; the functional-locations file
  re-exports it), `Toolbar` (search with a distinct `name`, filters, trailing).
- **Shell**: the sidebar's active item is a white pill with theme ink and a
  right-hand dot (`data-active`). **Auth**: `routes/auth/auth-shell.tsx`
  frames login, forgot-password, change-password and contact-admin;
  `__tests__/auth-pages-render.test.tsx` mounts all four — the first tests
  those pages have had.
- **Test gotcha**: `\bbg-white\b` also matches `hover:bg-white/10` (`/` is a
  word boundary); assert a class token with `(^|\s)bg-white(\s|$)`. And jsdom
  has no `matchMedia` — the sidebar test stubs it.
- **`PageHero` does NOT clip its content, and its toolbar is `relative z-10`
  with no backdrop filter (2026-10-03, operator: "instrument selection
  dropdown was not showing values properly in dropdown").** The root's
  `overflow-hidden` (for the two circles) clipped every popup opened from a
  toolbar inside the band — the Settings picker's list, the Export menu on
  Alarms and Audit — to the band's bottom padding; the circles are now
  clipped by their own `page-hero-decoration` wrapper. And the toolbar's
  `backdrop-blur-sm` was a stacking context that trapped a popup's `z-50`
  under the next card on the page. Both pinned in `page-hero.test.tsx` as
  class tokens; the picture was checked in headless Chrome with the built
  stylesheet, which is how both were found — one at a time, the second only
  visible once the first was fixed.
- **`cn()` is tailwind-merge, and an UNTYPED arbitrary `bg-[…]` is read as
  a background COLOUR** (2026-10-03). `Select`'s chevron position
  `bg-[right_0.6rem_center]` made it drop the `bg-white` before it, so every
  native Select in the app was transparent — invisible on white cards, dark
  on the hero band. Write `bg-[position:…]` / `bg-[length:…]` (hinted), and
  when a primitive's class looks absent on screen, read the MERGED class
  string off the DOM before reading the source. `select.test.tsx` reads it.
- Batches 2–4 rebuild the screens on these; see the spec §4. Status colours,
  PDFs, fetch keys and gates are untouched throughout.

**Batch 2 landed the same day — the monitoring screens.** Alarms
(`PageHero` with the export icon as its action; the four stat cards re-skinned
on the `--status-*` tokens with a top rail, still filter buttons; the alarm
table banner is `--band-gradient`, its sticky action cell the band's END
colour), Instruments list (`PageHero`, `Toolbar` with a named search, the
shared `Table` — its first render test, `list-page.test.tsx`), Instrument
detail (`PageHero` headed by the code; the chips are its `meta`), Instrument
trend (`PageHero` replaced `trend-header.tsx`, which is DELETED; the crumbs
ride in the band and the strip's own "Back to instrument" link went — the
crumb's instrument link is that hop), Data Report, Settings (the picker rides
INSIDE the band as `children`; the widget's own band is `--band-gradient`),
Functional Locations index and detail (their private hero markup, `Figure`
and `Stat` went; `PageHero testId` keeps `fl-hero` / `fl-detail-hero`, and
`HeroTile.testId` keeps `fl-figure-*` / `fl-stat-*`). **Two deliberate
exceptions:** the DASHBOARD is untouched — its hero and title were removed at
the operator's instruction on 2026-08-29 and its readings table already
carries the coloured column groups of `screen-2.png` (its ENTRY CARDS and
ground were coloured on 2026-09-25 at the operator's request — see the
Instrument dashboard section; the table and panels still stand); and `PageHero` gained
`meta`, `testId` and per-tile `testId` for these pages. Three banner
assertions (`alarms-page`, `alarms-widget`, `selection-alarms`) now check
`var(--band-gradient)` / `var(--theme-gradient-to` instead of
`--theme-primary` — the same intent (site theme, no hex), the token that is
actually there.

**Batch 3 landed the same day — people and records.** Users list
(`PageHero` with Password Reset Requests and Create User inside; the four
counts are `StatCard`s in `user-stats-bar.tsx`, same props), Users create /
reset requests (`PageHero`, Back inside it; the reset history on the shared
`Table`), Users edit (`PageHero` headed by the person, initials as the icon,
status / directory badges and username as `meta`), Admin Requests (`PageHero`
with a `Toolbar` search INSIDE it — named `admin-request-search`; the four
filter cards on the status tokens; the table on the shared `Table`),
Notifications (`PageHero`, Mark All as Read inside), Audit Trail (`PageHero`
with the record total as its one tile and the export as its action; the
"21 CFR Part 11 Compliant Activity Log" line went — the sidebar's compliance
line says it), Reports (`PageHero`; the table on the shared band), Profile
(the identity card's cover is `--band-gradient`). **New render tests:**
`users/__tests__/pages-render.test.tsx` (all four Users pages),
`notifications/__tests__/page-render.test.tsx`, `audit/__tests__/page-render.test.tsx`.
**Test gotcha, and it cost two minutes of a hung vitest:** an `swr` mock that
returns a FRESH object per call makes any effect keyed on `data` re-run
forever without throwing. Return module-level constants (see the Users test's
`RESPONSES`). And the real `usePaginationDefaults` returns `options`, not
`pageSizeOptions` — the shared `Pagination` calls `.includes` on it.

**Batch 4 landed the same day — configuration and system — and closes UI v3:
the design system is now on every screen.** Twenty-one pages (the
Configuration index, every page under `routes/config/` incl. the dynamic
config page, Roles & Access and Help, System Health, Debug traces) open with
`PageHero`; the six that held the header beside sibling controls carry them
as `actions`; Help and Roles & Access lost their own emerald / violet
gradients and their back-arrow links (the crumb is that hop). Eight raw
tables (`access-matrix`, `action-reauth`, `alarm-webhooks` ×2,
`export-options`, `help`, `notification-rules`, `notification-logs`,
`debug`) were rewritten onto the shared `Table` by a tokenising transformer
(row and cell attributes preserved; `className` dropped from
table/thead/tbody/th; header rows' grey classes stripped after). **There is
ONE `FormSection` now**: `components/ui/form-section.tsx`;
`form-field.tsx` re-exports it (it accepts and ignores the old
`description`), so the dynamic config page's groups wear the gradient plate
with no page edit. The Configuration index's medallions are the band
gradient — the nineteen per-card gradients (`card.gradient`, still in the
data, unused) went for the reason the old PageHeader comment gave.
`config/__tests__/pages-hero.test.tsx` mounts the index, Password Policy,
Date/Time, System Health and Debug. **Deliberately untouched across all four
batches:** the dashboard (see Batch 2). **The four card-based forms followed
the same day** (operator: "do those four forms also"): Backup (both forms),
Floorplans (the plan editor — its select and Upload button ride in the plate
as `actions` — and the room form), Pagination, and Instrument Attributes (the
key list; its `{kept} keys` count is the plate's action; the profile picker
above it stays a plain `Card`). Each is a labelled `region` now, which is
what `pages-hero.test.tsx` and `instrument-attributes.test.tsx` assert. All
use `columns={1}`: their bodies are stacked controls, not field pairs.

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
## A panel's controls sit in the CARD HEADER, beside the title (2026-09-01)

Operator: *"give titles and filters in same line … dont give in seperate lines,
for all widgets"*. `PanelCard` exports `usePanelToolbarSlot()`; the dashboard's
readings table and selection alarms panel portal their toolbars into it.

- **The split was structural, not a styling slip.** The title belongs to
  `PanelCard` (the operator may rename it, so a panel must not hard-code its own)
  and the controls belong to the content. Two components, therefore two rows — no
  flex on either could have joined them.
- **A portal, not lifted state.** Hoisting filter state into `dashboard/index.tsx`
  would put three panels' state in one component to solve a layout problem. And
  the slot is held as STATE, not a ref: a ref is still null on the first render,
  so the portal would never mount.
- **Every consumer renders its toolbar INLINE when the slot is null.** These
  components are rendered bare in their own tests; one that lost its search box
  when unwrapped would be broken precisely where the tests look.
- **`flex-nowrap` in the header, and it matters.** The readings toolbar dropped
  `flex-wrap`/`justify-between` on the way up: in the header it is one group the
  slot's `ml-auto` pushes right, and a row allowed to wrap there puts the card
  back on two lines. The title truncates first (`min-w-0` on the slot) — a
  truncated heading reads better than a crushed search box.
- Tests assert the join by **DOM containment** (`row.contains(bar)` and NOT
  `body.contains(bar)`). A query that found both on the page would pass with them
  stacked, which is the state being fixed.
- The trend page's cards already had title and controls on one row; they use
  `CardHeader` directly and were not touched.

## Dashboard panel height FOLLOWS THE CONTENT (2026-09-01)

Operator: *"every widget size should be upto pagination only, when user dragged
its showing empty space … if user increased 25 to 50 then widgets should adjust
upto 50 records in one view, if again he made 25 then size should be adjusted
automatically."* So a panel ends at its pagination bar and a page-size change
resizes it with no drag. `routes/dashboard/panel-auto-height.ts` holds the maths.

- **Only `telemetry_table` and `dashboard_alarms` are in `AUTO_HEIGHT_PANELS`.**
  `telemetry_floorplan` is deliberately out (operator's call): a drawn plan has no
  natural height — it SCALES to the box it is given — so "fit the content" is
  undefined for it and a bigger box genuinely shows the rooms bigger. It keeps its
  corner handle and its Height dropdown, and is the one panel here where dragging
  taller does something.
- **OBSERVE THE CONTENT WRAPPER, NEVER THE CARD OR THE SCROLL REGION.** This is
  the whole feature and it fails silently. Both of those have their border box
  pinned by the grid cell, so going 25 → 50 rows grows `scrollHeight` without
  changing either box — and **ResizeObserver does not fire on a `scrollHeight`
  change**. Observe one of them and the panel resizes only when the WINDOW does,
  which is the original complaint with extra steps. A test that resizes the window
  passes either way; `__tests__/panel-card-auto-height.test.tsx` asserts the
  observed element BY IDENTITY and drives a content growth instead.
- **MEASURE the content wrapper's box too — never `scroll.scrollHeight`.** A
  separate mistake from the one above, and it shipped: `scrollHeight` is
  `max(content, clientHeight)`, so a container taller than its content reports its
  OWN height. That makes the measurement ONE-WAY — growing works because overflow
  pushes it past `clientHeight`, shrinking never can, because the value is pinned
  to the height being reduced. Reported by the operator as a panel that grew to 50
  rows and would not come back to 25. Add the scroll region's PADDING explicitly:
  it is operator-configurable and `clientHeight` already counts it, so leaving it
  out clips the last row.
  - **The test stub was what hid it.** It set `offsetHeight`, `clientHeight` and
    `scrollHeight` independently and so described an impossible DOM. `stubLayout()`
    now makes `scrollHeight` a getter over `max(content + padding, clientHeight)`
    and pins the panel height as the grid cell does. **A stub that cannot express
    an invariant cannot catch its violation** — when stubbing layout, encode the
    relationships, not three loose numbers.
- **The height is derived at RENDER and never STORED.** `applyAutoHeights`
  overlays it for display; `keepStoredHeights` strips it back out in
  `onGridChange` before anything reaches the draft. react-grid-layout reports
  whatever height an item currently has, so without that strip every Save would
  write one moment's page size into `role_configs` for every viewer to inherit.
- **`nextRows` is damped, and the obvious version of the damping IS A NO-OP.**
  "Grow when it overflows, shrink when a whole row is free" fires on the same
  pixel in both directions, because `rowsForHeight` is the exact inverse of
  `capacityPx` — the band it holds in is precisely the band that already maps to
  the current row count. Found on 2026-09-01 by mutation testing: deleting the
  entire branch changed nothing and failed no test. Shrinking is therefore made
  STRICTLY harder than growing by `SHRINK_SLACK_PX`. The loop it prevents is real:
  the readings table's Area/Location cells are `line-clamp-2`, so a width change
  re-wraps them and moves the height, and a panel tall enough to summon the PAGE
  scrollbar narrows its own container and re-wraps again.
- **`ROW_HEIGHT` / `MARGIN_Y` are imported by `panel-grid.tsx` from that module**,
  so the geometry the grid DRAWS with and the geometry the maths SOLVES with are
  the same two numbers. `capacityPx` counts `rows - 1` gaps, not `rows`.
- **Auto panels get `resizeHandles: ['e']`** — the right EDGE, width only. The
  library default `['se']` is the corner and drags both axes; on a measured card
  the vertical half would be undone by the next measurement and read as broken.
  Per-item `resizeHandles` overrides `resizeConfig.handles` in 2.x.
- **The Card height dropdown is HIDDEN on an auto panel**, replaced by a line
  saying why. It would set an `h` the next measurement overwrites within a frame —
  an inert control, which this file already has a rule about (the `SlotColumn`
  unused-prop note above). Card width stays.
- **The trend page needed NOTHING.** Its widget cards are not in a grid and carry
  no `max-h`, `h-[…]` or `overflow-y` — verified by grep, not assumed — so they
  already grow with their content.

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
- **`/` lands by RULE (2026-10-05, audit WEB-4):** `routes/dashboard/landing.ts`
  `landingRoute(perms, role)` — the dashboard for SUPER_ADMIN or `DASHBOARD_VIEW`,
  else the first sidebar page the role can see (the sidebar's own
  `isSidebarItemVisible`), else `/profile`. `landing-page.tsx` renders the
  dashboard or a `<Navigate>`; a redirect, never Access Denied, because `/` is
  the first screen after every login. `/users` guards on `USER_READ` alone
  (WEB-5). The Super Admin API-access password boxes are
  `SignaturePasswordInput` (WEB-1); the chart x-axis uses `useDatetimeFormat`
  (WEB-2).
- **Every login lands on `/` (the dashboard) — there is NO return-URL (2026-10-03,
  operator: "after every login user should come to dashboard page only dont
  redirect to other pages").** The layout and the API client's 401 handler send
  an unauthenticated visitor to a bare `/login`; the login page's signed-in
  redirect and `useAuth().login` go to `/` whatever the query string says. The
  `?returnUrl=` that lived here sent the NEXT user on a shared workstation to
  the page the PREVIOUS one left — Access Denied for a role without it. Pinned
  by `routes/auth/__tests__/login-lands-on-dashboard.test.tsx`, whose hook
  case sets `window.location` too (the old code read it, not the router).
- 30-minute JWT refresh cycle
- Session timeout warning dialog
- Single-tab enforcement per user (BroadcastChannel)
- Force login (`force: true`) to terminate existing sessions

## Key Features
- **23** files in `routes/config/` (22 → 23 on 2026-10-24: `attribute-access.tsx`, Configuration → Attribute Edit Access; re-derived `ls apps/web/src/routes/config/*.tsx | wc -l` 2026-10-05: 23 → 22 that day — `alarm-rule-dialog.tsx`, dead since the 2026-08-31 alarm-rules removal, deleted (audit WEB-8); 22 → 23 on 2026-10-01: `report-settings.tsx`, Report Approvers + Report Downloads on one page — this line was not re-synced that day. Earlier 23 → 22 on 2026-09-22: `floorplans.tsx` DELETED, replaced by the `layout-designer/` FOLDER at the same route — `ls *.tsx` counts files; re-derived `ls apps/web/src/routes/config/*.tsx | wc -l`. Earlier, 2026-09-16 — unchanged: the `attribute-labels` def's Display name column lives ON `instrument-attributes.tsx` (a separate `attribute-labels.tsx` existed for a few hours that day and was folded in at the operator's direction). That page now saves THREE things (2026-09-21 added the third: the Settings page's hidden set — a Show in Settings toggle per row and one for the Instrument ID, written on the SAME `attribute-labels` row as `settingsHidden` and merged by `mergeSettingsHidden`, pure, exported; a toggle alone is dirty and never rewrites the profile). Before that, TWO: the profile's keys (only when they changed) and the global display-name map (WHOLE, merged by the exported pure `mergeLabels`, through the generic dynamic PUT because that PUT replaces the row), then revalidates `/api/config/attribute-labels/current` so open panels re-label. Earlier re-derived 2026-09-01; 24 -> 23 on 2026-08-31 with the alarm-rules removal — this line was never re-synced then, and the two inventory lines in root CLAUDE.md carried the same stale 24 until 2026-09-01. `trend-widgets.def.ts`, added that day, adds NO file here: it renders through the dynamic config page. Earlier 25 -> 24 on 2026-08-28: `dashboard-cards.tsx` deleted — panel assignment moved to a Panels tab on `role-access.tsx`, stored on `role_configs`/`user_configs` rather than in `system_config`, and gained a per-USER layer. Config -> Appearance lost its second tab with it.) Earlier: **25** files (re-verified `ls apps/web/src/routes/config/*.tsx | wc -l` 2026-08-27 — `alarm-webhooks.tsx` added 2026-08-27, 24 → 25. It has **no config def of its own**: alarm webhooks are a CRUD module with their own tables, not a `system_config` row, so the def count stays at 25 and this page is not driven by the dynamic config page. Its `/config` card is **SUPER_ADMIN-only** — `index.tsx` reads `const visibleSuperAdminCards = isSuperAdmin ? superAdminCards : []` (the delegation allow-list went 2026-08-19) and the card is in `superAdminCards`, so a non-SUPER_ADMIN NEVER sees it and no Configuration Access grant will surface it; `/config/alarm-webhooks` is still reachable by URL, where `RequireRole permissions={[ALARM_RULE_READ]}` admits them. Same as Alarm Rules, which is in the same array. **This line said "default-deny … until `alarm-webhooks` is granted under Configuration Access" until 2026-08-27; that was FALSE.** Earlier: re-verified `ls` 2026-08-19 — `role-assignments.tsx` removed as dead code, 25 → 24; `alarm-limits.def.ts`, added 2026-08-17 for the instrument-limit alarm work, is an auto-discovered def rendered by the dynamic config page, so it adds no file here. Earlier verified `ls` 2026-08-14; the "34" was inherited from DigiLog and was never true here). Most config surfaces are auto-discovered defs rendered by the dynamic page; `alarm-rules.tsx` (2026-08-14) is a real CRUD page, like `floorplans.tsx`
- Entity tree with drag-and-drop hierarchy
- Cleaning-profile pipeline editor (STAGE / CHECKLIST nodes on a custom canvas)
- Notification system (email/SMS/Telegram/Slack)
- Debug trace page for pipeline visibility
- **Home / Module Guide — REMOVED 2026-09-19** (operator: "remove home feature
  from side bar from entire application"). `/home`, `routes/home/` (FlowChart,
  module-flows, viewer-access, types, tests), the `home` entry in `SIDEBAR_ITEMS`
  and `allNavItems`, and its only data source `GET /api/roles/access-matrix` are
  gone. It had been the ONE sidebar item with no `PERMISSION_TREE` group;
  `sidebar-visibility.test.ts` now locks that every item has one. Every page's
  root breadcrumb reads `Dashboard` (it always pointed at `/`). History:
  `CHANGELOG.md` 2026-07-06 / 2026-07-13 entries and
  `docs/superpowers/specs/2026-07-06-home-module-guide-design.md`.

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
