# Dashboard Builder Phase 2 — the widget library (ECharts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nine new widget types — gauge, bar chart over time, comparison bars, pie, alarm counts, status grid, instrument list, text card, floor plan — available on the home dashboard `/` and on every built dashboard, with the four chart shapes drawn by ECharts.

**Architecture:** One per-type registry in `@digilog/shared` decides what each widget type takes (keys, window, options, the panel that gates it on `/`). The strict and forgiving readers, the Add widget dialog and the renderers all read it. Two new server routes feed the new widgets: `GET /api/instruments/telemetry-buckets` and `GET /api/alarms/counts`. The overview row gains two server-decided fields, `judged` and `lastSeenAt`. ECharts is lazy-loaded, so the main bundle does not carry it.

**Tech Stack:** zod (shared), Fastify 5 + Prisma raw SQL on the partitioned `instrument_telemetry_history` (API), React 19 + SWR + Tailwind v4 + **ECharts 6.1.0** (web).

**Spec:** `docs/superpowers/specs/2026-10-29-dashboard-builder-design.md` — §7 "Phase 2", including the 2026-10-30 operator decision (ECharts) and the phase 2 rulings recorded there. Phase 1's plan (`2026-10-29-dashboard-builder-phase1.md`) and its rulings R1–R12 still bind.

## Global Constraints

- **Everything phase 1 bound still binds:**
  - only a SUPER_ADMIN builds;
  - a dashboard grants nothing;
  - every value comes from a server route under the viewer's own permissions and scope;
  - two document readers (strict on write, forgiving on read), never swapped;
  - R9 (no drag below lg) and R10 (`expectedUpdatedAt` captured when editing began).
- **No stored layout or document may parse differently after this ships.**
  - Every new option is OPTIONAL.
  - `WIDGET_TYPES` is APPENDED to, never reordered.
  - A real stored home layout with a `{mode:'selection'}` widget must parse identically (pinned by a test in Task 1).
- **A raw key is never green and never "In limit".**
  - Every ECharts option is built with the app's colours passed explicitly: the series palette (`SERIES_COLORS` in `routes/dashboard/time-series-chart.tsx`) and a status hex map that matches `routes/dashboard/status.ts`. Never ECharts' default palette or theme.
  - Only a MEASURED key on a gauge takes a verdict colour, from `quantityVerdict`, exactly as `keyCell` does.
  - Bars and pies of categories take series colours.
