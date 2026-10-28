# Widget Data Keys — Phase 2 (dashboard widgets) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A SUPER_ADMIN can add four kinds of widget to the dashboard (Value cards, Latest values table, Trend chart, Time series table) over any telemetry or attribute key, and share them through a role's default layout. Built widgets are governed by one new panel, `custom_widgets`.

**Architecture:**
- **Storage.** Widget definitions live in the existing layout JSON as `layout.widgets`, and each is placed by a grid item `i: "w:<uuid>"`. One shared zod schema validates them.
- **Reading and writing.** The shared layout READER forgives: a bad widget is dropped with its item. The WRITER is strict: the PUTs answer 400. A widget change by anyone but a SUPER_ADMIN is a 403.
- **Rendering.** Every value comes from Phase 1's routes. A measured key's verdict is the band gauge's rule, lifted into one function. A raw key is never judged.

**Tech Stack:**
- Web: React 19, SWR, react-grid-layout 2.x, Tailwind v4.
- API: Fastify 5.
- Shared: zod in `@digilog/shared`.
- Tests: vitest (jsdom for the web, `app.inject` for e2e).

**Spec:** `docs/superpowers/specs/2026-10-28-widget-data-keys-design.md` (§4, §6, §10, §12, §13). Phase 1 ledger: `.superpowers/sdd/2026-10-28-widget-data-keys-phase1/progress.md`. Its rulings on the 200 cap and on "KeyRef names a device key" are settled below.

## Global Constraints

- **Only a SUPER_ADMIN builds, edits or removes widgets** (operator 2026-10-28: "super admin only").
  - On screen, the controls exist only in Arrange mode, and Arrange is SUPER_ADMIN-only (`index.tsx`, `canArrange`).
  - The control itself is the 403 `WIDGETS_SUPER_ADMIN_ONLY` on BOTH layout PUTs, whenever the resulting widgets differ from the row being overwritten.
- **A widget grants nothing.**
  - Its data comes only from `GET /api/instruments/data-keys`, `POST /api/instruments/latest-values`, `GET /api/instruments/:id/telemetry` and `GET /api/instruments/telemetry-history`, with the viewer's own scope.
  - An instrument missing from a response is not drawn.
  - When none of a widget's instruments is in view, it prints `No instruments in your view`.
- **`custom_widgets` is a visibility GATE and is never a grid item.**
  - `w:` items survive `resolveLayout` only when it is among the viewer's panels.
  - It is never appended as a card, and an item named `custom_widgets` is dropped.
- **On both PUTs, an omitted `widgets` key means KEEP what is stored** in the row being overwritten: the user row for `/my-dashboard-layout`, the role row for `/dashboard-layout/role/:name`. This is the `doors` precedent. The reason is that an old cached SPA, or an ADMIN tidying a role default, must not delete the super admin's widgets.
- **Two readers.**
  - `normalizeLayout` (read) forgives. It drops a malformed widget and its `w:` item, and a `w:` item without a definition. Everything else stays.
  - `parseLayoutForWrite` (both PUTs) is strict. It returns a 400 that names the widget and gives zod's message.
  - Never use one for the other.
- **Fastify strips undeclared fields.** Declare `widgets` as `{ type: 'array', items: { type: 'object', additionalProperties: true } }` on the `/api/config/my-config` 200 schema (`layout.widgets`) and on both PUT bodies. Do not enumerate the inner shape there: zod validates it.
- **Shapes stay the same.** `normalizeLayout` and `resolveLayout` put `widgets` on the result ONLY when it is non-empty. Every stored layout without widgets, and every existing `toEqual`, keeps its shape. `LAYOUT_VERSION` stays 1.
- **Raw key.**
  - It never gets a status colour from `statusClasses()`. It shows the neutral grey rule and the words `Not judged`, or `Offline` when the server says the instrument is not reporting.
  - Its value prints as received unless the widget sets `decimals`.
  - The browser invents neither a unit nor a precision for it.
- **Measured key.** A key is measured exactly when its `LatestKeyValue.judged !== null`; that is the server's answer, never re-derived.
  - The unit, decimals, bounds and fault flags are the server's.
  - On a widget, only the label and colour can be changed.
  - A measured key whose `judged.sensorError` or `rangeError` is set is NOT a reading. It shows the fault word (`useSensorWords()`), never a number and never `Out of limit`.
- **One verdict.** Use `quantityVerdict()` in `routes/dashboard/set-point.ts`, called by `band-gauge.tsx` and by every widget. Precedence: fault → no reading (`No data`) → breach (`Out of limit`) → inherited STALE (`Offline`) → `In limit`. Plus `assessed = false` when a reading exists and neither bound does. The `band-gauge.test.tsx` cases stay green UNEDITED.
- **Numeric is a hint, never a gate** (spec §4 wins over §6.2/§6.3 — Ruling P2-1).
  - A telemetry key with `numeric: false` can be chosen for a Trend chart, with the hint `No numeric reading lately`.
  - Only ATTRIBUTE keys are refused for a Trend chart: `Attributes have no history to plot`. Both the zod schema and the picker refuse them.
  - The chart shows how much it could not plot as `N text readings not plotted`, where N = Σ(`count − numericCount`).
- **Never cut silently.**
  - `latest-values` is batched in chunks of 200 ids (`DATA_KEYS_INSTRUMENTS_MAX`).
  - Value cards draw at most 60 cards.
  - A Trend chart draws at most 10 series (`TREND_SERIES_MAX`).
  - A Time series table queries at most the first 50 instruments (`WIDGET_INSTRUMENTS_MAX`; this bounds the GET URL).
  - Each cap prints `Showing X of Y <cards|series|instruments>`.
- **Caps** (shared constants):
  - 20 widgets per layout;
  - 50 fixed instruments;
  - 20 keys per widget (= `DATA_KEYS_PER_REQUEST_MAX`);
  - 10 trend series;
  - colours are palette INDEX 0–5 (`WIDGET_COLOR_COUNT = 6` = `SERIES_COLORS.length`, pinned by a web test);
  - page sizes are `10 | 25 | 50`;
  - title 1–80 chars, label ≤ 60, unit ≤ 16, decimals 0–6.
