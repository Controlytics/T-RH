# Widget Data Keys — Phase 1 (server: key catalogue and values) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The server can list every key a set of instruments has sent or carries, return each key's latest value with the server's own unit / decimals / bounds for a measured key, and return history for a chosen subset of keys — with no configuration step for a new key.

**Architecture:** One new pure-ish module `modules/instruments/data-keys.ts` (catalogue + latest-values builders) behind one new child plugin `data-keys-routes.ts` of the instruments routes. Keys come from `instrument_telemetry_latest` (one row per instrument/key) and `instrument_attributes`; a measured key's bounds and fault flags come from `buildTelemetryOverview()` (the ONE resolver), never re-resolved. The two existing history routes gain a `keys` filter.

**Tech Stack:** Fastify 5, Prisma 6 raw SQL on PostgreSQL 18, zod (in `@digilog/shared`), vitest e2e over `app.inject`.

**Spec:** `docs/superpowers/specs/2026-10-28-widget-data-keys-design.md` (§4, §5, §10)

## Global Constraints

- Visibility is applied to the instrument id set BEFORE anything is read; an out-of-scope instrument is absent, never a 403 (`resolveVisibility` + `withVisibility`).
- Every route `INSTRUMENT_READ`.
- Every response field is DECLARED in the route's response schema (Fastify strips undeclared fields silently); objects of arbitrary keys need `additionalProperties`.
- A quoted number is a number: `NUMERIC_READING` (SQL) / `coerceReading` (TS). Never `value_type`.
- Raw key → `unit: null`, `decimals: null` (print as received), `judged: null`. `TELEMETRY_DECIMALS_FALLBACK` is never applied to a raw key.
- Measured key → decimals = `OverviewRow.decimals[slot]`, unit = the measurement type's unit, bounds/fault flags from the `OverviewRow`.
- Offset attribute keys are SUPER_ADMIN-only: absent (not masked) for anyone else — `offsetKeyTest()`.
- Caps: ≤ 200 instruments, ≤ 20 keys per request; key length ≤ 128.
- Every e2e file owns its fixture profile (`fixtureProfileId('fixture:<file>')`), seeds instants near now (partitions), restores any config/role it touches FIRST in `afterAll`.
- API tests run serially: `npx vitest run <file> --pool=forks --poolOptions.forks.singleFork=true`, judged by exit code.

## Review Focus

1. **Gateway-quoted readings** (`"21.5"`) must count as numeric in the catalogue — owned by Task 2 (test `quoted numbers are numeric`).
2. **Key case** — a device sending `T` on a profile whose alias is `t` is still measured; the catalogue keeps `T` exactly as stored — Task 3 (test `alias match folds case`).
3. **Offset attributes leaking** through the catalogue or latest-values to a non-super-admin — Tasks 2 and 3 (tests `offset keys are absent for a non-super-admin`).
4. **Two alias keys on one instrument** (`t` and `temperature`) — only the one the overview RESOLVED is judged; the other is raw — Task 3 (test `only the resolved alias is judged`).
5. **An empty or wholly out-of-scope id list** returns `200` with `data: []` — never 400, never everything — Tasks 2 and 3.

---

### Task 1: Shared contract — `@digilog/shared` data-key types and schemas

**Files:**
- Create: `packages/shared/src/types/data-keys.ts`
- Create: `packages/shared/src/types/data-keys.test.ts`
- Modify: `packages/shared/src/index.ts` (export block beside `profile-measurements`)