- **No verdict is computed in the browser** beyond the existing `quantityVerdict` (the band gauge's one rule).
  - Instrument status, `reporting`, `judged`, limits and units are the server's.
  - The status widgets map the server's fields to a word through ONE function (Task 4), never per widget.
- **ECharts:**
  - `"echarts": "6.1.0"` exactly (no caret) in `apps/web/package.json`.
  - Import only through `echarts/core` with the chart and component modules registered once.
  - Use the SVG renderer: crisp text, and no canvas, so jsdom loads it.
  - `animation: false`.
  - It lives ONLY in a lazily imported module. No file imported by `main.tsx`, `widget-panel.tsx` or `routes/dashboard/index.tsx` may import `echarts` statically.
  - After `npx vite build`:
    - the echarts code must be in its own chunk, not the main `index-*.js`;
    - that chunk's file name must appear in `dist/sw.js`'s precache list. Workbox silently skips files over 2 MiB, and the install runs offline.
  - The React wrapper:
    - `init` on mount;
    - `setOption(option, { notMerge: true })` on change;
    - `resize()` from a `ResizeObserver`;
    - `dispose()` on unmount. Dashboards stay open all day, so a leaked instance or observer is a defect.
- **Every decision a chart makes is a pure `build…Option` / `…Model` function**, unit-tested. Widget component tests mock the lazy chart module and assert the props it was given.
- **History vs present (spec G4):**
  - `bar_chart` follows the dashboard window like the trend chart (its `options.period` absent = follow).
  - Every other new type takes no window and no period.
- **Gates on `/` (a built widget never widens Panels):**
  - `alarm_table`, `alarm_counts` and a `pie_chart` with `of: 'alarm_types'` need `dashboard_alarms`;
  - `floorplan` needs `telemetry_floorplan`;
  - the server's `resolveLayout` decides, reading the registry.
  - On a built dashboard, assignment is the only gate (unchanged).
- **Derived values are labelled as derived** (the `telemetry-aggregate.ts` rule).
  - A bar says what it is computed from on the widget's face: "Hourly average", "Daily maximum", "Weekly reading count".
  - Its tooltip gives the reading count behind the bar.
- **Bucket edges are local.**
  - `telemetry-buckets` bins in the `datetime` config's `timezone` (default `Asia/Kolkata`).
  - Day buckets start at local midnight; week buckets start on a local Monday.
  - It returns UTC ISO instants for each bucket start.
- **Fastify strips undeclared response fields.** Declare every field and inner key on both new routes and on the overview's two new fields.
- **No migration, no new model, enum, permission, re-auth action, audit action, config def, sidebar item or `<Route`.**
  - Shared type files stay 38: the registry lives in `dashboard-widgets.ts`.
  - API modules stay 25.
  - The new API routes are 2 (`telemetry-buckets`, `alarms/counts`).
  - There is one new web dependency (`echarts`).
- **Tests:** as phase 1.
  - Shared: `cd packages/shared && npx vitest run <file>`, then `npm run build -w @digilog/shared`.
  - API: one file at a time, `cd apps/api && npx vitest run <file> --pool=forks --poolOptions.forks.singleFork=true`, judged by EXIT CODE. Each e2e file owns its super admin, roles, profile and instruments, and restores anything it changed in `system_config` first in `afterAll`.
  - Web: ONE file per process, `cd apps/web && npx vitest run <file>`, judged by exit code. SWR mocks return module-level constants.
- **Look:**
  - The dashboard's `PanelCard` and the shipped widget look: the UI v3 table band, the `keyCell` colours, Inter numerals.
  - Light theme. `useDatetimeFormat()` for every instant.
  - Every text input gets a distinct `name`.
  - Each new widget is rendered with the BUILT stylesheet at a dashboard panel's size (1240 × 880 window, the panel at its default `w`/`h`) and looked at before its task is called done. The operator's rule is premium on the first cut.
  - Check the longest label in the smallest panel.

## Review Focus

1. **A pressure-only project instrument that is reporting.** Today the server says `NO_DATA`. On the status grid, instrument list and status pie it must read "Not judged" (neutral) while reporting and "Offline" when not — never "No data", never green. Owned by Task 2 (server `judged`) and Task 4 (the one mapping), tested in Task 7.
2. **A reading at 23:00 UTC on an Asia/Kolkata install** lands in the NEXT local day's bar, and an hourly bucket edge falls on the local hour, not :30. Task 3 pins both.
3. **The home dashboard after deploy.** Every stored `w:` widget on `/` renders exactly as before. An `alarm_counts` widget placed on `/` for a role without `dashboard_alarms` is not drawn. Tasks 1 and 4.
4. **A viewer without `ALARM_READ`, assigned a dashboard with alarm widgets**, sees "Could not load this widget." on those cards, and the rest of the dashboard draws. Tasks 2 and 7.
5. **A gauge on a raw key with no min/max set** draws the value and a neutral full ring, never a coloured band. A gauge on a measured key whose bounds are both absent reads "Not assessed" in neutral, exactly as `keyCell` does. Task 5.

---

### Task 1: Shared — the widget-type registry and the nine new types

**Files:**
- Modify: `packages/shared/src/types/dashboard-widgets.ts`, `packages/shared/src/types/dashboard-layout.ts`
- Test: `packages/shared/src/types/dashboard-widgets.test.ts` (extend), `packages/shared/src/types/dashboard-layout.test.ts` (extend)

**Interfaces:**
- Produces:
  - `WIDGET_TYPES`: the existing five, then appended `'gauge', 'bar_chart', 'comparison_bar', 'pie_chart', 'alarm_counts', 'status_grid', 'instrument_list', 'text_card', 'floorplan'`.
  - `WIDGET_TYPE_SPECS: Record<WidgetType, WidgetTypeSpec>` where
    ```ts
    interface WidgetTypeSpec {
      keys: 'none' | 'any' | 'telemetry';  // what keys it takes; 'none' = keys must be []
      keysMax: number;                     // ≤ WIDGET_KEYS_MAX
      followsWindow: boolean;              // takes options.period / the dashboard window
      options: readonly WidgetOptionName[];// the ONLY options it may carry
      panel: PanelKey | ((w: CustomWidget) => PanelKey | null) | null; // extra panel it needs on `/`
    }
    ```
  - The existing five, re-expressed with their behaviour unchanged:
    - `value_cards` / `latest_table`: keys `any`, `WIDGET_KEYS_MAX`;
    - `trend_chart` / `timeseries_table`: keys `telemetry`; `followsWindow`; options `['period']` (+ `pageSize` for the table);
    - `alarm_table`: keys `none`; options `['pageSize','status']`; panel `dashboard_alarms`.
  - New option fields on `customWidgetSchema.options`, all optional:
    - `min`, `max`: finite numbers (gauge); both or neither, and `min < max`;
    - `bucket`: `'hour' | 'day' | 'week'` (bar);
    - `agg`: `'avg' | 'min' | 'max' | 'count'` (bar);
    - `groupBy`: `'all' | 'instrument'` (bar);
    - `of`: `'status' | 'alarm_types'` (pie, required for a pie);
    - `text`: string, trimmed, 1..2000 (text card, required);
    - `planId`: uuid (floorplan, required).
  - New types:
    - `gauge`: keys `any`, max 6;
    - `bar_chart`: keys `telemetry`, max 6, `followsWindow`, options `['period','bucket','agg','groupBy']`;
    - `comparison_bar`: keys `any`, max 6;
    - `pie_chart`: keys `none`, options `['of']`, panel = `dashboard_alarms` when `of === 'alarm_types'` else null;
    - `alarm_counts`: keys `none`, panel `dashboard_alarms`;
    - `status_grid`: keys `none`;
    - `instrument_list`: keys `none`, options `['pageSize']`;
    - `text_card`: keys `none`, options `['text']`;
    - `floorplan`: keys `none`, options `['planId']`, panel `telemetry_floorplan`.
  - Caps: `GAUGES_SHOWN_MAX = 24`, `BAR_SERIES_MAX = TREND_SERIES_MAX` (6), `TEXT_CARD_MAX = 2000`. Exported and named, never inlined.
  - `widgetPanelGate(w: CustomWidget): PanelKey | null`. `dashboard-layout.ts`'s `alarm_table`-only filter (`:354`) becomes "drop a widget whose `widgetPanelGate` names a panel the viewer lacks".

- [ ] **Step 1: Failing tests** in `dashboard-widgets.test.ts`:
  - each new type parses with a minimal valid body;
  - each refuses an option outside its spec's `options` (e.g. `bucket` on a gauge), keys on a `none` type, an attribute key on `bar_chart`, more keys than its `keysMax`, `min` without `max`, `min >= max`, a pie without `of`, a text card with an empty or 2001-char `text`, a floorplan without `planId`;
  - the five old types accept and refuse exactly what they did before. Keep every existing case and add none that changes them.
- [ ] **Step 2: Failing tests** in `dashboard-layout.test.ts`:
  - a stored home layout fixture with a `{mode:'selection'}` `value_cards` and a `trend_chart` widget resolves identically (deep equal) before and after;
  - `alarm_counts` and `pie_chart{of:'alarm_types'}` are dropped without `dashboard_alarms` and kept with it;
  - `pie_chart{of:'status'}` is kept without it;
  - `floorplan` is dropped without `telemetry_floorplan`.
- [ ] **Step 3:** Run both files; expect FAIL.
- [ ] **Step 4: Implement.**
  - `superRefine` becomes a lookup into `WIDGET_TYPE_SPECS`.
  - Error messages are plain and name the field: "A gauge takes no bucket", "Choose a floor plan", "Write the card's text".
  - Keep the existing messages for the existing cases word for word: the phase 1 web tests assert them.
- [ ] **Step 5:** Run both files, then the other shared files that import these: `dashboard-document.test.ts` and `widgets-equal` if separate. Expect PASS. Then `npm run build -w @digilog/shared`.
- [ ] **Step 6: Commit** `feat(shared): widget-type registry and the nine phase 2 widget types`.

### Task 2: API — overview `judged` + `lastSeenAt`, and `GET /api/alarms/counts`

**Files:**
- Modify:
  - `apps/api/src/modules/instruments/telemetry-overview.ts` + the overview response schema in `modules/instruments/routes.ts`;
  - `apps/api/src/modules/alarms/routes.ts`;
  - `apps/web/src/routes/dashboard/use-telemetry.ts` (`OverviewRow` gains the two optional fields; type only).
- Test: `apps/api/src/e2e/dashboard-phase2-data.e2e.test.ts` (new)

**Interfaces:**
- Produces:
  - `OverviewRow.judged: boolean`. TRUE when this instrument's PROFILE measures temperature or humidity (its resolved slot config maps at least one device key to either; use the same per-profile `slotConfigLookup` the row already uses, never a site-wide list).
  - `OverviewRow.lastSeenAt: string | null` (ISO, from `inst.lastSeenAt`).
  - `status` is NOT changed. The existing table and floor plan keep their behaviour.
  - `GET /api/alarms/counts`:
    - `ALARM_READ`;
    - query = the SAME parser and where-builder as `GET /api/alarms` (`parseAlarmListQuery` + `buildAlarmWhere` + the same visibility). Accepted: `instrumentIds`, `profileId`, `functionalLocationId`, `functionalLocationDirect`, `type`; paging and sort are ignored.
    - response:
      ```
      { quadrants: { activeUnack, activeAck, clearedUnack, clearedAck },
        byType: [{ type, active, unacknowledged }] }
      ```
      `byType` lists EVERY `ALARM_TYPE_TOKENS` entry in that order, zeros included, so the widget never decides which types exist. `unacknowledged` = `acknowledgedAt null`, either state, matching `/summary`.

- [ ] **Step 1: Failing e2e.** The file owns:
  - a SUPER_ADMIN;
  - an OPERATOR scoped to one Area;
  - a T&RH profile, plus a "Pressure" profile with measurements `[]`;
  - instruments in and out of scope;
  - alarms of three types in the four quadrants.

  It asserts:
  - a reporting pressure-only instrument has `status: 'NO_DATA'` (unchanged) and `judged: false`; a T&RH instrument `judged: true`; `lastSeenAt` round-trips;
  - `/alarms/counts` for the OPERATOR counts only in-scope alarms (negative control: an out-of-scope alarm moves the SA's count, not the operator's);
  - each filter (`instrumentIds`, `profileId`, `functionalLocationDirect`) narrows the count exactly as `GET /api/alarms`'s `counts` does for the same query (compare the two responses);
  - a user without `ALARM_READ` gets 403;
  - mutation-check each new schema field by deleting its line: the test must fail.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. Two `groupBy`/`count` queries are fine. Do not page.
- [ ] **Step 4:** Run the new file, then `instruments-telemetry-overview*`, `alarms-*` and `dashboard-source-filters.e2e.test.ts` one by one. Expect PASS. Then `npm run lint -w @digilog/api`.
- [ ] **Step 5: Commit** `feat(api): overview judged + lastSeenAt; GET /api/alarms/counts`.

### Task 3: API — `GET /api/instruments/telemetry-buckets`

**Files:**
- Create: `apps/api/src/modules/instruments/telemetry-buckets.ts`
- Modify: `apps/api/src/modules/instruments/routes.ts`
- Test: `apps/api/src/e2e/telemetry-buckets.e2e.test.ts`

**Interfaces:**
- Produces: `GET /api/instruments/telemetry-buckets?instrumentIds=a,b&keys=k1,k2&from=ISO&to=ISO&bucket=hour|day|week&agg=avg|min|max|count&groupBy=all|instrument`
  - **Permission:** `INSTRUMENT_READ`, the same as `/:id/telemetry`. Ids go through `parseUuidList` and are reduced by `withVisibility`. An out-of-scope id is silently ABSENT, as on every instrument route.
  - **Caps → 400 with a plain message:**
    - ≤ 50 instruments (`WIDGET_INSTRUMENTS_MAX`), ≤ 20 keys;
    - `from < to`;
    - ≤ 1000 buckets: "That window holds more than 1,000 {hours}; choose a larger bucket or a shorter window".
  - **Keys** match EXACTLY, as `getHistory`'s `keys` filter does, so a bar and a trend line on the same widget key read the same rows. Values go through `NUMERIC_READING` (the one SQL definition of a reading); non-numeric readings are not counted.
  - **Bins:** `date_bin` over `ts AT TIME ZONE $tz`, origin a local Monday midnight (`'2000-01-03'`), converted back with `AT TIME ZONE $tz`.
    - `$tz` is the `datetime` config's `timezone`; read it through whatever loader the API already uses for that def.
    - An unknown zone falls back to `'UTC'` and the response says `timezone: 'UTC'`.
  - **Response:**
    ```
    { from, to, bucket, agg, timezone, bucketSeconds,
      series: [{ instrumentId: string | null, key, points: [{ ts, value, readings, instruments }] }] }
    ```
    - `groupBy=all` → one series per key with `instrumentId: null`, aggregated across instruments.
    - `groupBy=instrument` → one series per instrument × key that has any reading.
    - Points are only buckets with readings. The web draws gaps; the server never fills a zero.
    - `count` = number of numeric readings.
    - Every field is declared in the response schema.
  - Raw SQL on `instrument_telemetry_history` (partitioned), following `telemetry-aggregate.ts`.

- [ ] **Step 1: Failing e2e.** The file seeds readings directly, anchored to fixed instants, never the clock. It asserts:
  - avg/min/max/count per hour for two instruments, in both `groupBy` modes;
  - with `timezone = Asia/Kolkata`, a reading at `2026-10-01T23:00:00Z` lands in the bucket starting `2026-10-01T18:30:00Z` (local 2 Oct 00:00) for `day`, and an hourly bucket starts at `…T18:30:00Z`, not `…T18:00:00Z`;
  - a `week` bucket starts on a local Monday;
  - a string reading `"21.5"` counts and `"NA"` does not;
  - an Area-scoped OPERATOR asking for an out-of-scope id gets no series for it (positive control: an in-scope id in the same call does);
  - the caps' 400s;
  - mutation-check: break the time-zone clause and the 23:00Z case fails.
  - Restore the `datetime` config in `afterAll` if the test sets it.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS. `npm run lint -w @digilog/api`.
- [ ] **Step 5: Commit** `feat(api): GET /api/instruments/telemetry-buckets — local-time buckets for the bar chart`.

### Task 4: Web — the ECharts foundation, the registry wiring, the one status word

**Files:**
- Modify: `apps/web/package.json` (+ root lockfile via `npm install echarts@6.1.0 -w @digilog/web --save-exact`)
- Create:
  - `apps/web/src/routes/dashboard/widgets/charts/echart.tsx`: the wrapper, the only static `echarts` importer;
  - `charts/lazy-echart.tsx`: `React.lazy` + `Suspense` fallback the size of the panel body;
  - `charts/chart-colors.ts`: `SERIES_HEX` (re-exported from `SERIES_COLORS`, not copied), `STATUS_HEX: Record<InstrumentStatus | 'NOT_JUDGED', string>` matching `status.ts`'s palette, `NEUTRAL_HEX`;
  - `widgets/instrument-look.ts`: `instrumentLook(row: Pick<OverviewRow,'status'|'reporting'|'judged'>) → { key: InstrumentStatus | 'NOT_JUDGED'; classes: StatusClasses }`. If `judged === false`: `reporting` ? NOT_JUDGED (neutral `UNJUDGED_CLASSES`, label "Not judged") : `statusClasses('STALE')` ("Offline"). Otherwise `statusClasses(row.status)`. An absent `judged` (a cached response) reads as `true`.
- Modify:
  - `widgets/widget-panel.tsx`: `WIDGET_EYEBROW` for all 14 types; `WidgetBody` dispatches the nine new types to their renderers, which are placeholders until their task lands;
  - `widgets/widget-dialog.tsx`:
    - the type picker lists all 14;
    - the key picker shows only when `WIDGET_TYPE_SPECS[type].keys !== 'none'`, filtered to telemetry for `'telemetry'`, capped at `keysMax`;
    - the source picker hides for `text_card`;
    - per-type option sections come from a `WIDGET_OPTION_SECTIONS: Partial<Record<WidgetType, Component>>` map that later tasks fill;
    - switching type drops options and keys the new type refuses, so a save cannot 400 on a leftover;
  - `widgets/use-widget-data.ts`:
    - `useTelemetryBuckets(ids, keys, range, bucket, agg, groupBy)`, with `refreshInterval: chartRefreshMs`, `keepPreviousData`;
    - `useAlarmCounts(selection)`: the same filter set the alarm table sends;
    - both return `{ data, loading, error }`.
- Test:
  - `charts/__tests__/echart.test.tsx` (with `echarts/core` mocked: init once, `setOption` with `notMerge` on a new option, `resize` on a ResizeObserver callback, `dispose` + observer `disconnect` on unmount);
  - `widgets/__tests__/instrument-look.test.ts` (all branches, including `judged` absent);
  - `widgets/__tests__/widget-dialog.test.tsx` (extend: a type with `keys:'none'` hides the key picker; switching from `trend_chart` to `status_grid` clears keys and period).

- [ ] **Step 1:** Install echarts pinned (`npm install echarts@6.1.0 -w @digilog/web --save-exact`) and confirm `apps/web/package.json` reads `"echarts": "6.1.0"`.
- [ ] **Step 2:** Write the failing tests above; run each alone; expect FAIL.
- [ ] **Step 3:** Implement.
  - Register with `echarts.use([GaugeChart, BarChart, PieChart, GridComponent, TooltipComponent, LegendComponent, MarkLineComponent, SVGRenderer])`.
  - The wrapper takes `{ option, height, ariaLabel }` and renders a `div role="img"`.
- [ ] **Step 4:** Run each test alone; expect PASS. Then:
  - re-run every existing file under `routes/dashboard/widgets/__tests__/` and `routes/dashboards/__tests__/` one by one;
  - `npx tsc -p apps/web/tsconfig.json --noEmit` (or the web lint script).
- [ ] **Step 5: Bundle check.**
  - `cd apps/web && npx vite build`.
  - `grep -l "echarts\|zrender" dist/assets/*.js` must NOT list the main `index-*.js` that `index.html` loads.
  - The echarts chunk's name appears in `dist/sw.js`.
  - Record the chunk size in the report.
- [ ] **Step 6: Commit** `feat(web): ECharts foundation (6.1.0, lazy, SVG), widget-type registry wiring, one instrument status word`.

### Task 5: Web — `gauge` and `comparison_bar`

**Files:**
- Create: `widgets/gauge-widget.tsx`, `widgets/gauge-model.ts`, `widgets/comparison-bar-widget.tsx`, `widgets/comparison-model.ts`
- Modify: `widget-panel.tsx` (dispatch), `widget-dialog.tsx` (option sections: gauge `min`/`max` number inputs, "Scale for keys the server does not judge")
- Test: `widgets/__tests__/gauge-model.test.ts`, `widgets/__tests__/comparison-model.test.ts`, `widgets/__tests__/gauge-widget.test.tsx`

**Interfaces:**
- Consumes: `useWidgetInstrumentIds`, `useLatestValues`, `keyCell` / `quantityVerdict`, `bandGaugeState`, `LazyEChart`, `chart-colors`.
- Produces:
  - `gaugeModel(v: LatestKeyValue | undefined, key: WidgetKey, opts: {min?, max?}, reporting: boolean, words) → { kind: 'banded' | 'scaled' | 'value-only'; min; max; value; text; unit; color; label }`.
    - A measured key with both bounds → `banded`: arc from `bandGaugeState`, colour from `quantityVerdict`.
    - A measured key without bounds → `value-only`, neutral, "Not assessed".
    - A raw key with widget `min`/`max` → `scaled`, neutral colour.
    - A raw key without them → `value-only`, neutral.
    - A fault word replaces the number exactly as `keyCell` does.
  - `buildGaugeOption(model)` (one gauge per ECharts instance) and `buildComparisonOption(rows, keys, ids, codes)`:
    - grouped bars per instrument code;
    - one series per key in `SERIES_HEX[key.color ?? n]`;
    - a non-numeric value is a gap, never 0;
    - the tooltip prints the value with the server's unit for a measured key and the widget's unit for a raw one.
  - Gauge layout: a responsive grid of gauges, instruments × keys, capped at `GAUGES_SHOWN_MAX`, with "N more not shown" as value cards do. Each gauge is titled `code · label`.
  - Comparison: instruments beyond 50 are not drawn, and the widget says how many.
- [ ] **Step 1:** Failing model tests. Cover:
  - every gauge branch (Review Focus 5);
  - a raw key is never given a status hex (assert the colour is `NEUTRAL_HEX` or a series hex);
  - for comparison, a non-numeric value yields `null` in the series data.
- [ ] **Step 2:** Run each; FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run each test alone; then the widget-dialog test; PASS.
- [ ] **Step 5: Render check.**
  - Use a throwaway capture config per the [[playwright-clicks-dont-land]] memory: `vite.capture.config.ts` with `https: undefined` on port 5179, proxied to `:3001`, deleted after.
  - Use a built dashboard holding a gauge (a measured key and the TCPIP-style raw `Pressure` key with min/max) and a comparison bar.
  - Look at the PNG at the panel's default size. Check clipped labels, the longest code and numbers that overflow.
  - Save the PNG to `docs/superpowers/concepts/2026-10-29-dashboards/built-p2-gauge.png` / `built-p2-comparison.png`.
- [ ] **Step 6: Commit** `feat(web): gauge and comparison bar widgets`.

### Task 6: Web — `bar_chart`

**Files:**
- Create: `widgets/bar-chart-widget.tsx`, `widgets/bar-chart-model.ts`
- Modify: `widget-panel.tsx`, `widget-dialog.tsx` (option section: Bucket, Value — Average/Minimum/Maximum/Reading count, Show — "All instruments combined" / "Each instrument")
- Test: `widgets/__tests__/bar-chart-model.test.ts`, `widgets/__tests__/bar-chart-widget.test.tsx`

**Interfaces:**
- Consumes: `useTelemetryBuckets`, `useWidgetRange` (follows the window exactly as the trend chart does), `LazyEChart`.
- Produces:
  - `barCaption(bucket, agg) → string`. EXACT words:
    - `hour`: "Hourly average" / "Hourly minimum" / "Hourly maximum" / "Hourly reading count";
    - `day`: "Daily …";
    - `week`: "Weekly …".

    The caption is shown under the card title on the widget's face.
  - `buildBarOption(resp, keys, codes, fmt)`:
    - category axis = bucket starts formatted with `useDatetimeFormat()` (`day`/`week` → date only, `hour` → date + time);
    - series colours from `SERIES_HEX`;
    - a missing bucket is a gap;
    - the tooltip shows the value (decimals as `decimalsSeen` of the series, or the key's `decimals`), "from N readings", and for `groupBy=all` "N instruments".
  - In `groupBy=instrument`, more than `BAR_SERIES_MAX` series → no chart. Instead the widget says: "Too many bars: {n} instruments × {m} keys. Show all instruments combined, or choose fewer." (the counts are numbers).
  - A 400 from the server (the 1,000-bucket cap) shows the server's message in the widget body, not the generic failure.
- [ ] **Step 1:** Failing tests:
  - every caption;
  - a gap stays `null`;
  - the series cap message;
  - the widget passes `from`/`to` from the dashboard window when `options.period` is absent, and its own period when set;
  - a 400 message is shown verbatim.
- [ ] **Step 2–4:** FAIL → implement → PASS (each file alone; then `trend-chart-widget` and `widget-common` tests).
- [ ] **Step 5:** Render check as Task 5 (`built-p2-bars.png`), with a day bucket over 7 days.
- [ ] **Step 6: Commit** `feat(web): bar chart widget — local-time buckets, labelled as computed`.

### Task 7: Web — `pie_chart`, `alarm_counts`, `status_grid`

**Files:**
- Create: `widgets/pie-chart-widget.tsx`, `widgets/pie-model.ts`, `widgets/alarm-counts-widget.tsx`, `widgets/status-grid-widget.tsx`
- Modify: `widget-panel.tsx`, `widget-dialog.tsx` (pie section: "Instrument status" / "Active alarms by type")
- Test: `widgets/__tests__/pie-model.test.ts`, `widgets/__tests__/alarm-counts-widget.test.tsx`, `widgets/__tests__/status-grid-widget.test.tsx`

**Interfaces:**
- Consumes: `useTelemetryOverview` (the selection's rows, the same SWR key as the readings table), `instrumentLook`, `useAlarmCounts`, the administered alarm type names (the hook the Alarms page uses — `routes/alarms/alarm-display.ts`), `LazyEChart`.
- Produces:
  - `statusPieModel(rows) → { key, label, count, hex }[]`. One slice per `instrumentLook` key with count > 0, in a fixed order: Out of limit, Partial, Offline, No data, Not judged, In limit. Labels and colours come from `instrumentLook` / `STATUS_HEX`, never recomputed.
  - `alarmTypePieModel(byType, names) → slices of active > 0`, in `SERIES_HEX` order, labelled with the administered names.
  - An empty pie (no slices) shows "Nothing to show" in text, not an empty ring.
  - `AlarmCountsWidget`:
    - two large figures, "Active" (`activeUnack + activeAck`) and "Unacknowledged" (`activeUnack + clearedUnack`), from the server's quadrants;
    - then a compact list of every type from `byType` with its active count, zeros muted.
    - A 403/failed load → "Could not load this widget." (as the alarm table).
  - `StatusGridWidget`:
    - one tile per instrument in server order: code (truncated with a `title`), the `instrumentLook` word and colour;
    - a click opens `/instruments/:id/trend` with `state: { from: 'dashboard' }`;
    - tiles reflow by panel width;
    - more than 120 instruments → "N more not shown".
- [ ] **Step 1:** Failing tests:
  - Review Focus 1 end to end: a `judged:false, reporting:true` row is "Not judged" with the neutral classes in the grid and the pie, never "No data" and never green; with `reporting:false` it is "Offline";
  - the counts widget's figures come only from the response (a mocked response with distinct numbers per quadrant proves the sums);
  - the 403 message;
  - a grid tile click navigates.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Render check (`built-p2-pie.png`, `built-p2-counts-grid.png`).
- [ ] **Step 6: Commit** `feat(web): pie, alarm counts and status grid widgets`.

### Task 8: Web — `instrument_list`, `text_card`, `floorplan`

**Files:**
- Create: `widgets/instrument-list-widget.tsx`, `widgets/text-card-widget.tsx`, `widgets/floorplan-widget.tsx`
- Modify:
  - `routes/dashboard/floorplan-view.tsx`: optional props `planId` (fixed plan, picker hidden) and `profileId` / `instrumentIds` passed into its `useTelemetryOverview` call. With none of them its behaviour is exactly today's.
  - `widget-panel.tsx`;
  - `widget-dialog.tsx`: the text section, a textarea with `name="widget-text"` and a counter `n / 2000`; the floor plan section, a plan picker from `useFloorplans`.
- Test: `widgets/__tests__/instrument-list-widget.test.tsx`, `widgets/__tests__/text-card-widget.test.tsx`, `widgets/__tests__/floorplan-widget.test.tsx`; re-run every existing `floorplan-view` test unchanged.

**Interfaces:**
- Produces:
  - **Instrument list:** UI v3 table.
    - Columns: Instrument ID (code), Area (`functionalLocationName`), Location (`locationAttribute`), Status (`instrumentLook`), Last seen (`lastSeenAt` through `useDatetimeFormat`, "—" when null).
    - Rows are in server order, paged client-side by `options.pageSize` (default 10) with the shared pager.
    - A row click opens the trend page as the status grid does.
  - **Text card:** `options.text` as a React text node with `whitespace-pre-wrap`. Never `dangerouslySetInnerHTML`, never markdown.
    - Check how widget `title` is sanitised on the two write paths (`PUT /api/dashboards/:id` and the home layout PUT). `text` must get the same treatment.
    - If neither strips HTML today, apply `stripHtml` to both `title` and `text` in the shared write path of each, and add one e2e assertion per path.
  - **Floor plan:** `<FloorplanView planId={widget.options.planId} …selection />`.
    - A plan the viewer cannot see, or that no longer exists, → "This floor plan is not available." — not the picker, not a crash.
    - It follows the dashboard's selection for which instruments are drawn.
- [ ] **Step 1:** Failing tests:
  - list columns and paging; Last seen formatting; "Not judged" in the Status column;
  - the text card renders `<b>x</b>` as literal text (no `b` element in the DOM);
  - the floor-plan widget with a missing `planId` row shows the message;
  - `FloorplanView` without the new props makes the same overview request as before (assert the args).
- [ ] **Step 2–4:** FAIL → implement → PASS (each file alone, then every `floorplan-view` / `room-detail` test).
- [ ] **Step 5:** Render check (`built-p2-list-text-floor.png`).
- [ ] **Step 6: Commit** `feat(web): instrument list, text card and floor plan widgets`.

### Task 9: See it, document it, gate it

**Files:** `CHANGELOG.md`, `docs/feature-notes.md` (the DASHBOARDS note: phase 2), `apps/web/CLAUDE.md` (ECharts: pinned, lazy, the bundle check), `docs/recreation/06-api/endpoints.md` (the two routes and the two overview fields), `tasks/todo.md`; `docs/superpowers/concepts/2026-10-29-dashboards/built-p2-dashboard.png`.

- [ ] **Step 1: One built dashboard** holding every new widget type, sourced from a profile, rendered at 1240 × 880 with the built CSS.
  - Look for unaligned elements, clipped labels and console errors or unexpected responses (the CLAUDE.md front-end rule).
  - Fix what you find in the owning file, and say so in the report.
- [ ] **Step 2:** On `/`, as a role WITHOUT `dashboard_alarms`, an `alarm_counts` widget placed through the layout PUT is not drawn (Review Focus 3); with the panel it is.
- [ ] **Step 3: Docs.**
  - Re-derive every count you touch by `grep`/`ls`. Nothing in System Stats moves except the web dependency list; say so explicitly.
  - Record in the feature note:
    - the `judged` / "Not judged" rule;
    - the time-zone bucket rule;
    - the `/` gates;
    - ECharts' version and the bundle check.
- [ ] **Step 4: Gates.**
  - Shared suite.
  - Every web file touched or under `routes/dashboard/widgets/__tests__` and `routes/dashboards/__tests__`, one per process.
  - The two new API e2e files plus `dashboards-module`, `dashboard-source-filters`, `instruments-telemetry-overview*` and `alarms-*`, one at a time.
  - `npm run lint` in all three packages; `npx vite build` + the Task 4 bundle check.
- [ ] **Step 5: Commit** `docs: dashboard builder phase 2`.

## Rulings made in this plan

- **P1 — one registry, not nine edits.** `WIDGET_TYPE_SPECS` decides keys, window, options and the `/` gate for every type; the schema, the layout gate and the dialog read it. If wrong: a refactor back to per-type branches, with no data change.
- **P2 — no concept-image round for phase 2.** The new widgets live inside the shipped dashboard look (`PanelCard`, table band, `keyCell` colours), and the operator answered "do best one" when phase 1 offered concepts. Each widget task instead renders at panel size with the built CSS and is looked at before it is done. If wrong: a restyle of the widget bodies.
- **P3 — "Not judged", not "No data", for an instrument whose profile measures neither temperature nor humidity**, decided by a server flag. It applies only on the new status widgets; the existing table and floor plan are unchanged (profile-measurements phase 2 owns that). If wrong: one function, `instrumentLook`.
- **P4 — bars and comparison bars take series colours, never verdicts**, and draw no limit lines in phase 2: limits across several instruments may disagree, and a line drawn for one would misstate the others. If wrong: add limit lines when the server says the bounds agree (the `limitsAgree` precedent).
- **P5 — local-time buckets** in the configured `datetime` timezone, with weeks starting Monday. If wrong: one SQL clause.
- **P6 — gauge caps at 24, comparison at 50 instruments, status grid at 120 tiles, bar series at 6**, each saying what it left out. If wrong: constants.
- **P7 — the text card is plain text**: no HTML and no markdown, 2,000 characters. If wrong: a renderer change.
- **P8 — the pie offers only server-decided distributions** (instrument status, active alarms by type); never a pie of raw readings (spec §7).
- **P9 — order:** the shapes the operator named (gauge, bars, pie) land before counts, the grid, the list, text and floor plan.
