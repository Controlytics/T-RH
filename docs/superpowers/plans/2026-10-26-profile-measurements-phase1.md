# Profile Measurements — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every key mapping that is global today (temperature/humidity device keys, decimals, limit,
enable, range, offset and MKT keys) is read from the instrument's own PROFILE, with profile-level
on/off for NMT, NLT and MKT — for the two measurements the app already understands.

**Architecture:** A profile carries `measurements` (JSON, shared zod schema). One server resolver
(`profile-measurements.ts`, 10 s cache) turns a profile's measurements into an
`InstrumentSlotConfig` shaped like today's global configs, so every existing consumer swaps
"load the global row" for "look up this instrument's slot config" with its logic untouched. Phase 2
generalises past two slots; this phase keeps every response shape byte-identical.

**Tech Stack:** Fastify 5 + Prisma 6 + PostgreSQL 18 (API), React + SWR (web), zod in `@digilog/shared`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-26-profile-measurements-design.md`

## Global Constraints

- G4: no current instrument may show a different value, limit, colour, decimals, alarm or MKT figure.
  Proof = existing e2e/worker tests pass with ONLY their setup moved from `system_config` to the profile.
- `alarms.metric` stays the Postgres enum in this phase (enum → text is Phase 2).
- Measurement edits are SUPER_ADMIN-only, enforced in the route; re-auth `UPDATE_INSTRUMENT_PROFILE`; `reason` required when `measurements` changes.
- Moving an instrument to a profile with different resolved measurements: SUPER_ADMIN-only (`403 MEASUREMENTS_DIFFER`).
- Bound enable attribute absent/blank/unreadable = ENABLED; MKT attribute absent = OFF (both unchanged).
- Valued keys (shown at a measurement's precision) = that measurement's limit + range keys; never offset keys.
- Migrations are hand-written SQL, strip any `DROP TABLE instrument_telemetry_history` / partial-index drops, applied to `compliance_core_db` AND `compliance_core_db_test`, `npm run db:verify-migrations` PASS.
- Every new response field is DECLARED in the route's response schema (Fastify strips undeclared fields); e2e asserts through `app.inject`.
- API tests: one file at a time or `npm test` (single fork). Web tests: one file at a time, judged by exit code.
- Commit locally per task; do NOT push. `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A profile created on an install whose devices send `h`** — humidity must still resolve. `DEFAULT_PROFILE_MEASUREMENTS` humidity `deviceKeys` include `h` (Task 1 test).
2. **An install missing one of the four config rows** (fresh install, or AWS never saved Sensor Offsets) — the backfill must fall back to the shipped default for that list, never write an empty list (Task 2 SQL check on a scratch DB).
3. **A non-SUPER_ADMIN edits a profile's attribute keys and the page sends `measurements` back unchanged** — must be 200, not 403 (Task 7 test).
4. **A gateway batch whose children sit on two profiles with different offset keys** — each child corrected by its own profile's key (Task 6 test).
5. **A profile edit followed immediately by a dashboard poll** — the overview reflects the edit at once (cache invalidated on write, not after 10 s) (Task 7 test).

---

### Task 1: Shared measurement model

**Files:**
- Create: `packages/shared/src/types/profile-measurements.ts`
- Create: `packages/shared/src/types/profile-measurements.test.ts`
- Modify: `packages/shared/src/types/mkt.ts` (add `isMktOn`)
- Modify: `packages/shared/src/index.ts` (exports)