**Interfaces:**
- Produces (exact names, used by Tasks 2–4 and Phase 2):
  - `DATA_KEY_SOURCES = ['telemetry', 'attribute'] as const`; `type DataKeySource`
  - `DATA_KEY_MAX = 128`, `DATA_KEYS_INSTRUMENTS_MAX = 200`, `DATA_KEYS_PER_REQUEST_MAX = 20`
  - `dataKeyRefSchema` (zod: `{ source: enum, key: string trimmed 1..128 }`); `type DataKeyRef`
  - `latestValuesRequestSchema` (zod: `{ instrumentIds: uuid[] 1..200, keys: DataKeyRef[] 1..20 }`)
  - `interface DataKeyMeasurement { code: string; name: string; unit: string }`
  - `interface DataKeyInfo { source: DataKeySource; key: string; label: string; numeric: boolean; instruments: number; lastSeen: string | null; measurement: DataKeyMeasurement | null }`
  - `interface DataKeyJudged { limitMin: number | null; limitMax: number | null; limitMinText: string | null; limitMaxText: string | null; sensorError: boolean; rangeError: boolean }`
  - `interface LatestKeyValue { source: DataKeySource; key: string; value: unknown; ts: string | null; unit: string | null; decimals: number | null; display: string | null; judged: DataKeyJudged | null }`
  - `interface LatestValuesRow { instrumentId: string; code: string; name: string; functionalLocationName: string | null; locationAttribute: string | null; reporting: boolean; lastSeenAt: string | null; values: LatestKeyValue[] }`

- [ ] **Step 1: Write the failing test** `data-keys.test.ts`:
  - `dataKeyRefSchema` accepts `{ source: 'telemetry', key: 'p' }`, trims `' p '` to `'p'`, rejects `key: ''`, `key` of 129 chars, `source: 'other'`.
  - `latestValuesRequestSchema` accepts 1 uuid + 1 key; rejects 0 ids, 201 ids, 21 keys, a non-uuid id.
