# Profile measurements — each instrument profile defines what it measures

**Date:** 2026-10-26
**Status:** design, approved to proceed ("proceed")

## The ask, in the operator's words

1. "temperature and humidity keys assining or limits keys assigning configurations are there right
   those should be updated instrument profiles wise, each profile can receive different keys"
2. Asked what other device they have in mind: "pressue or other differnet sensors values or like that"
3. Asked whether a pressure sensor needs the same full treatment temperature gets (dashboard value,
   limit alarms, trend page, Data and Alarm reports): "proceed and also in in instrument profiles NLT
   and MNT attributes and MKT attributes are should be enabled or disabled should come"

## Intent

A **profile is a device type**. Today every instrument, whatever its profile, is read through ONE
global set of key mappings, and the whole application understands exactly two measurements —
temperature and humidity. The operator will connect other sensors (pressure, CO₂, …) whose devices
send different keys and measure different things.

After this work a profile says **what its devices measure** and **which keys carry each measurement**,
and every surface — ingest offsets, alarms, dashboard, floor tiles, trend page, Data Report, Alarm
Report — works from the instrument's own profile.

## Goals

- **G1 — Key mappings per profile.** Each profile holds, per measurement: the device payload keys,
  the decimals attribute + fallback, the high (NMT) and low (NLT) limit attribute keys and their
  per-instrument enable attribute keys, the range attribute keys, the offset attribute keys, and MKT.
- **G2 — Profile-level on/off for NMT, NLT and MKT, per measurement** (the third ask).
- **G3 — Any number of measurements per profile**, not just temperature and humidity, with the same
  treatment temperature gets today: value on the dashboard and floor tiles, limit / range / RS485
  alarms, offsets, trend page, Data Report columns, Alarm Report.
- **G4 — Nothing changes for today's instruments.** The existing profile is filled in from each
  install's own current global settings, so the 102 local instruments (and AWS's) behave exactly as
  before on the day this ships.

## Non-goals

- **Floorplan ROOM limits stay temperature/humidity only.** `floorplan_rooms.temp_min/temp_max/
  rh_min/rh_max` keep applying to the TEMPERATURE and HUMIDITY measurements. A room has no limit for
  any other measurement. (Per-measurement room limits would be a Layout Designer project of its own.)