- **Refresh.** Value widgets poll at `useTelemetrySettings().overviewRefreshMs`, and charts and the time series table at `chartRefreshMs`.
- **Re-auth.** "Save as role default" goes through `reauth.execute('UPDATE_ROLE_CONFIG', …)` and passes `onSuccess`, `onError` AND `onCancel`; `hooks/__tests__/reauth-callers-declare-cancel.test.ts` enforces it. The busy flag is cleared only by those three outcomes, never after the `await`.
- **No migration**, no new permission, re-auth action, audit action, route, model, enum, sidebar item, config def or config page.
- **Counts that move:**
  - `PANELS` +1 (`custom_widgets`);
  - shared type files 35 → 36 (`dashboard-widgets.ts`);
  - API routes +0 (`data-keys` gains two query parameters).
- **Tests:**
  - Shared: `cd packages/shared && npx vitest run <file>`, then `npm run build -w @digilog/shared`.
  - API: one file at a time, `cd apps/api && npx vitest run <file> --pool=forks --poolOptions.forks.singleFork=true`, judged by exit code. Every e2e file owns its super admin, profile and instruments, and restores what it touched FIRST in `afterAll`.
  - Web: ONE test file per process, `cd apps/web && npx vitest run <file>`, judged by exit code. SWR mocks must return stable objects (fresh-object mocks hang vitest).
- **Look:**
  - light theme;
  - `PanelCard` band header;
  - `.tbl-grid` tables;
  - `useDatetimeFormat()` for every instant;
  - no browser `alert` or `confirm`.

## Review Focus

1. **An old cached SPA** saves `{version, items}` without `widgets` after the deploy. The stored widgets and their items must survive. Task 2 test: `omitted widgets keep what is stored`.
2. **A non-SUPER_ADMIN with a leftover personal layout** (locally, one MAINTENANCE and one ADMIN user hold one from before 2026-08-29) must still see the role's built widgets. Their own layout wins outright, and they cannot reach Arrange → Reset. Task 1 test: `a non-super-admin's own layout still shows the role's widgets`; Task 2 e2e: the same over HTTP.
3. **A selection of more than 200 instruments** (the plant is ~320) must reach every instrument through batching, and must say what a cap hid. Task 5 test: `300 ids → two latest-values requests, every row`; Task 7 test: `value cards say how many they did not draw`.
4. **A measured key under a sensor or range fault** never prints its stored number or `Out of limit`. Task 4 test: `a faulted measured key shows the fault word, not the number`.
5. **A role default naming instruments outside a viewer's scope** draws the rest, or prints `No instruments in your view`. Task 7 test: `instruments missing from the response are not drawn`.

---

### Task 1: Shared — widget contract, the layout carries widgets, the `custom_widgets` panel

**Files:**
- Create: `packages/shared/src/types/dashboard-widgets.ts`
- Create: `packages/shared/src/types/dashboard-widgets.test.ts`
- Modify: `packages/shared/src/types/dashboard-layout.ts` (`DashboardLayout`, `readItem`, `normalizeLayout`, new `parseLayoutForWrite`, `resolveLayout`, `appendMissing`, `DASHBOARD_PANEL_KEYS`)
- Modify: `packages/shared/src/types/dashboard-layout.test.ts`
- Modify: `packages/shared/src/types/panels.ts` (append the entry), `packages/shared/src/types/panels.test.ts` (frozen order re-pinned by APPENDING)
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces (in `dashboard-widgets.ts`):
  - `CUSTOM_WIDGETS_PANEL = 'custom_widgets'` and `WIDGET_ITEM_PREFIX = 'w:'`.
  - `WIDGET_TYPES = ['value_cards', 'latest_table', 'trend_chart', 'timeseries_table'] as const`, and `type WidgetType`.
  - Caps: `WIDGETS_PER_LAYOUT_MAX = 20`, `WIDGET_INSTRUMENTS_MAX = 50`, `WIDGET_KEYS_MAX = 20`, `TREND_SERIES_MAX = 10`, `VALUE_CARDS_SHOWN_MAX = 60`, `WIDGET_COLOR_COUNT = 6`, `WIDGET_PAGE_SIZES = [10, 25, 50] as const`.
  - `widgetKeySchema`: `dataKeyRefSchema.extend({ label?: trimmed ≤60, unit?: trimmed ≤16, decimals?: int 0..6, color?: int 0..5 })`, and `type WidgetKey`.
  - `widgetSourceSchema`: a discriminated union on `mode`, either `{ mode: 'selection' }` or `{ mode: 'instruments', ids: uuid[] 1..50 }` (ids deduplicated).
  - `customWidgetSchema`: `{ id: uuid, type, title: trimmed 1..80, source, keys: WidgetKey[] 1..20, options: { period?: a `PERIOD_PRESETS` value (not `'custom'`), pageSize?: 10|25|50 } }`.
    - `superRefine`: refuse a duplicate `(source, key)`.
    - `superRefine`: on `trend_chart`, refuse any `source: 'attribute'` with the message `Attributes have no history to plot`.
    - `type CustomWidget`.
  - `widgetItemId(id: string): string`, `widgetIdOf(i: string): string | null` and `isWidgetItem(i: string): boolean`.
  - `widgetsEqual(a?: readonly CustomWidget[], b?: readonly CustomWidget[]): boolean` compares the canonical JSON of each list's `customWidgetSchema.parse` output; `undefined` ≡ `[]`.
- Produces (in `dashboard-layout.ts`):
  - `DashboardLayout.widgets?: CustomWidget[]`.
  - `parseLayoutForWrite(v: unknown, storedWidgets: readonly CustomWidget[] | undefined): { ok: true; layout: DashboardLayout } | { ok: false; message: string }`.
  - `resolveLayout(user, role, visiblePanels, opts?: { viewerIsSuperAdmin?: boolean })`. The 3-argument calls behave as `viewerIsSuperAdmin: true`, which is the old behaviour.
- Produces (in `panels.ts`), appended LAST: `{ key: 'custom_widgets', page: 'dashboard', label: 'Built widgets', description: 'Widgets a super admin adds to the dashboard — value cards, tables and trend charts over any key' }`.