- [ ] **Step 2: Run** `cd packages/shared && npx vitest run src/types/data-keys.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `data-keys.ts` with the names above (types are declarations only; no runtime logic beyond the two schemas). Export everything from `index.ts`.
- [ ] **Step 4: Run** the test — PASS; `npm run build -w @digilog/shared` — exit 0; `cd packages/shared && npm run lint` — exit 0.
- [ ] **Step 5: Commit** `feat(shared): data-key contract for widget keys (phase 1)`.

---

### Task 2: `GET /api/instruments/data-keys` — the key catalogue

**Files:**
- Modify: `apps/api/src/modules/instruments/telemetry.repository.ts` — add `getKeyCatalogue`; re-implement `getDistinctKeys` over the latest table
- Create: `apps/api/src/modules/instruments/data-keys.ts` — `buildKeyCatalogue`
- Create: `apps/api/src/modules/instruments/data-keys-routes.ts` — child plugin
- Modify: `apps/api/src/modules/instruments/routes.ts:538` — `await app.register(dataKeysRoutes)` beside `deviceCertificateRoutes`; `/:id/telemetry-keys` (≈1471–1530) gains `numeric` and `measurement`
- Create: `apps/api/src/e2e/data-keys.e2e.test.ts`
- Modify: `docs/recreation/06-api/endpoints.md` (one row for the route; the `telemetry-keys` row gains the two fields)

**Interfaces:**
- Consumes: Task 1 types; `NUMERIC_READING`; `slotConfigLookup()`, `loadMeasurementTypes()` (`profile-measurements.ts`); `offsetKeyTest()` (`load-offsets.ts`); `coerceAttributeLabels` + `ATTRIBUTE_LABELS_CONFIG_KEY`; `resolveLocationIds`; `resolveVisibility` / `withVisibility`; `buildContext`.
- Produces:
  - `getKeyCatalogue(instrumentIds: string[]): Promise<{ key: string; instruments: number; lastSeen: Date; numeric: boolean }[]>` — `[]` for an empty list; one row per exact stored key; `numeric = bool_or((NUMERIC_READING) IS NOT NULL)`; ordered `max(ts) DESC, key`.
  - `getDistinctKeys(instrumentId)` — same signature and order as today, now from `instrument_telemetry_latest`.
  - `buildKeyCatalogue(opts: { instruments: { id: string; profileId: string }[]; isSuperAdmin: boolean }): Promise<DataKeyInfo[]>` — telemetry entries first (catalogue order), then attribute entries by label.
  - `measuredSlotFor(cfg: InstrumentSlotConfig, key: string): TelemetrySlot | null` — exported from `data-keys.ts`; folds case against `cfg.aliases`; returns null when `cfg.measured[slot]` is false.

- [ ] **Step 1: Write the failing e2e tests** in `data-keys.e2e.test.ts` (own SUPER_ADMIN login via `loginAs(app)`, profile `fixture:data-keys`, instruments created through `POST /api/instruments`, readings written straight into BOTH `instrument_telemetry_history` and `instrument_telemetry_latest`, attributes via `prisma.instrumentAttribute.createMany`):
  - `a key nobody configured appears with no config write` — seed latest `p = 101.3` on A; `GET /data-keys?instrumentIds=A` → an entry `{ source: 'telemetry', key: 'p', label: 'p', numeric: true, instruments: 1, measurement: null }`, `lastSeen` = the seeded ts.
  - `quoted numbers are numeric` — `p2 = "21.5"` → `numeric: true`; `state = "RUN"` → `numeric: false`.
  - `a measured key is labelled by its measurement` — `t = 21.5` on the fixture profile (default measurements: temperature alias `t`) → `measurement: { code: 'TEMPERATURE', name: <registry name>, unit: <registry unit> }`, `label` = the measurement's name.
  - `counts instruments per key` — `p` on A and B → `instruments: 2`.
  - `attribute keys are listed under their display name` — attribute `Firmware = 1.2` on A; `attribute-labels` row maps `Firmware → "Firmware version"` (save the row's prior value; restore FIRST in `afterAll`) → `{ source: 'attribute', key: 'Firmware', label: 'Firmware version', numeric: false }`; a blank-valued attribute is not listed.
  - `offset keys are absent for a non-super-admin` — attribute `Temp Off set = 0.5` (the fixture profile's offset key — read it from the profile's measurements in `beforeAll`, never hardcode) → listed for SUPER_ADMIN, absent for the OPERATOR (`RB0001` / `Test@1234`, granted `INSTRUMENT_READ`, `invalidateRolePermsCache('OPERATOR')`; restore both FIRST in `afterAll` — the `telemetry-history.e2e.test.ts` pattern).
  - `an out-of-scope instrument is absent, never 403` — OPERATOR scoped to `{ locationIds: [], instrumentIds: [A] }` asking `instrumentIds=A,B` → B's keys absent; asking `instrumentIds=B` → `200`, `data: []`. Positive control: SUPER_ADMIN sees B's keys.
  - `one selector is required` — no query → 400; `instrumentIds` + `profileId` → 400; a malformed uuid → 400; 201 ids → 400.
  - `functionalLocationId expands a Block to its Areas` and `profileId selects the profile's instruments`.
  - `telemetry-keys gains numeric and measurement` — `GET /:id/telemetry-keys` for A: the `p` row carries `numeric: true, measurement: null`; the `t` row `slot: 'temperature'` and `measurement.code: 'TEMPERATURE'`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/e2e/data-keys.e2e.test.ts --pool=forks --poolOptions.forks.singleFork=true` — Expected: FAIL (404 on the route).
- [ ] **Step 3: Implement** the repository functions, `measuredSlotFor`, `buildKeyCatalogue`, and the route:
  - Query schema: `instrumentIds` (string), `functionalLocationId` (uuid), `profileId` (uuid); the handler refuses anything but exactly one (400 `VALIDATION_ERROR`), parses `instrumentIds` with the uuid regex already used by `/telemetry-history` and the 200 cap.
  - Instruments: `prisma.instrument.findMany({ where: withVisibility(<selector>, visibility), select: { id, profileId } })`.
  - Attribute entries: one raw query over `instrument_attributes` for those ids, `btrim(value) <> ''`, grouped by `lower(key)` (display the first key by `min(key)`), `count(DISTINCT instrument_id)`, `max(updated_at)`; label through `coerceAttributeLabels` with the fold lookup `bulkAttributeColumns` uses; offset keys dropped unless SUPER_ADMIN.
  - Measured: a telemetry key is measured when `measuredSlotFor` is non-null for ANY instrument's profile in the set; `measurement` from `loadMeasurementTypes()` by code (`TEMPERATURE` / `HUMIDITY`).
  - Response schema declares every `DataKeyInfo` field (`lastSeen` nullable string, `measurement` nullable object with its three inner keys).
  - `/:id/telemetry-keys`: declare `numeric` (boolean) and `measurement` (nullable object, three inner keys) and fill them from `getKeyCatalogue([id])` + `measuredSlotFor`.
- [ ] **Step 4: Run** the e2e file — PASS. Then mutation-check: delete the `numeric` line from the route's response schema → at least one test fails; restore from a backup copy (never `git checkout`). Same for `measurement`'s `code`.
- [ ] **Step 5: Run** `src/e2e/instrument-telemetry-range.test.ts` and `src/e2e/telemetry-history.e2e.test.ts` (callers of `getDistinctKeys` / neighbours) — PASS; `cd apps/api && npm run lint` — exit 0.
- [ ] **Step 6: Commit** `feat(instruments): key catalogue — every key a set of instruments has sent or carries`.

---

### Task 3: `POST /api/instruments/latest-values` — what the value widgets show

**Files:**
- Modify: `apps/api/src/modules/instruments/telemetry-overview.ts:281-303, 366-394` — `instrumentIds?: string[]` option, ANDed into `selectionWhere`
- Modify: `apps/api/src/modules/instruments/telemetry.repository.ts` — add `getLatestFor`
- Modify: `apps/api/src/modules/instruments/data-keys.ts` — add `buildLatestValues`
- Modify: `apps/api/src/modules/instruments/data-keys-routes.ts` — the POST route
- Modify: `apps/api/src/e2e/data-keys.e2e.test.ts` — a `describe('POST /latest-values')` block
- Modify: `apps/api/src/e2e/instrument-telemetry-range.test.ts:650-690` — latest-values joins the resolver-agreement case
- Modify: `docs/recreation/06-api/endpoints.md`

**Interfaces:**
- Consumes: Task 1 (`latestValuesRequestSchema`, `LatestValuesRow`, `LatestKeyValue`, `DataKeyJudged`), Task 2 (`measuredSlotFor`), `buildTelemetryOverview`, `slotConfigLookup`, `loadMeasurementTypes`, `offsetKeyTest`, `annotateAttribute` (`decimals.ts`).
- Produces:
  - `buildTelemetryOverview({ instrumentIds, visibilityWhere })` — `instrumentIds` narrows the selection (`{ id: { in } }`), ANDed with every other selection and with visibility; an empty array returns `[]`.
  - `getLatestFor(instrumentIds: string[], keys: string[]): Promise<{ instrumentId: string; key: string; value: unknown; ts: Date }[]>` — exact key match; `[]` when either list is empty.
  - `buildLatestValues(opts: { instrumentIds: string[]; keys: DataKeyRef[]; isSuperAdmin: boolean; visibilityWhere?: object }): Promise<LatestValuesRow[]>` — rows in overview order (code asc); `values` in the REQUESTED key order.

- [ ] **Step 1: Write the failing tests** (same file, same fixtures):
  - `a raw key returns its value as stored and is not judged` — `p = 101.333` → `{ value: 101.333, unit: null, decimals: null, judged: null }`, `ts` = seeded ts.
  - `a measured key returns the server's precision, unit and bounds` — A carries `High Temperature Limit = 27`, `Low Temperature Limit = 18` (the profile's limit keys — read from the profile), `t = 21.5` → `decimals` = the overview row's `decimals.temperature`, `unit` = the TEMPERATURE type's unit, `judged = { limitMin: 18, limitMax: 27, limitMinText: null, limitMaxText: null, sensorError: false, rangeError: false }`.
  - `a sensor fault is flagged, not hidden` — `t = "NA"` → `value: 'NA'`, `judged.sensorError: true`.
  - `alias match folds case` — key `T` on a profile whose alias is `t` → judged non-null.
  - `only the resolved alias is judged` — A sends `t` and `temperature`; the default alias order is `temperature, temp, t` (`TELEMETRY_SLOT_ALIASES_DEFAULT`), so `temperature` is judged and `t` returns `judged: null`.
  - `a key never sent returns null` — `{ value: null, ts: null }`.
  - `attributes return their value and display` — `Firmware` → `{ value: '1.2', display: null, judged: null }`; the profile's high-limit attribute → `display` formatted at the temperature decimals (`annotateAttribute`).
  - `offset keys are absent for a non-super-admin` — OPERATOR asking for the offset attribute gets `value: null, ts: null`.
  - `an out-of-scope instrument is absent` — OPERATOR scoped to A asking `[A, B]` → one row; asking `[B]` → `200`, `data: []`.
  - `the body is validated` — 0 ids / 21 keys / bad source → 400.
  - In `instrument-telemetry-range.test.ts` → `every server resolver agrees about a disabled bound`: add `it('latest-values reports the SAME bounds as the overview')` posting `{ instrumentIds: [agreeId], keys: [{ source: 'telemetry', key: 'temperature' }] }` and asserting `{ min: judged.limitMin, max: judged.limitMax }` equals the overview row's `{ tempMin, tempMax }`.