**Interfaces — Produces:**
```ts
export const MEASUREMENT_CODES_PHASE1 = ['TEMPERATURE', 'HUMIDITY'] as const;
export const MEASUREMENT_CODE_RE = /^[A-Z][A-Z0-9_]{1,31}$/;   // 'OFFLINE' reserved
export interface MeasurementType { code: string; name: string; unit: string; sortOrder: number }
export const profileMeasurementSchema: z.ZodType<ProfileMeasurement>;      // one entry, spec D2 shape
export const profileMeasurementsSchema: z.ZodType<ProfileMeasurement[]>;   // array + cross-entry refinements
export type ProfileMeasurement = {
  code: string; deviceKeys: string[];
  decimals: { attributeKeys: string[]; fallback: number };
  high: { enabled: boolean; limitKeys: string[]; enableKeys: string[] };   // NMT
  low:  { enabled: boolean; limitKeys: string[]; enableKeys: string[] };   // NLT
  range: { highKeys: string[]; lowKeys: string[] };
  offsetKeys: string[];
  mkt: { enabled: boolean; attributeKeys: string[] };
};
export const DEFAULT_PROFILE_MEASUREMENTS: ProfileMeasurement[];
export function coerceProfileMeasurements(raw: unknown): ProfileMeasurement[];  // null/invalid → DEFAULT
export interface InstrumentSlotConfig {
  measured: Record<TelemetrySlot, boolean>;
  aliases: Record<TelemetrySlot, string[]>;                 // lower-cased device keys
  decimals: { keys: Record<TelemetrySlot, string[]>; fallback: Record<TelemetrySlot, number>; valuedKeys: Record<TelemetrySlot, string[]> };
  limitKeys: Record<LimitBound, string[]>;
  enableKeys: Record<LimitBound, string[]>;
  boundSwitch: Record<LimitBound, boolean>;
  rangeKeys: Record<RangeBound, string[]>;
  offsetKeys: Record<TelemetrySlot, string[]>;
  mkt: Record<TelemetrySlot, { enabled: boolean; attributeKeys: string[] }>;
}
export function slotConfigFromMeasurements(ms: ProfileMeasurement[]): InstrumentSlotConfig;
export function measurementsEquivalent(a: ProfileMeasurement[], b: ProfileMeasurement[]): boolean;
// mkt.ts
export function isMktOn(setting: { enabled: boolean; attributeKeys: string[] }, attributes: { key: string; value: string }[]): boolean;
```

Validation rules in `profileMeasurementsSchema` (each a named issue path):
codes match `MEASUREMENT_CODE_RE`, not `OFFLINE`, unique; in Phase 1 the route additionally restricts
codes to `MEASUREMENT_CODES_PHASE1`; a device key (case-folded) in at most one entry; an attribute key
(case-folded) in at most one ROLE across all entries (limit/enable/range/offset/decimals/mkt);
`decimals.fallback` integer 0..`TELEMETRY_DECIMALS_MAX`; every list ≤ 20 items, each 1..64 chars.
MKT-only-on-°C needs the registry and is checked by the route (Task 7).

`DEFAULT_PROFILE_MEASUREMENTS`: TEMPERATURE then HUMIDITY, lists from `TELEMETRY_SLOT_ALIASES_DEFAULT`,
`TELEMETRY_DECIMALS_KEYS_DEFAULT`, `ALARM_LIMIT_KEYS_DEFAULT`, `ALARM_LIMIT_ENABLE_KEYS_DEFAULT`,
`SENSOR_RANGE_KEYS_DEFAULT`, `SENSOR_OFFSET_KEYS_DEFAULT` (split on `\n`, display case kept),
fallback `TELEMETRY_DECIMALS_FALLBACK`, both bounds enabled; humidity device keys = default + `h`;
MKT TEMPERATURE `{enabled: true, attributeKeys: [MKT_ATTRIBUTE_KEY]}`, HUMIDITY `{enabled: false, attributeKeys: []}`.

`slotConfigFromMeasurements`: a slot whose code is absent → `measured` false, every list `[]`,
`boundSwitch` false, mkt `{enabled:false, attributeKeys:[]}`, fallback `TELEMETRY_DECIMALS_FALLBACK`.
All lists lower-cased + trimmed via `parseLimitKeys(list.join('\n'))`. `valuedKeys[slot]` = limit
high+low keys ∪ range high+low keys, in that order, de-duplicated.

`isMktOn`: `!enabled` → false; `attributeKeys` empty → true; else first listed key the instrument has
decides by `isMktEnabled`'s truth table; none present → false.

- [ ] **Step 1: Write the failing tests** in `profile-measurements.test.ts`:
  - `DEFAULT_PROFILE_MEASUREMENTS` parses with `profileMeasurementsSchema`; codes `['TEMPERATURE','HUMIDITY']`; humidity `deviceKeys` contains `'h'`.
  - duplicate code → issue; `OFFLINE` code → issue; device key `T` in TEMPERATURE and `t` in HUMIDITY → issue; `t_hl` as temperature limit AND humidity offset → issue.
  - `slotConfigFromMeasurements([DEFAULT[0]])` → `measured.humidity === false`, `aliases.humidity` `[]`, `boundSwitch.humidityHigh === false`.
  - `slotConfigFromMeasurements(DEFAULT).aliases.temperature` equals `['temperature','temp','t']`; `valuedKeys.temperature` includes `'high temperature limit'` and `'high temperature range'` and NOT `'temp off set'`.
  - `coerceProfileMeasurements(null)` deep-equals `DEFAULT_PROFILE_MEASUREMENTS`; `coerceProfileMeasurements([])` is `[]`; `coerceProfileMeasurements('junk')` deep-equals DEFAULT.
  - `measurementsEquivalent(DEFAULT, structuredClone(DEFAULT))` true; flipping `high.enabled` → false; changing only list case (`T` vs `t`) → true.
  - in `mkt.test.ts`: `isMktOn({enabled:false, attributeKeys:[]}, [])` false; `isMktOn({enabled:true, attributeKeys:[]}, [])` true; `isMktOn({enabled:true, attributeKeys:['isMktCalculationEnabled']}, [{key:'IsMktCalculationEnabled', value:'1'}])` true; same with no attribute → false.