- [ ] **Step 1: Write the failing tests.**
  - In `dashboard-widgets.test.ts`:
    - the schema accepts one widget of each type;
    - it refuses `title: ''`, 21 keys, 51 ids, `decimals: 7`, `color: 6`, a duplicate `t`, and `period: 'custom'`;
    - `trend_chart` with an attribute key fails with `Attributes have no history to plot`;
    - `widgetsEqual` is true for the same widgets with keys in a different object-key order, and false when a label changes;
    - `widgetIdOf('w:<uuid>') === '<uuid>'` and `widgetIdOf('telemetry_table') === null`.
  - In `dashboard-layout.test.ts`:
    - `a layout with one malformed widget keeps every other item` — a stored layout with a good widget, a bad widget (`type: 'pie'`) and three panel items. It reads back as the three panels plus the good widget and its item, and the bad widget's `w:` item is gone.
    - `a w: item with no definition is dropped, not the layout`.
    - `an item named custom_widgets is dropped`.
    - `every panel visible places no custom_widgets card`: `resolveLayout(undefined, undefined, [...PANEL_KEYS]).items.map((i) => i.i)` does not contain `'custom_widgets'`.
    - `w: items need the custom_widgets panel`: with visible = the dashboard keys minus `custom_widgets`, the result has no `w:` item and no `widgets`.
    - `a non-super-admin's own layout still shows the role's widgets`. The user layout holds panels only. The role layout holds widget W at `{x:0, y:0, w:6, h:5}`. The resolved `items` hold the user's panels, plus `w:W` with `y` = the bottom of the user's panels and `w: 6, h: 5`; `widgets` is `[W]`. The same call with `viewerIsSuperAdmin: true` returns the user's layout alone.
    - `parseLayoutForWrite`:
      - an omitted `widgets` key keeps `storedWidgets` (their items must be present);
      - `widgets: []` with no `w:` items is OK;
      - a malformed widget → `ok: false` with a message naming its title;
      - a `w:` item with no widget → `ok: false`;
      - a widget with no item → `ok: false` (`Widget "<title>" is not placed`);
      - 21 widgets → `ok: false`;
      - a retired panel key is dropped, as today.
    - An existing layout without widgets still `toEqual`s `{ version, items }`, with no `widgets` key.
  - In `panels.test.ts`: the frozen-order assertion gains `'custom_widgets'` as the last key.
- [ ] **Step 2: Run** `cd packages/shared && npx vitest run src/types/dashboard-widgets.test.ts`, then `npx vitest run src/types/dashboard-layout.test.ts`, then `npx vitest run src/types/panels.test.ts`. Expected: FAIL (the module is missing; the new cases fail).
- [ ] **Step 3: Implement.**
  - **`DASHBOARD_PANEL_KEYS`** excludes `CUSTOM_WIDGETS_PANEL`. It is the placeable set, so `appendMissing` can never place it.
  - **`readItem`.** A `w:<uuid>` id is a valid item. `custom_widgets` returns `null` (dropped).
  - **`normalizeLayout`.**
    - It reads `o.widgets` when it is an array: each entry goes through `customWidgetSchema.safeParse`, the bad ones are dropped, the first of each id is kept, and at most 20 survive.
    - It then drops `w:` items whose widget is absent, and widgets with no item.
  - **`resolveLayout`.**
    - Placeable panels = visible ∩ `DASHBOARD_PANEL_KEYS`. Widgets are visible only when `visiblePanels` includes `CUSTOM_WIDGETS_PANEL`.
    - The widget SOURCE is the chosen layout, except for a non-super-admin who has their own layout. Then it is the ROLE layout's widgets, with the role's `w:` items appended below the user's placed panels, keeping their `x / w / h` and offset by that bottom.
  - **`parseLayoutForWrite`** reuses `readItem` (an unreadable item gives `ok: false`), then applies the strict widget rules above.
- [ ] **Step 4: Run** the three files, each expected to PASS. Then run `npx vitest run` (the whole shared suite, exit 0), `npm run build -w @digilog/shared` (exit 0) and `cd packages/shared && npm run lint` (exit 0).
- [ ] **Step 5: Commit** `feat(shared): dashboard widget contract; the layout carries widgets (phase 2)`.

---

### Task 2: API — both layout routes carry widgets; only a SUPER_ADMIN changes them

**Files:**
- Modify: `apps/api/src/modules/config/static-routes/roles.routes.ts`:
  - `my-config` 200 schema `layout.widgets`;
  - `layoutBody.layout.widgets`;
  - the `PUT /my-dashboard-layout` handler.
- Modify: `apps/api/src/modules/roles/routes.ts`: the `PUT /dashboard-layout/role/:name` body schema and handler.
- Modify: `apps/api/src/modules/config/dashboard-layout.ts`: `resolveLayoutFor` passes `{ viewerIsSuperAdmin: user.role === 'SUPER_ADMIN' }`.
- Create: `apps/api/src/e2e/dashboard-widgets.e2e.test.ts`
- Must stay green unedited: `apps/api/src/e2e/dashboard-layout.test.ts`, `apps/api/src/e2e/panel-access.test.ts`

**Interfaces:**
- Consumes: from Task 1, `parseLayoutForWrite`, `normalizeLayout`, `widgetsEqual`, `resolveLayout(…, { viewerIsSuperAdmin })` and `CUSTOM_WIDGETS_PANEL`.
- Produces:
  - `PUT /api/config/my-dashboard-layout` and `PUT /api/roles/dashboard-layout/role/:name` accept `layout.widgets`.
  - 400 `VALIDATION_ERROR` carries `parseLayoutForWrite`'s message.
  - 403 `WIDGETS_SUPER_ADMIN_ONLY` reads "Only a super admin can add, change or remove dashboard widgets."
  - `GET /api/config/my-config` returns `layout.widgets` when there are any.
  - The role route's audit `signatureMeaning` gains `, N widget(s)` when there are widgets, and stays ≤ 255 chars.