- **No administered alarm-type wording for new measurements.** The nine administered names
  (`alarm-type-names`) keep governing TEMPERATURE and HUMIDITY. Any other measurement's alarm types
  are composed from its name ("High Differential Pressure", "Differential Pressure Communication
  Failure", …).
- **No administered trend-widget wording for new measurements.** The administered titles
  (`trend-widgets`: `tempCardTitle`, …) keep governing TEMPERATURE / HUMIDITY; other measurements'
  cards are titled by the measurement name.
- **No unit conversion.** A measurement has one unit; readings are stored as sent.
- **Signed report snapshots are never migrated** (`report_reviews.dataSnapshot` is frozen).

## Anti-goals (would make this a failure even if it technically works)

- Any of today's instruments showing a different value, limit, colour, decimals, alarm or MKT figure
  on the day it ships.
- A stored alarm being rewritten. `alarms.metric` values `TEMPERATURE`, `HUMIDITY`, `OFFLINE` must
  stay byte-identical.
- Alarm-behaviour configuration (today SUPER_ADMIN-only) becoming editable by anyone with Instrument
  Update because it moved onto the profile.
- The browser deciding which key is a temperature, which attribute is a limit, or whether a value
  breaches (CLAUDE.md "Never reconstruct server-side decision logic in the client").

## Constraints (from the code, verified 2026-10-26)

- Telemetry storage is key-agnostic: `instrument_telemetry_history` / `_latest` store `(instrument_id,
  key, value, …)` verbatim. **No storage change is needed** for new measurements — local already holds
  `co2`, `pressure`, `battery` readings that nothing displays.
- `alarms.metric` is a Postgres enum `AlarmMetric {TEMPERATURE, HUMIDITY, OFFLINE}`; four indexes
  include it, three of them PARTIAL UNIQUE (`alarms_active_instrument_limit_unique`,
  `alarms_active_rs485_unique`, `alarms_active_sensor_range_unique`) plus
  `alarms_source_instrument_id_metric_limit_kind_state_idx`. `prisma migrate diff` proposes dropping
  the partial indexes and the partitioned telemetry table — migrations here are hand-written.
- Fastify strips response fields its schema does not declare: every new field/array must be declared,
  inner keys included, or the browser silently receives `{}`.
- `notification_rules.conditions` can match on `metric` — 0 rules exist locally (queried
  2026-10-26); AWS unknown. Keeping TEMPERATURE/HUMIDITY byte-identical keeps any such rule working.
- Most two-way branches test only `metric === 'TEMPERATURE'`, so a third value silently takes the
  humidity path. Every such branch must become a lookup; none may survive as a ternary.
- Ingest is the hot path; a gateway batch fans out to children that may sit on different profiles.
- The compliance test DB (`compliance_core_db_test`) is migrated separately.

## Decisions

### D1 — Measurement TYPES are a small global registry; profiles choose from it

New model **`MeasurementType`** (table `measurement_types`):

| column | notes |
|---|---|
| `code` PK | `^[A-Z][A-Z0-9_]{1,31}$`, **immutable**. `OFFLINE` reserved. Stored verbatim in `alarms.metric`. |
| `name` | display name, editable ("Differential Pressure") |
| `unit` | "°C", "%RH", "Pa"; **immutable once any profile uses the type** (stored readings carry no unit) |
| `sort_order` | default column order across the fleet |
| `created_at/updated_at/created_by/updated_by` | |

Seeded by the migration: `TEMPERATURE` (Temperature, °C, 1), `HUMIDITY` (Humidity, %RH, 2).

**Why a registry rather than name/unit on each profile:** fleet views (the dashboard table, the
aggregate trend, a room's history, the Alarms filter) need ONE identity per measurement across
profiles — "Temperature in profile A" and "Temperature in profile B" are the same column. A code
shared by name alone would split on a typo and contradict itself on unit.

A type can be deleted only while no profile uses it and no alarm carries its code.

### D2 — A profile's measurements are a JSON list on the profile

New column **`instrument_profiles.measurements JSONB` (nullable)**, validated by ONE zod
schema in `@digilog/shared` (`profileMeasurementsSchema`). Array order = display order on that
profile's instruments. Each entry:

```ts
{
  code: 'TEMPERATURE',                 // a MeasurementType.code; unique within the profile
  deviceKeys: ['t', 'temperature'],    // payload keys, ordered, first match wins (today's alias rule)
  decimals: { attributeKeys: ['temp_decimals'], fallback: 1 },
  high: { enabled: true, limitKeys: ['t_hl', 'High Temperature Limit'], enableKeys: ['Enable_Temp_NMT'] }, // NMT
  low:  { enabled: true, limitKeys: ['t_ll', 'Low Temperature Limit'],  enableKeys: ['Enable_Temp_NLT'] }, // NLT
  range: { highKeys: ['High Temperature Range'], lowKeys: ['Low Temperature Range'] },
  offsetKeys: ['Temp Off set'],
  mkt: { enabled: true, attributeKeys: ['isMktCalculationEnabled'] },
}
```

Validation (server-side, refused with a named error):
- `code` exists in the registry; codes unique within the profile.
- A device key belongs to at most one measurement in the profile (case-insensitive).
- An attribute key plays at most one role across the profile's measurements (a limit key of one
  measurement cannot be the offset key of another).
- `mkt.enabled` only on a measurement whose type unit is `°C` (the MKT formula is Kelvin-based).
- `decimals.fallback` 0…`TELEMETRY_DECIMALS_MAX`.

JSON rather than a child table: the list is configuration edited and audited as a whole, exactly like
`attributeKeys` on the same row; the precedent is `floorplan_rooms.doors`.

Three states, the `attributeKeys` precedent on the same row:
- a list — this profile's own measurements;
- `[]` — the profile measures nothing (a deliberate SUPER_ADMIN choice);
- `NULL` — never customised: read as **`DEFAULT_PROFILE_MEASUREMENTS`** (shared constant: TEMPERATURE
  + HUMIDITY built from the shipped default key lists, humidity device keys including `h`, which this
  plant's devices send). A read-side safety net: the migration backfills every existing profile and
  `POST` writes the defaults explicitly.

**A NEW profile starts with the default TEMPERATURE + HUMIDITY measurements** (written explicitly),
not `[]` — a profile created by someone who cannot edit measurements (D4) must never yield
instruments that silently monitor nothing. A SUPER_ADMIN removes them for a pressure-only profile;
the editor also offers "Copy measurements from…" another profile.

### D3 — Profile switch AND instrument attribute (the third ask)

The profile's `high.enabled` / `low.enabled` / `mkt.enabled` is an AND gate in front of today's
per-instrument attributes:

| profile switch | enable/MKT attribute keys | result per instrument |
|---|---|---|
| off | (any) | bound never enforced / MKT never computed |
| on | listed | the instrument's attribute decides **exactly as today**: bound enable absent/blank/unreadable = ENABLED; MKT absent = OFF |
| on | empty list | always enforced / MKT always computed |

Both of today's defaults are kept deliberately (feature notes: "a typo can never silence a bound";
MKT "OFF by default … the opposite default from the limit enable flags, on purpose").

A bound switched off at profile level behaves exactly like one switched off per instrument today:
withheld from the overview (`limits` null for it), never raised, and **an alarm open on it is cleared**
by the next evaluation. Because that is a bulk action on regulated records, the profile editor shows
how many open alarms the change will clear before saving, and the save requires a reason (audited).

Assumption, stated: "NLT and NMT attributes and MKT attributes … enabled or disabled should come" is
read as profile-level on/off switches. It is NOT read as "render the per-instrument `Enable_*` /
`isMktCalculationEnabled` attributes as toggles instead of typed 0/1"; that is not built.

### D4 — Who may change it

Measurements are alarm-behaviour configuration — today SUPER_ADMIN-only (`telemetry-slots`,
`alarm-limits`, `sensor-range-alarms`, `sensor-offsets` are all `requiredRole: 'SUPER_ADMIN'`). They
stay so, **enforced in the route**, not only the UI:

- `PUT /api/instrument-profiles/:id` carrying `measurements` → 403 unless SUPER_ADMIN; re-auth
  `UPDATE_INSTRUMENT_PROFILE`; `reason` required whenever `measurements` changes.
- `POST /api/instrument-profiles` carrying non-empty `measurements` → same.
- **Moving an instrument to another profile** (`PUT /api/instruments/:id` `profileId`, and the bulk
  CSV path) is refused `403 MEASUREMENTS_DIFFER` for anyone but a SUPER_ADMIN when the two profiles'
  resolved measurements differ. Otherwise a holder of Instrument Update could stop an instrument's
  alarms — and clear its open ones — by moving it into a profile that measures less or has a bound
  switched off, bypassing the reason and the alarm-count preview above. A move between profiles
  with identical measurements stays open to Instrument Update, as today. Creating an instrument in
  any profile stays open (nothing open can be stranded; it gets what that profile says).
- Non-SUPER_ADMIN profile reads still receive the measurement list (names, units, codes — needed to
  render), with offset keys removed (offsets are SUPER_ADMIN-only today, `keysFor`).
- Registry writes (`POST/PUT/DELETE /api/measurement-types`) → SUPER_ADMIN + new re-auth action
  `UPDATE_MEASUREMENT_TYPE` (category `Configuration`); reads → any authenticated user.
- Audit: `INSTRUMENT_PROFILE_UPDATED` before/after now includes `measurements`; new actions
  `MEASUREMENT_TYPE_CREATED` / `_UPDATED` / `_DELETED` with templates.

### D5 — Alarm identity

- `alarms.metric` becomes **TEXT** (hand-written migration: `ALTER COLUMN metric TYPE text USING
  metric::text`, recreate the four indexes byte-for-byte, then `DROP TYPE "AlarmMetric"` — its only
  user since `alarm_rules` went). Existing rows are untouched in content. Enum count 13 → 12.
- `metric` holds the measurement type code (or `OFFLINE`).
- The snapshot of every NEW alarm additionally freezes `measurementName` and `unit`, so an Alarm
  Report prints the unit as it was even after a rename. Old alarms without them fall back to the
  registry (TEMPERATURE → °C, HUMIDITY → %RH as today).
- **Stranded alarms.** An open LIMIT / RS485 / RANGE alarm whose code is no longer among the
  instrument's profile measurements (measurement removed, instrument moved to another profile) can
  never clear on its own. The evaluator clears it, the same way a switched-off bound is cleared
  today, recording `clearedReason: 'MEASUREMENT_REMOVED'` in the snapshot fields the inactivity clear
  already merges.
- Alarm-type keys: TEMPERATURE/HUMIDITY keep today's nine administered keys. Other codes compose
  their names (non-goal above). The Alarms page type filter takes its options FROM THE SERVER
  (`GET /api/alarms/type-options`): today's tokens stay valid; new ones are `LIMIT_HIGH:<CODE>`,
  `LIMIT_LOW:<CODE>`, `RS485:<CODE>`, `RANGE:<CODE>`.
- Sorting by type orders by the registry's `sort_order`, then code — not by Postgres enum order,
  which the TEXT change would otherwise silently turn alphabetical.

### D6 — One server-side resolver

`apps/api/src/modules/instruments/profile-measurements.ts` is the ONE place that answers "what does
this instrument measure and which keys carry it". It loads every profile's measurements joined to
the registry, caches for 10 s (the `load-offsets` precedent), and is invalidated by profile and
registry writes. It replaces the FOUR duplicate readers of the global settings
(`telemetry-overview.loadAliases`, `load-offsets.slotAliases`, `room-history.slotAliases`,
`decimals.loadDecimalsConfig`) and `load-limits` / `load-range`'s key lists. Ingest resolves once
per PROFILE in a batch, never per instrument.

"Valued keys" (attribute keys shown at a measurement's precision) are DERIVED: a measurement's limit
and range keys. NOT its offset keys — no install lists them as valued today, and formatting them now
would change how they display (G4). The global `temperatureValuedKeys` / `humidityValuedKeys` lists go; their
extra entries (`High Temperature`, `Temp High`, …) are carried by NO attribute on this install
(queried 2026-10-26).

### D7 — What happens to the four global configuration pages

| def | keeps | loses (moved to profiles) |
|---|---|---|
| `telemetry-slots` (renamed "Dashboard Refresh") | `overviewRefreshSeconds`, `chartRefreshSeconds` | temperature/humidity keys, decimals keys, valued keys, fallback decimals |
| `alarm-limits` | `enabled`, `disabledLimitText`, four status wordings | 4 limit key lists, 4 enable key lists |
| `sensor-range-alarms` | `enabled`, `rangeText` | 4 range key lists |
| `sensor-offsets` | `enabled` | 2 offset key lists |

The stored JSON keys are left in `system_config` (harmless, unread) rather than rewritten.

**Pre-existing bug fixed on the way:** the browser reads `/api/config/dynamic/telemetry-slots` for the
refresh intervals and fallback decimals, but that def is SUPER_ADMIN-only, so every other role gets
403 and silently runs on hardcoded defaults. Refresh settings move to an endpoint every authenticated
user can read; decimals already ride on each row.

**Pre-existing client logic removed on the way:** `hooks/use-offset-keys.ts` classifies offset
attributes in the browser from the raw `sensor-offsets` config. The server marks offset attributes
(`isOffset`) on the attribute payloads instead.

### D8 — The migration (hand-written SQL)

1. Create `measurement_types`, seed TEMPERATURE / HUMIDITY.
2. Add `instrument_profiles.measurements`, then fill EVERY existing profile with
   `[TEMPERATURE, HUMIDITY]` built from THAT install's own `system_config` rows
   (`telemetry-slots`, `alarm-limits`, `sensor-range-alarms`, `sensor-offsets`), each list falling
   back to the shipped default (`COALESCE`) exactly as the loaders do today. NMT/NLT `enabled: true`;
   MKT: TEMPERATURE `{enabled: true, attributeKeys: ['isMktCalculationEnabled']}`, HUMIDITY
   `{enabled: false, attributeKeys: []}` — today's behaviour.
3. `alarms.metric` enum → text (D5).
4. Applied to `compliance_core_db` AND `compliance_core_db_test`. AWS gets it on deploy and copies
   ITS OWN global values (they may differ from local).

### D9 — Live reads re-resolve; signed snapshots do not

Live screens and live report generation resolve keys under the instrument's CURRENT profile. Changing
a profile's device keys, or moving an instrument to another profile, therefore re-labels its history
on every live read. That is today's behaviour for the global mapping and is kept; it is stated so it
is not mistaken for a bug. Signed / approved report snapshots are frozen and unaffected.

### D10 — API shapes for N measurements

- **Overview row** gains `measurements: [{ code, name, unit, key, value, ts, decimals, limits:{high,
  low}, limitEnabled:{high,low}, limitText:{high,low}, range:{high,low}, sensorError, rangeError,
  state }]` where `state` is the SERVER's verdict per measurement (`OK | HIGH | LOW | OUT_OF_RANGE |
  SENSOR_ERROR | NO_DATA`) so no screen judges a value itself. During phases 1–2 the legacy
  `temperature`/`humidity`/`decimals`/`limits`… fields stay, derived from the TEMPERATURE / HUMIDITY
  entries; phase 3 removes them once no consumer reads them.
- `computeInstrumentStatus` takes the measurement list. Room limits feed only TEMPERATURE/HUMIDITY.
- `/:id/telemetry` rows: `slot` → `measurement` (code | null) plus the measurement's decimals; each
  row carries the server's verdict where a screen bolds or colours it (trend table, Data Report).
- `/:id/telemetry-keys`, aggregate, room-history: keyed by code; the aggregate SQL groups by a
  `(instrument_id, key) → code` VALUES join, not by "temperature else humidity".
- MKT: computed for a measurement iff D3 says so for that instrument and that measurement.
- Report kinds: `temperature-trend` and `humidity-trend` stay; one new kind **`measurement-trend`**
  ("Other Measurement Trend", inherits `trendChart`) governs every other measurement's chart download.
- Webhook/notification variables: `metric` stays the code; new `measurement` (name) and `unit`.

### D11 — Screens

- **Configuration → Instrument Attributes** (the existing SUPER_ADMIN profile editor) gets a
  **Measurements** section for the selected profile: one card per measurement with the fields of D2;
  attribute-key fields are ordered tag lists suggesting the profile's own attribute keys; NMT / NLT /
  MKT are on/off toggles (D3); MKT is offered only on a °C measurement; "Add measurement" picks a
  registry type or creates one (name + unit); "Copy measurements from…". Saving shows the open-alarm
  count a switch-off will clear and asks for a reason.
- **Dashboard table:** one column group per measurement present among the listed instruments, in
  registry `sort_order`; widths computed, not hand-balanced.
- **Floor tiles:** one chip per measurement; chip geometry parameterised by count. Verified at a
  dashboard panel's size with the LONGEST label in the SMALLEST room (operator rule).
- **Room detail / aggregate trend card:** one chart per measurement.
- **Trend page:** gauges, charts and time-series tables map over the instrument's measurements.
- **Data Report PDF:** DATE, TIME + one column per measurement; landscape when more than three; NMT/NLT
  legend and MKT per measurement from the server.
- **Alarm Report / Alarms page:** UOM from the alarm snapshot (fallback registry); type filter options
  from the server.
- **Settings page tiles:** colour by measurement, not by a two-way slot.

## Phasing (each phase is shippable on its own)

1. **Per-profile keys for today's two measurements.** Registry (TEMPERATURE/HUMIDITY only, no create
   UI yet), `measurements` column + migration, D3 switches, D4 gates (profile edit AND instrument
   move), D5's stranded-alarm clearing (a SUPER_ADMIN can remove HUMIDITY from a profile in this
   phase already), D6 resolver replacing the four readers, D7 config pages trimmed + the two
   pre-existing fixes, the profile editor section.
   **Proof of G4:** the existing overview e2e and alarm-worker tests pass with ONLY their setup moved
   from `system_config` to the profile — no assertion edits.
2. **Server for N measurements.** Registry CRUD, `alarms.metric` → text, worker loops, overview
   `measurements[]` + per-measurement verdicts, aggregate / room-history / telemetry by code, MKT per
   measurement, report kind, alarm type options, webhook variables.
3. **Screens for N measurements.** Every screen of D11, then removal of the legacy two-slot fields.

## Calls made after the builder check (author's, not the operator's — open to override)

- **Instrument moves between profiles with different measurements are SUPER_ADMIN-only** (D4). The
  check found that without it, Instrument Update could silence an instrument's alarms by moving it.
  Locally no role but SUPER_ADMIN holds Instrument Update today (queried 2026-10-26); AWS unchecked.
- **New profiles start with Temperature + Humidity, not empty** (D2), so an instrument can never be
  created into a profile that silently monitors nothing.
- **Offset keys are not "valued" keys** (D6).
- **"Is this key an offset" without an instrument** (role screens, device attribute report/downlink)
  = listed as an offset key by ANY profile: hidden from non-super-admins and never sent to a device.
- **Stranded-alarm clearing ships in phase 1**, not 2.

## Left to the builder

- Exact component structure of the Measurements editor, as long as it uses the UI v3 primitives.
- Colours for measurements beyond the two existing hues (extend `SERIES_COLORS`; a seventh must not
  silently reuse the first).
- Exact error codes / messages for the D2 validations.