- [ ] **Step 2:** `cd packages/shared && npx vitest run src/types/profile-measurements.test.ts src/types/mkt.test.ts` → FAIL (module not found).
- [ ] **Step 3:** Implement the interfaces above; export from `index.ts`.
- [ ] **Step 4:** Same command → PASS; `npm run build -w @digilog/shared` → exit 0.
- [ ] **Step 5:** Commit `feat(shared): profile measurement model and per-instrument slot config`.

### Task 2: Schema + migration (registry, profile measurements, backfill)

**Files:**
- Modify: `apps/api/prisma/schema.prisma` — model `MeasurementType` (`@@map("measurement_types")`: `code String @id`, `name`, `unit`, `sortOrder Int @map("sort_order")`, timestamps, `createdBy`/`updatedBy`); `InstrumentProfile.measurements Json?`; update the profile model comment (it now carries TWO inherited settings).
- Create: `apps/api/prisma/migrations/20261026120000_profile_measurements/migration.sql`

**Interfaces — Produces:** table `measurement_types` with rows `('TEMPERATURE','Temperature','°C',1)`, `('HUMIDITY','Humidity','%RH',2)`; column `instrument_profiles.measurements JSONB NULL`, filled for every existing row.

Backfill builds the two entries with `jsonb_build_object` from THIS database's rows, each list as
`COALESCE(<config value split on E'\n', trimmed, blanks dropped>, <shipped default literal>)`:

| entry field | source key (config row) |
|---|---|
| TEMPERATURE.deviceKeys / HUMIDITY.deviceKeys | `temperatureKeys` / `humidityKeys` (`telemetry-slots`) |
| decimals.attributeKeys / fallback | `temperatureDecimalsKeys`, `temperatureDecimals` / humidity pair (`telemetry-slots`) |
| high/low.limitKeys | `temperatureHighKeys`, `temperatureLowKeys`, `humidityHighKeys`, `humidityLowKeys` (`alarm-limits`) |
| high/low.enableKeys | `…HighEnableKeys`, `…LowEnableKeys` (`alarm-limits`) |
| range.highKeys / lowKeys | same four names on `sensor-range-alarms` |
| offsetKeys | `temperatureKeys` / `humidityKeys` (`sensor-offsets`) |
| high/low.enabled | `true` |
| mkt | TEMPERATURE `{"enabled":true,"attributeKeys":["isMktCalculationEnabled"]}`, HUMIDITY `{"enabled":false,"attributeKeys":[]}` |

A helper SQL function is NOT created (raw objects must live in `prisma/sql/*`); use a CTE.

- [ ] **Step 1:** Edit the schema; run `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script` (from `apps/api`), copy only the `measurement_types` CREATE and the `ALTER TABLE instrument_profiles ADD COLUMN` into the migration; strip every `DROP`.
- [ ] **Step 2:** Append the seed INSERT and the backfill UPDATE.
- [ ] **Step 3: Review-focus #2 check.** On a scratch database built by `npm run db:verify-migrations` (or a throwaway `createdb` + `migrate deploy`), insert one profile with no config rows present, run the migration's UPDATE, and assert with `psql` that every list equals the shipped default (non-empty). Record the query and result in the migration header comment.
- [ ] **Step 4:** Apply to both databases: `npx prisma migrate deploy` with `DATABASE_URL` for `compliance_core_db`, then for `compliance_core_db_test`; `npx prisma generate` (stop `tsx watch` first — EPERM otherwise); `npm run db:verify-migrations` → PASS; `npm run check:migrations` → OK.
- [ ] **Step 5:** `psql` on `compliance_core_db`: the T&RH profile's TEMPERATURE.deviceKeys = `["temperature","t"]`, HUMIDITY.deviceKeys = `["humidity","h"]`, TEMPERATURE.high.limitKeys = `["t_hl","High Temperature Limit"]`, offsetKeys `["Temp Off set"]` (the live values queried 2026-10-26).
- [ ] **Step 6:** Commit `feat(db): measurement types and per-profile measurements, backfilled from this install's config`.