- [ ] **Step 1: Write the failing e2e.** `dashboard-widgets.e2e.test.ts` owns:
  - a SUPER_ADMIN `dw_sa`;
  - an OPERATOR `dw_op`, whose role `role_configs.dashboard_cards` it saves and restores FIRST in `afterAll`;
  - and the `role_configs.dashboard_layout` for OPERATOR, also restored first.

  Cases:
  1. `a super admin's widget round-trips through my-config`: PUT a layout holding one widget of each type with every optional field set. `GET my-config` → `layout.widgets` `toEqual`s what was sent, inner keys included.
  2. `a malformed widget is a 400, and nothing is stored`.
  3. `omitted widgets keep what is stored`: after case 1, PUT `{version, items}` (the same items, `widgets` absent) → 200, and `my-config` still holds all four widgets.
  4. `a non-super-admin cannot change widgets` (`dw_op` PUTs its own layout with a widget → 403), `but can save the widgets it already has` (the same layout, widgets omitted → 200).
  5. `a role default's widgets reach that role only with the custom_widgets panel`:
     - the SA PUTs the OPERATOR role layout with widget W → 200;
     - with OPERATOR's `dashboard_cards` = `['telemetry_table']`, `dw_op`'s `my-config` has no `w:` item and no `widgets`;
     - with `['telemetry_table', 'custom_widgets']` it has `w:W` and `widgets[0].id === W.id`.
  6. `a non-super-admin's own layout still shows the role's widgets`: `dw_op` has its own layout row (written directly through prisma, panels only) → `my-config` holds `w:W`.
  7. `a stored layout with one bad widget keeps everything else`: write a raw row whose `widgets` holds one good and one bad entry → `my-config` returns the good one and every panel.
  8. `an ADMIN with ROLE_MANAGE cannot change a role's widgets`: create an ADMIN user, PUT a role layout with a changed widget → 403; the same layout with widgets omitted → 200, and the stored widgets are unchanged.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/e2e/dashboard-widgets.e2e.test.ts --pool=forks --poolOptions.forks.singleFork=true`. Expected: FAIL (`widgets` is stripped or ignored).
- [ ] **Step 3: Implement.**
  - **Schemas.** Add `widgets: { type: 'array', items: { type: 'object', additionalProperties: true } }` under `layout` in the my-config 200 schema and in both PUT bodies.
  - **Handlers.** Both handlers:
    - read the row they overwrite;
    - `storedWidgets = normalizeLayout(row?.dashboardLayout)?.widgets`;
    - run `parseLayoutForWrite(layout, storedWidgets)` → 400;
    - if `req.user.role !== 'SUPER_ADMIN' && !widgetsEqual(parsed.widgets, storedWidgets)` → 403;
    - store `parsed`.
  - **Role route.** It keeps its `null` (clear) branch. Clearing a role layout that holds widgets is a widget change, so it is a 403 for a non-SA.
  - **`resolveLayoutFor`** passes the viewer's role.
- [ ] **Step 4: Run** the new file (PASS), then `src/e2e/dashboard-layout.test.ts` and `src/e2e/panel-access.test.ts`, one at a time (PASS). Then run `npm run lint` (exit 0).
- [ ] **Step 5: Mutation check** (restore from a backup copy, never `git checkout`):
  - Delete the my-config `widgets` schema line → case 1 fails.
  - Delete the 403 branch → cases 4 and 8 fail.
  - Make an omitted `widgets` read as `[]` → case 3 fails.

  Record each in the ledger.
- [ ] **Step 6: Commit** `feat(api): layouts carry dashboard widgets; only a super admin changes them`.

---

### Task 3: API — the key catalogue covers the dashboard's own selections

**Files:**
- Modify: `apps/api/src/modules/instruments/data-keys-routes.ts`, `GET /data-keys`
- Modify: `apps/api/src/e2e/data-keys.e2e.test.ts` (two cases)
- Modify: `docs/recreation/06-api/endpoints.md` (the `data-keys` row)

**Interfaces:**
- Produces two query parameters on `GET /api/instruments/data-keys`:
  - `all=true` is a FOURTH selector: every instrument in the caller's view. "Exactly one selector" still holds.
  - `functionalLocationDirect=true`, used with `functionalLocationId` only, selects the instruments placed directly on that location, with no Area expansion. The name and meaning match `telemetry-overview`'s.

- [ ] **Step 1: Write the failing e2e cases.**
  - `all=true lists the keys of every visible instrument and nothing outside the caller's scope`: a scoped OPERATOR, plus a positive control.
  - `functionalLocationDirect=true leaves out the Areas' instruments`: a Block holding one direct instrument with key `pd`, and an Area instrument with key `pa` → only `pd`.
  - `all=true plus another selector is a 400`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/e2e/data-keys.e2e.test.ts --pool=forks --poolOptions.forks.singleFork=true`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement.** Use the same `resolveVisibility` / `withVisibility` path as the other selectors. Declare both parameters in the querystring schema: `all` as `{ type: 'string', enum: ['true'] }`, and `functionalLocationDirect` as `{ type: 'string', enum: ['true', 'false'] }`.
- [ ] **Step 4: Run** the file → PASS; `npm run lint` → exit 0.
- [ ] **Step 5: Commit** `feat(api): data-keys takes all=true and functionalLocationDirect`.

---

### Task 4: Web — one verdict, one value formatter

**Files:**
- Modify: `apps/web/src/routes/dashboard/set-point.ts` (add `quantityVerdict`)
- Modify: `apps/web/src/routes/dashboard/__tests__/set-point.test.ts`
- Modify: `apps/web/src/routes/instruments/band-gauge.tsx` (its status / assessed / fault come from `quantityVerdict`)
- Create: `apps/web/src/routes/dashboard/widgets/key-value.ts`
- Create: `apps/web/src/routes/dashboard/widgets/__tests__/key-value.test.ts`
- Must stay green unedited: `apps/web/src/routes/instruments/__tests__/band-gauge.test.tsx`

**Interfaces:**
- Produces, in `set-point.ts`:
  ```ts
  export interface QuantityVerdict { status: InstrumentStatus; assessed: boolean; fault: string | null }
  export function quantityVerdict(
    o: { value: number | null | undefined; min: number | null | undefined; max: number | null | undefined;
         instrumentStatus?: InstrumentStatus | null; sensorError?: boolean; rangeError?: boolean },
    words?: { failure: string; outOfRange: string },
  ): QuantityVerdict
  ```
  The precedence is the one in Global Constraints. A fault forces the value to null.
- Produces, in `key-value.ts`:
  - `UNJUDGED_CLASSES: StatusClasses` (slate; `label: 'Not judged'`).
  - `isMeasured(v: LatestKeyValue): boolean` is `v.judged !== null`.
  - `decimalsSeen(values: number[]): number` returns the most fractional digits in `String(n)`, capped at 6. It is used for a raw chart axis without widget decimals, and only ever describes the received data.
  - `formatKeyValue(v: LatestKeyValue | undefined, key: WidgetKey): string`:
    - absent or `value === null` → `'NA'`;
    - attribute → `v.display ?? String(value)`;
    - measured → the `coerceReading` number `.toFixed(clampDecimals(v.decimals))`, or the text as received;
    - raw → with `key.decimals` set and a number: `.toFixed(key.decimals)`;
    - otherwise a number as `String(n)`, a string verbatim, a boolean as `'true'`/`'false'`, and anything else as `JSON.stringify`.
  - `keyCell(v: LatestKeyValue | undefined, reporting: boolean, key: WidgetKey, words: SensorWords): { text: string; unit: string | null; judged: boolean; label: string; classes: StatusClasses }`:
    - measured → `quantityVerdict({ value: coerceReading(v.value), min: judged.limitMin, max: judged.limitMax, instrumentStatus: reporting ? null : 'STALE', sensorError, rangeError }, words)`; `text` = the fault word ?? `formatKeyValue`; `classes` = `statusClasses(status)`; `label` = `assessed ? classes.label : 'Not assessed'`;
    - raw or attribute → `classes = reporting ? UNJUDGED_CLASSES : statusClasses('STALE')`, `label = reporting ? 'Not judged' : 'Offline'`;
    - `unit` = measured `v.unit`, raw `key.unit ?? null`, and `null` whenever the text is `NA` or a fault word.

- [ ] **Step 1: Write the failing tests.**
  - In `set-point.test.ts`:
    - `quantityVerdict` returns `NO_DATA` for null;
    - `OUT_OF_SPEC` for 30 against max 27;
    - `STALE` for an in-range value with `instrumentStatus: 'STALE'`;
    - `OK` otherwise;
    - `assessed: false` with a value and no bounds;
    - `a faulted reading is not a reading`: value 60, max 27, `rangeError: true` → status `NO_DATA`, fault = the out-of-range word.
  - In `key-value.test.ts`:
    - `a raw key never renders green`: a raw numeric value with the instrument reporting; every field of `classes` differs from `statusClasses('OK')`, and the label is `Not judged`;
    - `a measured key prints the server's decimals`: value `"21.456"` (quoted, as the gateways send), decimals 1 → `21.5`;
    - `a raw key prints as received`: `0.05` → `0.05`, `"NA"` → `NA`, `true` → `true`;
    - `widget decimals apply to a raw key only`;
    - `a faulted measured key shows the fault word, not the number`;
    - `an offline instrument's raw key reads Offline, not In limit`;
    - `decimalsSeen([1, 2.25, 3.1]) === 2`;
    - `SERIES_COLORS.length === WIDGET_COLOR_COUNT`.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/routes/dashboard/__tests__/set-point.test.ts`, then `npx vitest run src/routes/dashboard/widgets/__tests__/key-value.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `band-gauge.tsx` replaces its inline `status` / `assessed` / `fault` with ONE `quantityVerdict` call. `bandGaugeState` still draws the arc.
