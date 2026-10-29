# Widget Data Keys — Phase 3 (trend page extra keys, per profile) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A SUPER_ADMIN picks, per instrument PROFILE, extra telemetry keys the instrument trend page shows beside temperature and humidity. Each extra key appears as a value card, a chart card (if numeric) and a Time Series column, on every instrument of that profile.

**Architecture:**
- **Storage.** `instrument_profiles.display_keys` (JSONB, nullable) holds up to 12 widget keys: the Phase 2 `widgetKeySchema` restricted to telemetry. One shared schema validates it, and one forgiving reader reads it.
- **Server.** `PUT /api/instrument-profiles/:id/display-keys` (SUPER_ADMIN, re-auth `UPDATE_INSTRUMENT_PROFILE`, audited `INSTRUMENT_PROFILE_UPDATED`) writes it. The profile GET returns it.
- **Trend page.** The page reads it from the profile it already belongs to, values from Phase 1's `latest-values`, and history from the chart and table responses it already fetches (they carry every key). It reuses Phase 2's `KeyPicker`, `keyCell` and `useLatestValues`.

**Tech Stack:**
- Prisma 6 (one hand-authored migration).
- Fastify 5.
- `@digilog/shared` zod.
- React 19 + SWR.
- vitest.

**Spec:** `docs/superpowers/specs/2026-10-28-widget-data-keys-design.md` §7 (and §4 for the measured/raw rules). Phase 2 plan and ledger: `docs/superpowers/plans/2026-10-28-widget-data-keys-phase2.md`, `.superpowers/sdd/2026-10-28-widget-data-keys-phase2/progress.md`.

## Global Constraints

- **Writes.** Only a SUPER_ADMIN writes display keys: 403 `SUPER_ADMIN_ONLY`, behind `INSTRUMENT_UPDATE`. Re-auth is `UPDATE_INSTRUMENT_PROFILE`, which exists and ships OFF. Audit is `INSTRUMENT_PROFILE_UPDATED` with `beforeValue` / `afterValue` `{ displayKeys }`, written in the same transaction. An unchanged list is a 200 with no write and no audit row.
- **Keys are telemetry only** (ruling P3-1). The page is about readings, and an attribute has no history to chart or list. Caps:
  - at most 12 keys (`PROFILE_DISPLAY_KEYS_MAX`);
  - no duplicate key;
  - the per-key display settings are Phase 2's: label ≤ 60, unit ≤ 16, decimals 0–6, colour index 0–5.
- **One reader.** `coerceProfileDisplayKeys(v)` is forgiving: a non-array reads as `[]`, a bad entry is dropped, the first of a duplicate is kept, and at most 12 survive. A corrupted row must never break the trend page. The PUT is strict (zod → 400).
- **Fastify strips undeclared fields.** `displayKeys` and each of its inner keys (`source`, `key`, `label`, `unit`, `decimals`, `color`) are declared in `profileProps`. Mutation-check by deleting the declaration.
- **Measured vs raw is the server's answer.** `LatestKeyValue.judged !== null` decides it, and `keyCell` (Phase 2, `routes/dashboard/widgets/key-value.ts`) renders it.
  - Raw: never a status colour, printed as received unless the key sets decimals, no limit lines.
  - Measured: the server's unit, decimals and bounds.