### Task 3: The one resolver

**Files:**
- Create: `apps/api/src/modules/instruments/profile-measurements.ts`
- Create: `apps/api/src/modules/instruments/__tests__/profile-measurements.test.ts` (against the test DB)
- Create: `apps/api/src/test-support/fixture-measurements.ts`

**Interfaces — Produces:**
```ts
export async function loadProfileMeasurements(): Promise<Map<string, ProfileMeasurement[]>>; // profileId → list (NULL → DEFAULT), cached 10 s
export async function slotConfigForProfile(profileId: string): Promise<InstrumentSlotConfig>;   // unknown id → slotConfigFromMeasurements(DEFAULT)
export async function slotConfigsForInstruments(instrumentIds: string[]): Promise<Map<string, InstrumentSlotConfig>>; // one query for profileIds
export async function allOffsetKeys(): Promise<Set<string>>;                                   // lower-cased union over every profile
export async function loadMeasurementTypes(): Promise<MeasurementType[]>;                       // sortOrder asc
export function invalidateProfileMeasurementsCache(): void;
// test-support
export async function setFixtureMeasurements(profileId: string, patch: (ms: ProfileMeasurement[]) => ProfileMeasurement[]): Promise<void>; // writes + invalidates
```

- [ ] **Step 1: Failing tests:** a profile created with `measurements: null` resolves to `slotConfigFromMeasurements(DEFAULT)`; after `setFixtureMeasurements` drops HUMIDITY, `slotConfigsForInstruments([inst])` gives `measured.humidity === false` immediately (no 10 s wait); `allOffsetKeys()` contains `'temp off set'`.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/modules/instruments/__tests__/profile-measurements.test.ts` → FAIL.
- [ ] **Step 3:** Implement (cache `{ map, at }`, TTL 10 000 ms, the `load-offsets` precedent).
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit `feat(instruments): one per-profile measurement resolver`.

### Task 4: Read side reads the profile (overview, decimals, limits, range, telemetry, aggregate, room history)

**Files (Modify):**
- `apps/api/src/modules/alarms/load-limits.ts` — `loadLimitConfig(): Promise<{ enabled: boolean }>`; `enabledBoundsFor(cfg: Pick<InstrumentSlotConfig,'enableKeys'|'boundSwitch'>, attributes)` = `boundSwitch[b] && (resolveEnableFlag(...)?.enabled ?? true)`; `limitsFor(keys, attributes)` unchanged (callers pass `slot.limitKeys`); `countWithoutLimits(instruments: {code, attributes, slot: InstrumentSlotConfig}[])`.
- `apps/api/src/modules/alarms/load-range.ts` — `loadRangeConfig(): Promise<{ enabled: boolean; rangeText: string }>`; `rangeFor(slot.rangeKeys, attributes)`.
- `apps/api/src/modules/instruments/decimals.ts` — delete `loadDecimalsConfig`/`DECIMALS_CONFIG_DEFAULT`; `decimalsFor(slot.decimals, attributes)`; `annotateAttribute(slot.decimals, dp, attr)`.
- `apps/api/src/modules/instruments/telemetry-overview.ts` — delete `loadAliases`; select `profileId`; per instrument `slot = configs.get(inst.id)`; add internal `profileId` and `measured` to `OverviewRow` (NOT in the route schema). `instrumentLimitsWithText(keys, attributes)` keeps its signature (callers pass `slot.limitKeys`).
- `apps/api/src/modules/instruments/routes.ts` — `/:id/telemetry` (lines ~1238-1430): `slot = await slotConfigForProfile(exists.profileId)`; `slotFor` reads `slot.aliases`; MKT line becomes `isMktOn(slot.mkt.temperature, attributes) && slotFor(k.key) === 'temperature'`; `/:id/telemetry-keys` (~1488) and the attribute annotate paths (~2535, ~2852) read the instrument's slot config.
- `apps/api/src/modules/instruments/telemetry-aggregate.ts` — the SQL `CASE` grouping uses a VALUES list `(instrument_id, lower(key), slot)` built from each instrument's `slot.aliases`, replacing the global alias arrays; limits via `slot.limitKeys`.
- `apps/api/src/modules/floorplans/room-history.ts` — delete its `slotAliases`; per-instrument slot config.
- `apps/api/src/modules/alarms/routes.ts` (~463-490) — `countWithoutLimits` fed per-instrument slot configs.

- [ ] **Step 1: Move the test setup, never the assertions.** In `src/e2e/telemetry-overview.e2e.test.ts`, `instrument-telemetry-range.test.ts`, `telemetry-aggregate.test.ts`, `instrument-limit-alarms.e2e.test.ts`, `alarm-sensor-range.e2e.test.ts`, `instrument-scope-selection.test.ts`, `bulk-attributes.e2e.test.ts`, `config.test.ts`, `config-dynamic-put.e2e.test.ts`: replace every write of the moved keys to `system_config` (`temperatureKeys`, `humidityKeys`, `*DecimalsKeys`, `*ValuedKeys`, `*Decimals`, `*HighKeys`, `*LowKeys`, `*EnableKeys`) with `setFixtureMeasurements(profileId, …)` producing the same lists. Settings that stay global (`enabled`, wording, refresh) keep their `system_config` writes. `git diff` of these files must show no `expect(` line changed.
- [ ] **Step 2:** Run each moved file alone → FAIL (setup no longer has an effect).
- [ ] **Step 3:** Implement the modifications above. Add one new e2e case to `telemetry-overview.e2e.test.ts`: a fixture profile with `high.enabled: false` on TEMPERATURE → overview row `limits.tempMax === null`, `limitEnabled.tempMax === false`, while `limits.tempMin` survives.
- [ ] **Step 4:** Run each file in Step 1 alone → PASS; `npx tsc -p apps/api/tsconfig.json --noEmit` and `npm run lint -w apps/api` → exit 0.
- [ ] **Step 5: Mutation check:** change `enabledBoundsFor` to ignore `boundSwitch` (backup copy first) → the new case fails; restore from the backup.
- [ ] **Step 6:** Commit `refactor(instruments): every read-side key mapping comes from the instrument's profile`.

### Task 5: Alarm worker reads the profile; stranded alarms clear

**Files:**
- Modify: `apps/api/src/workers/alarm-evaluation.worker.ts` (limit pass ~210-487, range pass ~861-990): attributes AND `slot` per instrument (`slotConfigsForInstruments(overview ids)`); `limitsFor(slot.limitKeys, …)`, `enabledBoundsFor(slot, …)`, `rangeFor(slot.rangeKeys, …)`.
- Create: `apps/api/src/modules/alarms/stranded-decide.ts` — `strandedAlarmIds(open: {id: string; instrumentId: string; metric: string}[], measured: Map<string, Record<TelemetrySlot, boolean>>): string[]` — an open INSTRUMENT_LIMIT / RS485_FAILURE / SENSOR_RANGE alarm whose metric's slot is `false` for its instrument; an instrument absent from the map is NOT stranded (deleted instruments are out of scope).
- New stranded pass in the worker, before the limit pass: `claimClear(id, {state:'CLEARED', clearedAt: now, clearedValue: null})`, ruleSnapshot merge `{ clearedReason: 'MEASUREMENT_REMOVED' }` (the inactivity-clear precedent), notification + webhook `cleared` with condition `"<temperature|humidity> is no longer measured by this instrument's profile"`. Counted in `cleared`.
- Test: `apps/api/src/modules/alarms/__tests__/stranded-decide.test.ts`, `apps/api/src/workers/__tests__/alarm-profile-measurements.test.ts`.

- [ ] **Step 1: Failing tests:** unit — limit alarm on HUMIDITY for an instrument whose `measured.humidity` is false → returned; OFFLINE/INACTIVITY never returned; instrument missing from map → not returned. Worker — (a) fixture with an ACTIVE TEMPERATURE limit alarm, set its profile's TEMPERATURE `high.enabled=false`, `evaluateAlarms()` → alarm CLEARED; (b) ACTIVE HUMIDITY RS485 alarm, drop HUMIDITY from the profile, `evaluateAlarms()` → CLEARED with `ruleSnapshot.clearedReason === 'MEASUREMENT_REMOVED'`; (c) profile keys `deviceKeys: ['tx']` on TEMPERATURE and a reading on `tx` above `t_hl` → raises.
- [ ] **Step 2:** run each file alone → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run the two new files AND the existing `alarm-limit-gate`, `alarm-limit-hold`, `alarm-pass-ordering`, `src/e2e/alarm-rs485.e2e.test.ts`, `alarm-sensor-range.e2e.test.ts`, `alarm-inactivity.e2e.test.ts`, `instrument-limit-alarms.e2e.test.ts` one at a time → PASS (setup moved in Task 4 where needed, assertions untouched).
- [ ] **Step 5: Mutation check:** make `strandedAlarmIds` return `[]` → (b) fails; restore from backup.
- [ ] **Step 6:** Commit `feat(alarms): judge each instrument by its profile's keys; clear alarms its profile no longer measures`.

### Task 6: Offsets per profile; offset-key test from the server

**Files:**
- Modify: `packages/shared/src/types/sensor-offsets.ts` — `SensorOffsetConfig` becomes `{ enabled: boolean }`; `coerceSensorOffsetConfig` reads only `enabled`; `isOffsetAttributeKey(keys: Set<string>, key)`; `offsetReadings(rows, aliases, offsets, classify)` unchanged.
- Modify: `apps/api/src/modules/instruments/load-offsets.ts` — `offsetsFor` per instrument from `slot.offsetKeys`; `applySensorOffsets` uses `slotConfigsForInstruments(ids)` once per batch and each instrument's own `slot.aliases`; delete the local `slotAliases`; `offsetKeyTest()` → `(key) => allOffsetKeys().has(fold(key))`.
- Create route `GET /api/instruments/offset-keys` in `routes.ts` (before `/:id`): `INSTRUMENT_READ`; SUPER_ADMIN → `{ keys: string[] }` from `allOffsetKeys()`, everyone else `{ keys: [] }`; schema declares `keys`.
- Modify: `apps/web/src/hooks/use-offset-keys.ts` — fetch `/api/instruments/offset-keys` (super admin only) and test `keys.includes(fold(key))`; drop the `sensor-offsets` config fetch and the shared imports.
- Tests: `src/e2e/sensor-offsets.e2e.test.ts` (setup moved; + new case), `apps/web/src/components/__tests__/attribute-value-input.test.tsx` (mock the new URL).

- [ ] **Step 1: Failing tests:** e2e — Review-focus #4: one gateway batch for two children on two fixture profiles, profile A offset key `Temp Off set`, profile B `Cal T`; child A carries `Temp Off set=+2`, child B `Cal T=-1` and `Temp Off set=+5` → stored temperatures are +2 and −1 corrected (B's `Temp Off set` ignored). `GET /offset-keys` as SUPER_ADMIN includes `temp off set` and `cal t`; as OPERATOR `[]`.
- [ ] **Step 2:** run alone → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** `sensor-offsets.e2e.test.ts`, `attribute-value-input.test.tsx`, `src/e2e/mqtt-attribute-report.test.ts`, the profile e2e → PASS one at a time.
- [ ] **Step 5:** Commit `feat(offsets): each instrument's offset keys come from its profile; the browser asks the server which keys are offsets`.

### Task 7: Profile routes carry measurements; the gates

**Files:**
- Modify: `packages/shared/src/schemas/instrument-profiles.ts` — `measurements: profileMeasurementsSchema.optional()` on create and update.
- Modify: `apps/api/src/modules/instrument-profiles/routes.ts`:
  - `profileProps` declares `measurements` (array of objects, every inner key declared); GET/list return `coerceProfileMeasurements(row.measurements)` with `offsetKeys` emptied for non-SUPER_ADMIN.
  - POST: no `measurements` → store `DEFAULT_PROFILE_MEASUREMENTS`; `measurements` present and not equivalent to DEFAULT → 403 `SUPER_ADMIN_ONLY` unless SUPER_ADMIN, and then re-auth `UPDATE_INSTRUMENT_PROFILE`.
  - PUT: `measurements` present and NOT `measurementsEquivalent` to the stored list → 403 `SUPER_ADMIN_ONLY` unless SUPER_ADMIN; `reason` required (`400 REASON_REQUIRED`); codes ⊆ `MEASUREMENT_CODES_PHASE1` (`400 MEASUREMENT_NOT_SUPPORTED`); `mkt.enabled` only where the registry unit is `°C` (`400 MKT_NOT_TEMPERATURE`); a non-SUPER_ADMIN's equivalent list is ignored (stored list kept, offsets preserved). Audit `INSTRUMENT_PROFILE_UPDATED` before/after include `measurements`; `signatureMeaning` stays short (VARCHAR 255). `invalidateProfileMeasurementsCache()` after commit (also on POST/DELETE).
  - New `POST /:id/measurement-impact` (SUPER_ADMIN; read-only, no audit) with `{ measurements }` returns `{ clears: { metric: string; source: string; limitKind: string | null; count: number }[] }` = open alarms the proposed list would clear (bound switched off at profile level, measurement removed). Pure core `alarmsClearedBy(before, after, open)` in `modules/alarms/stranded-decide.ts`.
  - New `GET /api/instrument-profiles/measurement-types` (registered BEFORE `/:id`) → `{ data: MeasurementType[] }`.
- Modify: `apps/api/src/modules/instruments/routes.ts` `PUT /:id` (~1818-1859) and the bulk path (~1649): a `profileId` change by a non-SUPER_ADMIN where `!measurementsEquivalent(old, new)` → `403 MEASUREMENTS_DIFFER`.
- Tests: `src/e2e/instrument-profiles.e2e.test.ts` (new describe `measurements`), `src/e2e/instruments.test.ts` (move gate).

- [ ] **Step 1: Failing tests:**
  - SUPER_ADMIN PUT with TEMPERATURE `high.enabled:false` + reason → 200; GET returns it (inner keys present — asserts `high.enabled === false`, `mkt.attributeKeys` array); audit row `afterValue.measurements` present.
  - same without reason → 400 `REASON_REQUIRED`.
  - OPERATOR (granted `INSTRUMENT_UPDATE`, `invalidateRolePermsCache`) PUT changing measurements → 403; Review-focus #3: OPERATOR PUT `attributeKeys` + the UNCHANGED `measurements` → 200.
  - code `PRESSURE` → 400 `MEASUREMENT_NOT_SUPPORTED`; `mkt.enabled` on HUMIDITY → 400 `MKT_NOT_TEMPERATURE`.
  - Review-focus #5: PUT changing TEMPERATURE deviceKeys to `['tx']`, then immediately `GET /api/instruments/telemetry-overview` → the fixture's `temperature.key === 'tx'`.
  - POST without measurements → stored list deep-equals DEFAULT.
  - impact: open TEMPERATURE HIGH limit alarm + proposed `high.enabled:false` → `clears` contains `{metric:'TEMPERATURE', source:'INSTRUMENT_LIMIT', limitKind:'HIGH', count:1}`.
  - move gate: OPERATOR moves an instrument to a profile without HUMIDITY → 403 `MEASUREMENTS_DIFFER`; to a profile with an equivalent list → 200; SUPER_ADMIN → 200.
- [ ] **Step 2:** run alone → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** both files → PASS; `instrument-reauth-gates.e2e.test.ts`, `instrument-scope-selection.test.ts` → PASS.
- [ ] **Step 5: Mutation checks:** delete `measurements` from `profileProps` → GET assertion fails; remove the SUPER_ADMIN check → OPERATOR case fails; restore from backups.
- [ ] **Step 6:** Commit `feat(profiles): measurements on the profile, super-admin only, with alarm impact and the move gate`.

### Task 8: Global config pages trimmed; refresh readable by everyone

**Files:**
- Modify defs: `telemetry-slots.def.ts` (keep `overviewRefreshSeconds`, `chartRefreshSeconds`; `moduleName: 'Dashboard Refresh'`; description), `alarm-limits.def.ts` (drop the 8 key settings), `sensor-range-alarms.def.ts` (drop 4), `sensor-offsets.def.ts` (drop 2); each def's doc comment says where the keys went.
- Create: `apps/api/src/modules/config/static-routes/telemetry-refresh.routes.ts` — `GET /telemetry-slots/refresh` → `{ overviewRefreshSeconds: number; chartRefreshSeconds: number }` (all authenticated users; clamped 2..600, defaults 5/10); register in the config routes loop.
- Modify: `apps/web/src/routes/dashboard/use-telemetry.ts` — `useTelemetrySettings` reads the new route; `temperatureDecimals`/`humidityDecimals` become the constant `TELEMETRY_DECIMALS_FALLBACK`.
- Modify: `apps/web/src/routes/config/index.tsx` — card titles/descriptions for the four defs.
- Modify: `packages/shared` — delete exports nothing reads any more (`TELEMETRY_VALUED_KEYS_DEFAULT` only if no importer remains; grep first).
- Tests: `src/e2e/config.test.ts` (+ OPERATOR GET `/api/config/telemetry-slots/refresh` → 200 with both numbers), web `use-telemetry` test if present.

- [ ] **Step 1:** failing e2e for the refresh route as OPERATOR.
- [ ] **Step 2:** run alone → FAIL (404).
- [ ] **Step 3:** implement.
- [ ] **Step 4:** `config.test.ts`, `config-dynamic-put.e2e.test.ts`, web `dynamic-config-reauth-action.test.tsx` → PASS one at a time.
- [ ] **Step 5:** Commit `refactor(config): key mappings leave the global pages; refresh readable by every role`.

### Task 9: Profile editor — Measurements section

**Files:**
- Create: `apps/web/src/routes/config/profile-measurements-editor.tsx`
- Create: `apps/web/src/routes/config/__tests__/profile-measurements-editor.test.tsx`
- Modify: `apps/web/src/routes/config/instrument-attributes.tsx` — render `<ProfileMeasurementsEditor profileId attributeKeys />` under the attribute-key list for the selected profile.

**Interfaces:** `ProfileMeasurementsEditor({ profile: { id: string; measurements: ProfileMeasurement[]; attributeKeys: string | null }, onSaved(): void })`. One `FormSection` per measurement (name + unit from `GET /api/instrument-profiles/measurement-types`): Device keys; Decimals attribute + Default decimals; **NMT (high limit)** toggle + limit attribute(s) + enable attribute(s); **NLT (low limit)** toggle + same; Range high / low attribute(s); Offset attribute(s); **MKT** toggle + attribute(s) (only on a `°C` type). Key lists are ordered chip inputs with suggestions from the profile's `attributeKeys`. Phase 1: "Add measurement" offers only TEMPERATURE / HUMIDITY not already present; "Remove". Save → `POST …/measurement-impact`; if any `clears`, the reason dialog lists them ("3 open High Temperature alarms will be cleared"); then `PUT` with `measurements` + `reason` under re-auth `UPDATE_INSTRUMENT_PROFILE` (`useReauth`, as the page already does). Server error codes rendered as messages.

- [ ] **Step 1: Failing tests:** renders TEMPERATURE and HUMIDITY sections from a mocked profile; toggling NMT off then Save calls `/measurement-impact` then `PUT` with `measurements[0].high.enabled === false` and the typed reason; the MKT toggle is absent on HUMIDITY; a 400 `REASON_REQUIRED` renders its message.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/routes/config/__tests__/profile-measurements-editor.test.tsx` → FAIL.
- [ ] **Step 3:** implement with UI v3 primitives (`FormSection`, `Toggle`, `Input`, `Button`).
- [ ] **Step 4:** the test → PASS; `instrument-attributes` page tests → PASS; `npx tsc -p apps/web --noEmit` → exit 0.
- [ ] **Step 5: Browser check** (memory: throwaway `vite.capture.config.ts`, port 5179, proxy to :3001; delete after): open Configuration → Instrument Attributes, confirm the section renders with the backfilled keys, no unlined element, no console error; toggle NMT off and back without saving.
- [ ] **Step 6:** Commit `feat(web): measurements editor on the instrument profile`.

### Task 10: Full runs, docs, memory

- [ ] `cd apps/api && npm test` (single fork; no other agent on the test DB) — record pass/fail counts; any red re-run alone before believing it.
- [ ] `cd apps/web` — run every test file under `src/routes/dashboard`, `src/routes/instruments`, `src/routes/config`, `src/components` ONE AT A TIME by exit code.
- [ ] `npm run lint -w apps/api`, `npx tsc -p apps/web --noEmit`, `npm run build -w @digilog/shared`.
- [ ] Live check on :3001 / :5176 (operator's app): dashboard values for 3 instruments unchanged vs before (record before/after JSON of `telemetry-overview` for the same 3 codes, diff empty apart from `ts`).
- [ ] Docs: `CHANGELOG.md`; `docs/feature-notes.md` (new note "PROFILE MEASUREMENTS"; update "Instrument-limit bounds honour a per-bound ENABLE attribute", "MEAN KINETIC TEMPERATURE", "SENSOR OFFSETS", "Display precision" to say keys live on the profile); `CLAUDE.md` System Stats (models 37 → 38 re-derived by grep; config defs count unchanged; any new route); `apps/api/CLAUDE.md` migration entry; `packages/shared/CLAUDE.md` type-file count (re-derive). Stale-stat sweep for the old numbers.
- [ ] `tasks/todo.md` ticks; memory: project file ledger (not pushed / not deployed), feature memory.
- [ ] Commit `docs: profile measurements phase 1`.