- [ ] **Step 4: Run** both files, then `src/routes/instruments/__tests__/band-gauge.test.tsx`, one at a time. All PASS, with `band-gauge.test.tsx` unedited.
- [ ] **Step 5: Commit** `refactor(web): one per-quantity verdict for the band gauge and the widgets`.

---

### Task 5: Web — widget data hooks

**Files:**
- Create: `apps/web/src/routes/dashboard/widgets/use-widget-data.ts`
- Create: `apps/web/src/routes/dashboard/widgets/__tests__/use-widget-data.test.tsx`

**Interfaces:**
- Consumes:
  - `useTelemetryOverview({ functionalLocationId, directOnly })` and `useTelemetrySettings()` (`use-telemetry.ts`);
  - `apiClient.get` / `apiClient.post`;
  - the Phase 1 types.
- Produces:
  - `type WidgetSelection = { functionalLocationId?: string; directOnly: boolean }`, which is the dashboard's `nav` fields.
  - `chunk<T>(xs: readonly T[], n: number): T[][]`.
  - `useWidgetInstrumentIds(source: CustomWidget['source'], selection: WidgetSelection): { ids: string[]; loading: boolean }`:
    - `selection` mode → the overview rows' `instrumentId`s, in the overview's order (the same SWR key the readings table uses, so no extra request);
    - `instruments` mode → `source.ids`.
  - `useLatestValues(ids: readonly string[], keys: readonly DataKeyRef[]): { rows: LatestValuesRow[]; loading: boolean; error: unknown }`:
    - one SWR key;
    - a fetcher that POSTs each `chunk(ids, 200)` to `/api/instruments/latest-values` with `{ instrumentIds, keys: [{source, key}] }` and concatenates the `data` arrays;
    - `refreshInterval: overviewRefreshMs`;
    - no request when `ids` or `keys` is empty.
  - `useKeyCatalogue(selector: { instrumentIds: string[] } | { functionalLocationId: string; directOnly: boolean } | { all: true } | null): { keys: DataKeyInfo[]; loading: boolean }` → `GET /api/instruments/data-keys` with the matching query (Task 3).
  - `useWidgetHistory(ids: readonly string[], keys: readonly string[], range: { from: string; to: string }): { byInstrument: Map<string, { history: TelemetryLongRow[]; summaries: Record<string, { count: number; numericCount: number; min: number | null; max: number | null; avg: number | null }>; historySampled: boolean; historyTotal: number }>; loading: boolean }`:
    - one SWR key;
    - the fetcher GETs `/api/instruments/:id/telemetry?from&to&points=MAX_SERIES_POINTS&keys=` for each id, in parallel;
    - `refreshInterval: chartRefreshMs`.
  - `useWidgetTimeseries(ids, keys, range, page, pageSize): { rows: { instrumentId: string; ts: string; values: Record<string, unknown> }[]; total: number; loading: boolean }` → `GET /api/instruments/telemetry-history?instrumentIds=&keys=&from&to&limit&offset`.