- [ ] **Step 2: Run** both files — Expected: FAIL (404).
- [ ] **Step 3: Implement**:
  - `buildLatestValues`: one `buildTelemetryOverview({ instrumentIds, visibilityWhere })`; one `slotConfigLookup()`; one `getLatestFor(rowIds, telemetryKeys)`; one attribute query for the rows' ids; `loadMeasurementTypes()` once.
  - Telemetry key K on row R: `slot = measuredSlotFor(slotOf(R.profileId), K)`; measured iff `slot && R.rawSlots[slot]?.key === K`. Measured → `decimals = R.decimals[slot]`, `unit` from the type, `judged` from `R.limits` (`tempMin/tempMax` or `rhMin/rhMax`), `R.limitText`, `R.sensorError[slot]`, `R.rangeError[slot]`. Value always from the latest row (the raw stored JSON).
  - Attribute key: folded match; `display` via `annotateAttribute(slotOf(R.profileId).decimals, R.decimals, attr).display`; `ts` = `updatedAt`; offset keys → absent unless SUPER_ADMIN.
  - Route: body validated by `latestValuesRequestSchema.safeParse` (400 with the zod message); visibility via `resolveVisibility(buildContext(req))` passed as `visibilityWhere`. Response schema declares every field of `LatestValuesRow` / `LatestKeyValue` / `DataKeyJudged`; `value` is `{}` with no type (any JSON), nullable.
  - Declare `OverviewRow` untouched — `instrumentIds` is an option, not a field.