- **What the picker refuses:**
  - keys this page already draws: the catalogue entries whose `measurement.code` is `TEMPERATURE` or `HUMIDITY`, refused with the reason `Already on this page as <name>`;
  - attribute keys, with the reason `Attributes have no history to plot` (KeyPicker's `trend_chart` rule).
- **Panels.** Extra value cards render under the `trend_gauges` panel, extra chart cards under `trend_charts`, and extra columns under `trend_historian_table`. No new panel key.
- **PDFs are unchanged.** The Data Report and Instrument Trend PDF print temperature and humidity only; that is Phase 4. An extra chart card has no download icon.
- **The dead request goes.** The `telemetry-keys` request in `trend.tsx` is replaced by the picker's catalogue: `GET /api/instruments/data-keys?instrumentIds=<id>`, which is the same server information in the picker's format.
- **Counts.**
  - Migrations +1, routes +1 (`PUT /api/instrument-profiles/:id/display-keys`), shared type files 36 → 37 (`profile-display-keys.ts`).
  - No model, enum, permission, re-auth action, audit action, panel, sidebar item, config def or config page.
- **Migration.** Hand-authored, `ADD COLUMN` only. If Prisma emits the partitioned `DROP TABLE instrument_telemetry_history`, strip it; the migration guard enforces this. Apply to `compliance_core_db` AND `compliance_core_db_test`, with `DATABASE_URL` passed explicitly every time. Run `prisma generate`; if it EPERMs because the operator's `tsx watch` holds the engine, STOP and ask (never kill their process unasked).
- **Tests.**
  - API: one file at a time, single-fork, judged by exit code; each e2e file owns its profile and users and restores what it touched FIRST.
  - Web: one file per process, judged by exit code, with stable mock objects.
- **Copy.**
  - Pencil label: `Keys`.
  - Dialog title: `Extra keys on the trend page`.
  - Applies-to line: `Applies to all <n> instruments of <profile name>` (n = the profile's `instrumentCount`).
  - Empty catalogue: `This instrument has sent no other keys yet.`

## Review Focus

1. **A display key the instrument never sent** (another instrument of the profile sends it). The value card reads `NA`, the chart card says `No readings in this period.`, and the column holds `—`. None of them errors. Task 3 test: `a key this instrument never sent reads NA`.
2. **A text key (`state` = `RUN`) as an extra key.** The value card shows `RUN`, neutral. There is no chart card, or a chart card stating `N text readings not plotted`. The column shows `RUN`, never the failure word. Task 2 test: `a text value is printed, not called a sensor error`.
3. **A corrupted `display_keys` value** (written by hand). The trend page renders as before with no extra keys, and the profile GET still answers 200. Task 1 test: `a stored value that is not a list reads as none`.
4. **A non-super-admin, or the stale-browser case.** The pencil is hidden for every role but SUPER_ADMIN, and the PUT refuses with 403 even with `INSTRUMENT_UPDATE`. Task 1 test (API) and Task 4 test (pencil hidden).
5. **A measured extra key with no bound in force** reads `Not assessed`, neutral (Phase 2 fix I1 applies via `keyCell`), and draws no limit lines. Task 2 test.

---

### Task 1: Shared contract, migration, API (GET carries it; PUT writes it)

**Files:**
- Create: `packages/shared/src/types/profile-display-keys.ts`, `packages/shared/src/types/profile-display-keys.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/api/prisma/schema.prisma` (`InstrumentProfile.displayKeys Json? @map("display_keys")`, with a doc comment)
- Create: `apps/api/prisma/migrations/20261029120000_profile_display_keys/migration.sql`
- Modify: `apps/api/src/modules/instrument-profiles/routes.ts`: `profileProps.displayKeys`, `ProfileRow.displayKeys`, `present()`, and the new `PUT /:id/display-keys`
- Create: `apps/api/src/e2e/profile-display-keys.e2e.test.ts`

**Interfaces:**
- Produces (shared):
  - `PROFILE_DISPLAY_KEYS_MAX = 12`.
  - `profileDisplayKeySchema`: `widgetKeySchema` with `source` refined to `'telemetry'`; the message is `The trend page shows readings — an attribute has no history`.
  - `profileDisplayKeysSchema`: an array of up to 12, with no duplicate `key`.
  - `coerceProfileDisplayKeys(v: unknown): WidgetKey[]`.
  - `displayKeysEqual(a, b): boolean`, by canonical JSON, the `widgetsEqual` way.
- Produces (API):
  - `GET /api/instrument-profiles/:id` and the list return `displayKeys: WidgetKey[]` (always an array).
  - `PUT /api/instrument-profiles/:id/display-keys`, body `{ displayKeys: WidgetKey[], reason?: string }` → 200 with the profile. The errors are 400 `VALIDATION_ERROR`, 403 `SUPER_ADMIN_ONLY` and 404.

- [ ] **Step 1: Write the failing tests.**
  - Shared, in `profile-display-keys.test.ts`:
    - the schema accepts 12 telemetry keys with every display setting;
    - it refuses an attribute (the message above), 13 keys, and a duplicate `p`;
    - `coerceProfileDisplayKeys(null)`, `('x')` and `({})` are all `[]`;
    - a list with one bad entry keeps the good ones;
    - `displayKeysEqual` ignores object-key order.
  - E2e, in `profile-display-keys.e2e.test.ts`. It owns a profile `fixture:profile-display-keys` and a non-SA role holding `INSTRUMENT_UPDATE`. Cases:
    1. `a super admin's keys round-trip through the profile GET, inner keys included`.
    2. `an attribute key or 13 keys is a 400 and nothing is stored`.
    3. `a non-super-admin with Instrument Update gets 403`.
    4. `saving the same keys writes no audit row; a change writes one INSTRUMENT_PROFILE_UPDATED with before and after`.
    5. `a stored value that is not a list reads as none` (`UPDATE instrument_profiles SET display_keys = '"x"'::jsonb` → GET 200 with `displayKeys: []`).
    6. `the list route carries displayKeys too`.
- [ ] **Step 2: Run** `cd packages/shared && npx vitest run src/types/profile-display-keys.test.ts`, then (after the migration) `cd apps/api && npx vitest run src/e2e/profile-display-keys.e2e.test.ts --pool=forks --poolOptions.forks.singleFork=true`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Migration SQL: `ALTER TABLE "instrument_profiles" ADD COLUMN "display_keys" JSONB;`.
  - Apply with `npx prisma migrate deploy`, once per database with an explicit `DATABASE_URL`, then run `npx prisma generate`.
  - The PUT order is: SA check → `enforceReauth` → zod → load the row (404) → equal ⇒ return unchanged → `$transaction`(update + `auditLog(entry, tx)`).
  - `signatureMeaning` is `Profile "<name ≤60>" trend-page keys set: <n> key(s)`. `reason` is optional and recorded when given.
  - `present()` returns `coerceProfileDisplayKeys(row.displayKeys)`.
- [ ] **Step 4: Run** both files → PASS. Then run `src/e2e/instrument-profiles.e2e.test.ts`, `npm run lint` (api), `npm run build -w @digilog/shared`, `npm run check:migrations` → all exit 0.
- [ ] **Step 5: Mutation-check** (restore from a backup copy):
  - delete `displayKeys` from `profileProps` → case 1 fails;
  - delete the SA check → case 3 fails;
  - delete the equality short-circuit → case 4 fails.
- [ ] **Step 6: Commit** `feat(profiles): per-profile trend-page display keys (phase 3)`.

---

### Task 2: Web components for an extra key

**Files:**
- Create: `apps/web/src/routes/instruments/extra-key-card.tsx` (`ExtraKeyCard`)
- Modify: `apps/web/src/routes/instruments/trend-chart-card.tsx` (`onExportPdf?` optional: no export icon when absent)
- Modify: `apps/web/src/routes/instruments/timeseries-table-card.tsx` (optional `extraColumns`)
- Create: `apps/web/src/routes/instruments/__tests__/extra-keys.test.tsx`
- Must stay green unedited: `trend-chart-card.test.tsx`, the Time Series card's existing tests

**Interfaces:**
- Consumes: Phase 2's `keyCell`, `formatKeyValue`, `decimalsSeen` and `UNJUDGED_CLASSES`.
- Produces:
  - `ExtraKeyCard({ widgetKey, value, reporting, words, formatTs })`, where `value: LatestKeyValue | undefined`. It renders:
    - the label (`widgetKey.label ?? widgetKey.key`);
    - `keyCell` text + unit and the status word on its classes;
    - the instant, or `—`;
    - `data-testid="extra-key-card"` and `data-judged`.
  - `ExtraColumn = { key: string; heading: string; cell: (raw: unknown) => { text: string; tone: PillTone } }`.
  - `TimeseriesTableCardProps.extraColumns?: ExtraColumn[]` and `extraRaw?: (ts: string, key: string) => unknown`. Each extra column renders `cell(extraRaw(row.ts, key))`: `—` when the raw value is `undefined` or `null`, else a pill in `PILL_CLASS[tone]`. It never uses `failureWord`. Row tone is unchanged: it is still decided by the slot columns only.
  - `extraColumnCell(v: LatestKeyValue | undefined, widgetKey: WidgetKey): (raw: unknown) => { text: string; tone: PillTone }` (in `extra-key-card.tsx`):
    - Measured with bounds: `pillTone` against `judged.limitMin` / `judged.limitMax`, text at the server's decimals.
    - Otherwise `unjudged`, text as `formatKeyValue` prints the raw value.

- [ ] **Step 1: Write the failing tests** in `extra-keys.test.tsx`:
  - `a raw extra key is neutral and printed as received` (`0.05`; every class differs from `statusClasses('OK')`);
  - `a measured extra key wears the server's verdict and decimals`;
  - `a measured extra key with no bound in force reads Not assessed, neutral`;
  - `a text value is printed, not called a sensor error` (column cell for `RUN` is `RUN`, tone `unjudged`; card shows `RUN`);
  - `an extra column shows — where the instant has no value`;
  - `a chart card without onExportPdf has no export icon`.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/routes/instruments/__tests__/extra-keys.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new file, `trend-chart-card.test.tsx`, `trend-chart-strip.test.tsx` and every `timeseries*` test under `routes/instruments/__tests__`, one at a time → all PASS. Then run `npx tsc --noEmit` → exit 0.
- [ ] **Step 5: Commit** `feat(web): an extra key's value card, chart card and table column`.

---

### Task 3: The trend page draws the profile's extra keys

**Files:**
- Modify: `apps/web/src/routes/instruments/trend.tsx`
- Modify: `apps/web/src/routes/instruments/use-trend-data.ts` (`TelemetrySummary` gains `numericCount: number`, already on the wire)
- Create: `apps/web/src/routes/instruments/__tests__/trend-extra-keys.test.tsx`

**Interfaces:**
- Consumes:
  - Task 1's GET (`displayKeys`, `name`, `instrumentCount`) via `useSWR('/api/instrument-profiles/<inst.profileId>')`;
  - Phase 2's `useLatestValues([id], displayKeys)`;
  - Task 2's components.
- Behaviour:
  - **Value cards.** After the two band gauges (inside `showPanel('trend_gauges')`), one `ExtraKeyCard` per display key, in a grid of the same width.
  - **Chart cards.** One `TrendChartCard` per display key (inside `showPanel('trend_charts')`, after the two):
    - points = `trend.chartRows` for that key, numbers only (`coerceReading`);
    - series colour = `seriesColor(key.color ?? n + 2)`;
    - decimals = server (measured) or `key.decimals ?? decimalsSeen(points)`;
    - limit lines only when measured with bounds;
    - `N text readings not plotted` from `summaries[key].count − numericCount`;
    - status = `keyCell`'s status for a measured key, `null` for raw;
    - no `onExportPdf`.
  - **Time Series columns.**
    - `tableRows` are built with `keys = [tempKey, humidKey, ...displayKeys]`, so an instant holding only an extra key still appears.
    - `extraColumns` come from `extraColumnCell`.
    - `extraRaw` looks up the RAW value in `trend.tableRows` by `ts` and `key`.
    - The heading is `label (unit)` when a unit is known (server unit for measured, `key.unit` for raw), else the label.
  - The `telemetry-keys` request is DELETED.
- [ ] **Step 1: Write the failing tests** in `trend-extra-keys.test.tsx`, mounting `InstrumentTrend` with every hook mocked stably, following `trend-widget-labels.test.tsx`'s harness:
  - `the profile's extra keys appear as cards, charts and columns` (one numeric raw key `p`, one measured key);
  - `a key this instrument never sent reads NA`;
  - `no displayKeys renders the page exactly as before` (no `extra-key-card`, two chart cards);
  - `the panels still govern them` (`trend_charts` hidden → no extra chart card);
  - `the page no longer asks for telemetry-keys` (no `useSWR` key containing `telemetry-keys`).
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/routes/instruments/__tests__/trend-extra-keys.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** every test file under `routes/instruments/__tests__` whose name starts with `trend`, plus `band-gauge.test.tsx`, one at a time → all PASS. Then run `npx tsc --noEmit` → exit 0.
- [ ] **Step 5: Commit** `feat(web): the trend page shows its profile's extra keys`.

---

### Task 4: The Keys pencil and dialog (SUPER_ADMIN)

**Files:**
- Create: `apps/web/src/routes/instruments/display-keys-dialog.tsx`
- Modify: `apps/web/src/routes/dashboard/widgets/widget-dialog.tsx` (extract the per-key Display rows into `apps/web/src/routes/dashboard/widgets/key-display-rows.tsx`, used by both dialogs; Phase 2's `widget-dialog.test.tsx` must stay green unedited)
- Modify: `apps/web/src/routes/dashboard/widgets/key-picker.tsx` (optional `refuse?: (e: DataKeyInfo) => string | undefined`, an extra per-entry refusal reason)
- Modify: `apps/web/src/routes/instruments/trend.tsx` (the pencil, beside the period controls, `user?.role === 'SUPER_ADMIN'` only)
- Create: `apps/web/src/routes/instruments/__tests__/display-keys-dialog.test.tsx`

**Interfaces:**
- Produces: `DisplayKeysDialog({ open, instrumentId, profile: { id, name, instrumentCount, displayKeys }, onClose, onSaved })`. It is a `KeyPicker` over `useKeyCatalogue({ instrumentIds: [instrumentId] })` with `type="trend_chart"` and `refuse` = the TEMPERATURE / HUMIDITY rule, plus `KeyDisplayRows`. It says `Applies to all <n> instruments of <name>`.
  - Save runs `reauth.execute('UPDATE_INSTRUMENT_PROFILE', …, { onSuccess, onError, onCancel })` → `PUT /api/instrument-profiles/<id>/display-keys` (`putWithReauth` when a password is given), then `onSaved()` (which revalidates the profile key).
  - The busy flag is cleared only by the three outcomes.
- [ ] **Step 1: Write the failing tests** in `display-keys-dialog.test.tsx`:
  - `it says which instruments it applies to`;
  - `a key already on the page is refused with its reason`;
  - `an attribute is refused`;
  - `Save PUTs the chosen keys with re-auth and declares onCancel`;
  - `the pencil is shown to a SUPER_ADMIN only` (mount the trend page twice, as in Task 3's harness).
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/routes/instruments/__tests__/display-keys-dialog.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new file, `widget-dialog.test.tsx`, `trend-extra-keys.test.tsx` and `hooks/__tests__/reauth-callers-declare-cancel.test.ts`, one at a time → all PASS. Then run `npx tsc --noEmit` and `npm run lint` (web) → exit 0.
- [ ] **Step 5: Commit** `feat(web): a super admin picks the trend page's extra keys per profile`.

---

### Task 5: See it, document it, gate it

- [ ] **Step 1: Render check.**
  - Dump the trend page (Task 3's harness, with a measured key, a raw numeric key, a text key and a key never sent) and the dialog to HTML.
  - Screenshot them with the BUILT stylesheet in headless Chrome at 1240 wide, with `--virtual-time-budget`, and look at them.
  - Fix what is wrong, RED → GREEN. Delete the throwaway dump test.
- [ ] **Step 2: Docs.**
  - `CHANGELOG.md`;
  - `docs/feature-notes.md`: the phase 3 paragraph, and correct the stale "per-user extra keys in `localStorage`" line in the Instrument trend page note;
  - root `CLAUDE.md` (Topics wording; migrations; System Stats unchanged because no model or enum moved);
  - `apps/api/CLAUDE.md`, `apps/web/CLAUDE.md`, `packages/shared/CLAUDE.md` (36 → 37);
  - `docs/recreation/06-api/endpoints.md` (the PUT row; the profile GET gains `displayKeys`);
  - `tasks/todo.md`.
- [ ] **Step 3: Suites.**
  - Full API suite single-fork (exit 0) and the full shared suite.
  - Every web test file under `routes/instruments`, `routes/dashboard`, `hooks`, one per process (each exit 0).
  - Lint in all three packages.
- [ ] **Step 4: Commit** `docs: widget data keys phase 3 (trend page extra keys)`.
- [ ] **Step 5: Final whole-branch review** (fresh reviewer, most capable model), then ONE fix pass, each fix RED → GREEN.

## Rulings made in this plan

- **P3-1:** extra keys are TELEMETRY only. The trend page is about readings, and an attribute has no history to chart or list (attributes stay on the detail and Settings pages). Cost if wrong: a firmware version cannot be pinned to the trend page.
- **P3-2:** the profile's keys ride on the existing profile GET (`INSTRUMENT_READ`, visibility-scoped counts). There is no separate read route. Cost if wrong: the trend page fetches the profile once more.
- **P3-3:** the two keys the page already draws (resolved TEMPERATURE / HUMIDITY) are refused in the picker. Cost if wrong: a super admin cannot duplicate a gauge as a plain card.
- **P3-4:** `reason` is optional on the display-keys PUT. These keys are display configuration, not a measurement or limit change; the change is audited with before and after either way. Cost if wrong: an auditor sees a change without a stated reason.
- **P3-5:** an extra column never uses the sensor-failure word. A text reading is shown as received; whether a raw key's text is a fault is not something the page knows. Cost if wrong: an `NA` from a raw probe reads `NA`, not `Error`.