- [ ] **Step 1: Write the failing tests** (mock `apiClient`; stable SWR objects; one file).
  - `300 ids → two latest-values requests, every row` (200 + 100; 300 rows out).
  - `no ids, no request`.
  - `selection mode takes the overview's ids in order`.
  - `the catalogue query for all, for a direct-only location and for ids` asserts the three URLs.
  - `history is one request per instrument with the keys filter`.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/routes/dashboard/widgets/__tests__/use-widget-data.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the signatures above.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(web): data hooks for dashboard widgets`.

---

### Task 6: Web — the layout hook edits widgets; the grid places them; a drag keeps card style

**Files:**
- Modify: `apps/web/src/hooks/use-dashboard-layout.ts`
- Create: `apps/web/src/hooks/__tests__/use-dashboard-layout.test.tsx`
- Modify: `apps/web/src/routes/dashboard/panel-auto-height.ts`:
  - an optional `auto` set parameter on `applyAutoHeights`, `keepStoredHeights` and `withResizeHandles`;
  - new `carryStoredFields` and `autoHeightIds`.
- Modify: `apps/web/src/routes/dashboard/__tests__/panel-auto-height.test.ts`
- Modify: `apps/web/src/routes/dashboard/panel-grid.tsx` (`autoIds?` and `editActions?` props)
- Modify: `apps/web/src/routes/dashboard/panel-card.tsx` (`menu?: ReactNode`, rendered in the header's right-hand group only while `editing`)
- Modify: `apps/web/src/routes/dashboard/index.tsx`

**Interfaces:**
- Consumes: from Task 1, `CustomWidget`, `widgetItemId`, `isWidgetItem`, `widgetIdOf` and `CUSTOM_WIDGETS_PANEL`.
- Produces, in `use-dashboard-layout.ts`:
  - The hook now also returns:
    - `widgets: CustomWidget[]`;
    - `addWidget(w: CustomWidget): void`;
    - `updateWidget(w: CustomWidget): void`;
    - `removeWidget(id: string): void`;
    - `saveAsRoleDefault(role: string, password?: string): Promise<void>`.
  - `addWidget` appends an item at the bottom with `w: 12` and `h` = 5 for `value_cards` or 9 for the other three.
  - `removeWidget` drops the widget and its item.
  - `save()` PUTs `{ layout: { version, items, widgets } }`.
  - `saveAsRoleDefault` PUTs the same layout to `/api/roles/dashboard-layout/role/:role`, through `apiClient.putWithReauth` when a password is given.
- Produces, in `panel-auto-height.ts`:
  - `autoHeightIds(widgets: readonly CustomWidget[]): ReadonlySet<string>` = `AUTO_HEIGHT_PANELS` ∪ the `w:` ids of every `latest_table` and `timeseries_table` widget.
  - `carryStoredFields(next, stored, auto?)` = `keepStoredHeights(next, stored, auto)` plus each stored item's `style`.

- [ ] **Step 1: Write the failing tests.**
  - In `panel-auto-height.test.ts`:
    - `a drag keeps the card's style`: `carryStoredFields([{i: 'telemetry_table', x: 0, y: 3, w: 6, h: 9}], [{i: 'telemetry_table', x: 0, y: 0, w: 12, h: 9, style: {tint: 'sky'}}])[0].style` `toEqual`s `{tint: 'sky'}`. This is RED today: `keepStoredHeights` spreads `next`, and `PanelGrid` hands back geometry only.
    - `table widgets follow their content`.
  - In `use-dashboard-layout.test.tsx`:
    - `add, edit and remove change the draft only, until Save`;
    - `Save sends widgets`;
    - `Cancel discards an added widget`;
    - `Save as role default PUTs the draft to that role`.
- [ ] **Step 2: Run** each file in its own process. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `index.tsx`:
    - uses `carryStoredFields(next, layout.items, autoIds)` in `onGridChange`;
    - passes `autoIds` to `PanelGrid` and `applyAutoHeights`;
    - renders a `w:` item through `<WidgetPanel>` (Task 7) only when `showPanel(CUSTOM_WIDGETS_PANEL)` and the widget is defined, and otherwise as `<div key={it.i} />`.
  - `PanelGrid`'s `editActions` sits in the edit-controls row, and only `index.tsx` passes it, as SUPER_ADMIN: **Add widget** and **Save as role default**. The dialogs come from Task 8; until then, render the two buttons, wired to state.
- [ ] **Step 4: Run** `panel-auto-height.test.ts`, `use-dashboard-layout.test.tsx`, `panel-card-auto-height.test.tsx`, `panel-grid-height.test.tsx`, `view-panels.test.ts`, `hooks/__tests__/use-panels.test.ts` and `hooks/__tests__/reauth-callers-declare-cancel.test.ts`, one at a time. All PASS. Then run `cd apps/web && npx tsc --noEmit` → exit 0.
- [ ] **Step 5: Commit** `feat(web): the dashboard layout holds widgets; a drag keeps card style`.

---

### Task 7: Web — the four widget renderers

**Files:**
- Create: `apps/web/src/routes/dashboard/widgets/widget-panel.tsx` (`WidgetPanel`, `WidgetBody`)
- Create: `apps/web/src/routes/dashboard/widgets/value-cards-widget.tsx`
- Create: `apps/web/src/routes/dashboard/widgets/latest-table-widget.tsx`
- Create: `apps/web/src/routes/dashboard/widgets/trend-chart-widget.tsx`
- Create: `apps/web/src/routes/dashboard/widgets/timeseries-table-widget.tsx`
- Create: `apps/web/src/routes/dashboard/widgets/__tests__/widget-renderers.test.tsx`