- [ ] **Step 4: Run** both files — PASS. Mutation-check: delete `judged`'s `limitMin` from the response schema → a test fails; delete the `R.rawSlots[slot]?.key === K` clause → `only the resolved alias is judged` fails. Restore from backups.
- [ ] **Step 5: Run** `src/e2e/telemetry-overview.e2e.test.ts` (the overview's own guard) — PASS; `npm run lint` — exit 0.
- [ ] **Step 6: Commit** `feat(instruments): latest values for any key — measured keys judged by the server's own bounds`.

---

### Task 4: `keys` on the two history routes, then the phase gate

**Files:**
- Create: `apps/api/src/modules/instruments/keys-param.ts` + `__tests__/keys-param.test.ts`
- Modify: `apps/api/src/modules/instruments/routes.ts` — `/telemetry-history` (≈1043–1108) and `/:id/telemetry` (≈1151–1465)
- Modify: `apps/api/src/modules/instruments/telemetry.repository.ts` — `getHistory` and `getMultiInstrumentHistory` take `keys?: string[]`
- Modify: `apps/api/src/e2e/data-keys.e2e.test.ts` — a `describe('keys on history')` block
- Modify: `CHANGELOG.md`, `docs/feature-notes.md` (new note at the top: "WIDGET DATA KEYS — phase 1"), `apps/api/CLAUDE.md` (dated entry), root `CLAUDE.md` topics line, `docs/recreation/06-api/endpoints.md`, `tasks/todo.md`

**Interfaces:**
- Consumes: Task 1 (`DATA_KEYS_PER_REQUEST_MAX`, `DATA_KEY_MAX`), Task 2 (`getDistinctKeys` on the latest table).
- Produces: `parseKeysParam(raw: string | undefined): { keys: string[] | null } | { error: string }` — `undefined`/blank → `{ keys: null }` (no filter); comma-split, trimmed, blanks dropped, de-duplicated in order; more than 20 or one longer than 128 → `{ error }`.

- [ ] **Step 1: Write the failing tests**:
  - Unit `keys-param.test.ts`: `undefined` → `{ keys: null }`; `'p, t,,p'` → `{ keys: ['p', 't'] }`; 21 keys → error; a 129-char key → error.
  - e2e `telemetry-history filters by keys` — A has `t`, `h`, `p` at one instant → `?instrumentIds=A&keys=p` returns that instant with `values` = `{ p: … }` only, `total` 1.
  - e2e `/:id/telemetry chart path charts only the asked keys` — `?keys=p,t&points=100&from&to` → `summaries` has exactly `p` and `t`; a raw key's summary has `limitMin: null, belowCount: null`; `count - numericCount` equals the seeded non-numeric readings of `p`.
  - e2e `/:id/telemetry table path filters by keys` — `?keys=p` → every `history` row has `key === 'p'`.
  - e2e `key and keys together is a 400`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**: both routes declare `keys` (string) in the querystring; parse with `parseKeysParam` (400 on error; 400 when `key` and `keys` are both given); the chart path uses `keys ?? (key ? [key] : distinct keys)`; `getHistory`/`getMultiInstrumentHistory` add `AND key IN (…)` when `keys` is non-empty (the multi route's `total` then counts instants carrying at least one of them). **No new response field**: `summaries[key]` already carries `count` and `numericCount`, so "N text readings not plotted" is `count - numericCount` (spec §5.3 already says so).
- [ ] **Step 4: Run** the unit file and the e2e file — PASS. Mutation-check: drop the `AND key IN` clause in `getMultiInstrumentHistory` → `telemetry-history filters by keys` fails; restore.
- [ ] **Step 5: Docs**: CHANGELOG entry (what, why, the new routes, the `getDistinctKeys` move, counts: API routes +2, nothing else moves — re-derive the System Stats greps and quote them); feature note; `apps/api/CLAUDE.md` dated entry naming the Fastify-strip declarations and the mutation checks; endpoints rows; `tasks/todo.md` audit-log line.
- [ ] **Step 6: Phase gate**: `npm run build -w @digilog/shared` (exit 0); `cd apps/api && npm run lint` (exit 0); `cd apps/api && npm test` — the FULL API suite, single fork, exit 0 (record files / tests counts); `cd packages/shared && npm test` — exit 0. A red file is re-run alone, then with the change stashed, before it is called someone else's.
- [ ] **Step 7: Commit** `feat(instruments): keys filter on the history routes; widget data keys phase 1 docs`.