**Interfaces:**
- Consumes:
  - Task 4: `keyCell`, `formatKeyValue`, `decimalsSeen`, `quantityVerdict`.
  - Task 5: every hook.
  - Existing: `PanelCard`, `TimeSeriesChart` (`variant="trend"`) with `seriesColor`, `SampledNote`, `useDatetimeFormat`, `useSensorWords`, and `PERIOD_PRESETS` / `resolvePeriod` / `DEFAULT_PERIOD`.
- Produces:
  - `WidgetBody({ widget, selection }: { widget: CustomWidget; selection: WidgetSelection })`, which renders the type's body. It is also the dialog's preview.
  - `WidgetPanel({ widget, item, selection, editing, onEdit, onRemove, onStyleChange, onSizeChange, autoHeight, onNaturalHeight })`:
    - a `PanelCard` with `title = widget.title`;
    - the eyebrow is `Value cards`, `Latest values`, `Trend` or `Time series`;
    - `menu` holds the Edit and Remove buttons while editing.
- Behaviour (spec §6.2), exactly:
  - **Value cards.**
    - One card per (instrument, key), in source order then key order, at most `VALUE_CARDS_SHOWN_MAX`. Over the cap the widget prints `Showing 60 of N cards`.
    - Each card shows: the label (`key.label ??` the key), `text` + `unit`, the instant through `useDatetimeFormat`, the instrument code and `locationAttribute`, and the status word on `classes`.
  - **Latest values table.**
    - `.tbl-grid`, with columns `Instrument ID`, `Area` (`functionalLocationName`), `Location` (`locationAttribute`), then one per key.
    - Each cell shows `text unit` and a small status pill (`classes`, `label`).
    - A search box filters on every visible column.
    - Paging is on screen at `options.pageSize ?? 25`, with the true total.
  - **Trend chart.**
    - Series = (instrument × telemetry key), in source then key order, at most `TREND_SERIES_MAX`, with `Showing 10 of N series` over the cap.
    - Points are the numeric readings only (`coerceReading`).
    - Series decimals: a measured key takes the server's `decimals` from `useLatestValues`. A raw key takes `key.decimals ?? decimalsSeen(points)`.
    - Colour is `seriesColor(key.color ?? index)`.
    - The label is `${code} · ${key.label ?? key.key}`.
    - Limit lines are drawn ONLY when every series is measured with identical `limitMin` / `limitMax`.
    - `unit` is passed only when every series shares one unit.
    - A strip under the chart gives Current / Min / Max / Average per series, from `summaries[key]`, at the series decimals.
    - `N text readings not plotted` appears when Σ(`count − numericCount`) > 0.
    - `SampledNote` appears when any instrument is `historySampled`.
    - A period `<select>` (local state, default `options.period ?? DEFAULT_PERIOD`) and zoom (`onZoom` / `onResetZoom`, local) both refetch.
  - **Time series table.**
    - Queries the first `WIDGET_INSTRUMENTS_MAX` ids (`Showing 50 of N instruments` over the cap) at `options.pageSize ?? 25` per page, server-paged, newest first.
    - Columns: `Time`, `Instrument ID`, then one per key.
    - A measured cell is at the server's decimals for that instrument and key (from `useLatestValues`). A raw cell is as received, or at `key.decimals`.
    - It has the same period `<select>`.
  - **Every type:** no ids in the response → `No instruments in your view`; loading → the existing skeleton or `Loading…`; error → `Could not load this widget.`

- [ ] **Step 1: Write the failing tests** in `widget-renderers.test.tsx` (hooks mocked with stable objects):
  - `value cards: measured key in limit is green, raw key is grey and says Not judged`;
  - `value cards say how many they did not draw` (61 cards → `Showing 60 of 61 cards`);
  - `instruments missing from the response are not drawn`;
  - `none in view prints No instruments in your view`;
  - `latest table: one row per instrument, one column per key, search narrows rows`;
  - `trend chart: limit lines only when every series shares measured bounds`;
  - `trend chart: says how many text readings it could not plot`;
  - `trend chart: 12 series → Showing 10 of 12 series`;
  - `time series table: measured cell at server decimals, raw as received`.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/routes/dashboard/widgets/__tests__/widget-renderers.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the five files.
- [ ] **Step 4: Run** → PASS; `npx tsc --noEmit` → exit 0. Mutation check: make `keyCell` return `statusClasses('OK')` for a raw key → `a raw key never renders green` (Task 4) and the value-cards test both fail. Restore from the backup copy.
- [ ] **Step 5: Commit** `feat(web): value cards, latest values table, trend chart and time series widgets`.

---

### Task 8: Web — Add / Edit widget dialog, key picker, Save as role default

**Files:**
- Create: `apps/web/src/routes/dashboard/widgets/key-picker.tsx`
- Create: `apps/web/src/routes/dashboard/widgets/widget-dialog.tsx`
- Create: `apps/web/src/routes/dashboard/widgets/role-default-dialog.tsx`
- Create: `apps/web/src/routes/dashboard/widgets/__tests__/widget-dialog.test.tsx`
- Modify: `apps/web/src/routes/dashboard/index.tsx` (wire the two dialogs to the Task 6 buttons and to each widget's Edit)

**Interfaces:**
- Consumes:
  - `useKeyCatalogue` (Task 5);
  - `useHistoryScope()` (`routes/data-report/use-history-scope.ts`) for the Block → Area → instrument tick list;
  - `customWidgetSchema`;
  - `WidgetBody` (Task 7);
  - `useReauth()`;
  - `GET /api/roles` (the roles list Roles & Access reads).
- Produces:
  - `KeyPicker({ catalogue, chosen, onChange, type }: { catalogue: DataKeyInfo[]; chosen: WidgetKey[]; onChange: (k: WidgetKey[]) => void; type: WidgetType })`:
    - two groups, `Time series` and `Attributes`, with a search box;
    - each row shows the label, the key (mono), the kind (`number` / `text` / `attribute`), last seen, and a `Measured · <measurement name>` badge;
    - on `trend_chart`, an attribute row is disabled with `Attributes have no history to plot`, and a `numeric: false` telemetry row is enabled with the amber hint `No numeric reading lately`;
    - at most `WIDGET_KEYS_MAX` can be chosen.
  - `WidgetDialog({ open, initial, selection, onCancel, onSubmit }: { open: boolean; initial?: CustomWidget; selection: WidgetSelection; onCancel: () => void; onSubmit: (w: CustomWidget) => void })` has four steps:
    1. Type (four tiles).
    2. Instruments: `Follow the dashboard selection` or `Pick instruments` (≤ 50).
    3. Keys (`KeyPicker`), where the catalogue selector is the selection → `{ functionalLocationId, directOnly }`, or `{ all: true }` when none, or else `{ instrumentIds }`.
    4. Display: title, and per key the label, colour (six swatches), and unit + decimals for RAW keys only (a key is measured when the catalogue's `measurement !== null`).

    A live preview (`WidgetBody` over the draft) sits under the steps. Submit validates with `customWidgetSchema.safeParse` and shows the first issue's message. A new widget gets `crypto.randomUUID()`.
  - `RoleDefaultDialog({ open, onClose, onSave }: { open: boolean; onClose: () => void; onSave: (role: string, password?: string) => Promise<void> })`:
    - a role `<select>` that excludes `SUPER_ADMIN`;
    - the sentence `Every user of this role sees this arrangement, and its built widgets wherever their Panels include Built widgets.`;
    - Save runs `reauth.execute('UPDATE_ROLE_CONFIG', …, { onSuccess, onError, onCancel })`.

- [ ] **Step 1: Write the failing tests** in `widget-dialog.test.tsx`:
  - `the dialog produces the widget JSON it shows` (choose Value cards → selection → `t` + `Location` → label "Temp" → submit; `onSubmit` gets the exact object, and it passes `customWidgetSchema`);
  - `the catalogue shows Time series and Attributes groups with the Measured badge`;
  - `an attribute key is refused for a trend chart; a text telemetry key is warned, not refused`;
  - `unit and decimals are offered for a raw key only`;
  - `Save as role default asks for re-auth and declares onCancel`;
  - `Add widget and Save as role default exist only for a SUPER_ADMIN` (render `DashboardPage` with a SUPER_ADMIN and with an OPERATOR; the OPERATOR has no Arrange and no widget controls).
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/routes/dashboard/widgets/__tests__/widget-dialog.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS. Then run `hooks/__tests__/reauth-callers-declare-cancel.test.ts` (PASS) and `npx tsc --noEmit` and `npm run lint` in `apps/web` (exit 0).
- [ ] **Step 5: Commit** `feat(web): add, edit and share dashboard widgets`.

---

### Task 9: See it, document it, gate it

**Files:**
- Modify: `CHANGELOG.md` (new entry at the top);
- Modify: `docs/feature-notes.md` (the WIDGET DATA KEYS note gains its phase 2 paragraph);
- Modify: root `CLAUDE.md` (the Topics line wording, if needed), `apps/web/CLAUDE.md` and `apps/api/CLAUDE.md` (dated entries), `packages/shared/CLAUDE.md` (type files 35 → 36);
- Modify: `docs/recreation/06-api/endpoints.md` (the layout PUT rows: `widgets`, 403);
- Modify: `tasks/todo.md`.

- [ ] **Step 1: Render check.**
  - Render each of the four widgets with representative data (measured in limit, measured out, raw number, text, offline, fault) to static HTML in jsdom, using the method in the `tailwind-v4-cascade-layers` memory.
  - Load that HTML with the BUILT stylesheet (`cd apps/web && npx vite build`) in headless Chrome at 1240 × 880, with an isolated `--user-data-dir`.
  - Screenshot each one and look at it. Check:
    - the longest label in the narrowest card;
    - that nothing raw is green;
    - that NA and the fault word appear without a unit;
    - that the dialog opens at 1240 width.
  - Fix what looks wrong in the same pass.
- [ ] **Step 2: Suites.**
  - Run the full API suite single-fork (`cd apps/api && npm test`, exit 0).
  - Run the full shared suite (exit 0).
  - Run every web test file under `routes/dashboard`, `routes/instruments`, `hooks` and `routes/config`, ONE file per process, each exit 0.
  - Run `npm run lint` in api, web and shared (exit 0).
  - If the laptop kills a run for memory, say so. Do not count it as passed.
- [ ] **Step 3: Docs.**
  - Write the CHANGELOG and feature-note text, listing the rulings and the counts that moved.
  - Fix the spec's §6.1 sentence "any that does keeps it whole and meets the role's widgets after Reset" to describe what was built instead: Ruling P2-2.
  - Do a stale-count sweep for `35` type files.
- [ ] **Step 4: Commit** `docs: widget data keys phase 2 (dashboard widgets)`.
- [ ] **Step 5: Final whole-branch review** by a fresh reviewer on the most capable model, then ONE fix pass, with each fix done RED → GREEN.

## Rulings made in this plan

- **P2-1:** `numeric` is a hint. Only attribute keys are refused for a trend chart; spec §4 wins over §6.2/§6.3. Cost if wrong: a chart over a key that never sends a number plots nothing, but says so.
- **P2-2:** a non-super-admin with their own layout gets the ROLE's widgets, appended below their panels. The spec assumed they could Reset, but Arrange is SUPER_ADMIN-only. Cost if wrong: their widgets sit at the bottom, not where the super admin put them.
- **P2-3:** an omitted `widgets` key on either PUT keeps what is stored. Cost if wrong: a deliberate "remove every widget" must send `widgets: []`.
- **P2-4:** a selection of more than 200 instruments is batched for latest-values. The catalogue gains `all=true` and `functionalLocationDirect=true` rather than being merged in the browser. Cost if wrong: two query parameters to maintain.
- **P2-5:** one `KeyRef` per device key; a "Temperature" card over a mixed-profile Block lists each device key. This settles Phase 1's open ruling. Cost if wrong: the picker shows `t` and `temperature` as two rows.
- **P2-6:** the period and zoom chosen on a chart or table widget are session state. Only the default period is stored. Cost if wrong: a viewer's chosen period resets on reload.
- **P2-7:** a raw chart axis without widget decimals uses `decimalsSeen` (the most digits actually received). Cost if wrong: an axis label shows one digit more than a reader expects.
