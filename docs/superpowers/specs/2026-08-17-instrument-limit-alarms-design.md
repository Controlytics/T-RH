# Instrument-limit alarms — design

**Date:** 2026-08-17
**Status:** approved, not yet implemented
**Supersedes nothing.** Extends `2026-08-13-alarm-subsystem-design.md`.

## The ask

Alarms raised from each instrument's own **High/Low Temperature Limit** and
**High/Low Humidity Limit** attributes: below the low limit raises a LOW alarm,
above the high limit raises a HIGH alarm. The Alarms page shows instrument,
raise time and the value at that moment, the alarm type, clear time and the
value at that moment, the limit that was breached, the acknowledgement control,
and a status that distinguishes still-pending-unacknowledged from cleared. The
status wordings are configurable in one super-admin setting.

## Why this is not just "add a threshold field"

Limits already exist in **three** places in this codebase, and the history
matters:

1. `instrument_attributes` — the four `* Limit` keys. Migration
   `20260811130000_retire_limit_attributes` removed them from the registration
   **prompts** on the reasoning that a cleanroom's spec belongs to the room, not
   to whichever probe is bolted to its wall. They have since been re-added to the
   `Default` profile's `attribute_keys`, so instruments prompt for them again.
2. `floorplan_rooms.temp_min/temp_max/rh_min/rh_max` — added by that same change.
   These colour the dashboard today via `computeInstrumentStatus()`.
3. `alarm_rules.threshold_low/threshold_high` — what the evaluator reads now.

This design deliberately **reverses the 2026-08-11 direction for alarming only**:
the operator has asked for the instrument's own attributes to drive alarms.
Room limits are NOT retired — they keep colouring the dashboard and raise
nothing. Two sources, each with exactly one job, each labelled as such in the UI.

Live data proves the risk this creates. The database currently holds
`High Temperature`, `Low Temperature` **and** `Low Temperature Limit` as three
separate attribute keys. A key that does not match exactly means **no alarm and
no warning** — the worst failure mode this feature can have, because a plant with
nothing being watched looks identical to a plant running perfectly.

Current state: **0 alarm rules, 0 alarms**. Nothing in production depends on the
existing wiring, which is why the schema change below is affordable.

## 1. Where limits come from — the `alarm-limits` config

A new super-admin config module, `apps/api/src/modules/config/defs/alarm-limits.def.ts`,
following `telemetry-slots.def.ts` exactly: same `system_config` row shape, same
newline-separated alias format, same `requiredRole: 'SUPER_ADMIN'`, rendered by
the dynamic config page (`hasCustomPage: false`, so no new `routes/config/*.tsx`).

Four settings, each a textarea of **attribute key names, most-preferred first**:

| Setting key | Default value |
|---|---|
| `temperatureHighKeys` | `High Temperature Limit`<br>`High Temperature`<br>`Temp High` |
| `temperatureLowKeys` | `Low Temperature Limit`<br>`Low Temperature`<br>`Temp Low` |
| `humidityHighKeys` | `High Humidity Limit`<br>`High Humidity`<br>`RH High` |
| `humidityLowKeys` | `Low Humidity Limit`<br>`Low Humidity`<br>`RH Low` |

Aliases, not a single fixed name, because that is what the existing key drift
requires: both `High Temperature` and `High Temperature Limit` resolve without
anyone re-keying existing instruments.

Two further settings on the same page:

| Setting key | Type | Default | Purpose |
|---|---|---|---|
| `severity` | select | `CRITICAL` | Severity carried by every instrument-limit alarm. |
| `enabled` | boolean | `true` | Master switch for the whole attribute-driven pass. |

Plus the four status texts of §4.

### Parsing rules (in `@digilog/shared`)

New module `packages/shared/src/types/alarm-limits.ts`, mirroring
`telemetry-slots.ts` so the API and the web app cannot disagree:

- `parseLimitKeys(raw)` — trim, **lowercase**, drop blanks, de-duplicate keeping
  first. Order is precedence. Same contract as `parseTelemetryAliases`.
- `resolveLimit(keys, attributes)` — first key that any attribute matches wins,
  NOT first attribute that matches any key. Matching is case-insensitive on the
  trimmed key, because `instrument_attributes.key` is operator-typed free text.
- `parseLimitValue(raw)` — trimmed, must parse as a **finite number**. Implemented
  as an explicit numeric-string test, NOT `Number(raw)`: `Number("")` is 0 and
  `Number(" 25 ")` is 25, so a bare coercion would turn an empty attribute into a
  0 °C limit. Rejects anything with trailing units.

`parseLimitValue` is strict on purpose. `"25"` and `"25.0"` are 25. `""`,
`"twenty five"`, `"25 C"` and `"n/a"` are **not set** — never zero. A limit read
as 0 would alarm on every reading forever, which trains operators to ignore
alarms; that is worse than not alarming at all, and is the same reasoning already
recorded in `decide.ts` for a missing threshold.

## 2. Raising and clearing

The existing `alarm-evaluation.worker.ts` gains a second pass, after the rule
pass. It reuses `buildTelemetryOverview()` — the same call the rule pass and the
dashboard already use — so "which telemetry key counts as temperature" resolves
identically everywhere and cannot drift.

Per instrument, per metric, per bound:

- reading **>** high limit → raise a HIGH alarm
- reading **<** low limit → raise a LOW alarm
- reading exactly **at** a limit → **in spec**, no alarm. Matches `isBreaching()`
  for `OUTSIDE_RANGE` and `breaches()` for room limits. Boundaries are in spec
  throughout this system and this must not become the one place they are not.
- no reading, or a non-numeric reading → **not a breach**. "The probe went quiet"
  is the `OFFLINE` metric's concern; conflating them would make an excursion and
  a dead probe indistinguishable in a regulated record.
- high and low are **independent alarms**. One instrument can hold at most one of
  each per metric, and cannot be both at once. Identity for "is one already
  active" is therefore the tuple
  `(instrumentId, source=INSTRUMENT_LIMIT, metric, limitKind)` — the equivalent of
  the rule pass's `(ruleId, instrumentId)` key, and what stops one excursion
  producing an alarm per evaluation cycle.
- an inverted pair (low limit above high limit) is a **misconfiguration and must
  not fire**: both bounds are skipped and the instrument is counted in §5's
  "no limits set" line. The alternative — every reading breaching one bound or
  the other, forever — is the alarm-fatigue failure this codebase already guards
  against for missing thresholds.
- no limit set for a bound → that bound is never evaluated (§5).

Clearing mirrors the rule pass: the condition ending sets `state = CLEARED` and
`clearedAt`, and **never touches the acknowledgement fields**. A
cleared-but-unacknowledged alarm is the overnight excursion somebody must still
answer for in the morning.

The decision logic goes in a new pure module,
`apps/api/src/modules/alarms/limit-decide.ts`, beside `decide.ts` and unit-tested
the same way. The worker does I/O only.

### Schema changes

```prisma
model Alarm {
  ruleId String? @map("rule_id")   // was: String  — nullable now
  source AlarmSource @default(RULE)
  clearedValue Float? @map("cleared_value")
  limitKind AlarmLimitKind?  @map("limit_kind")   // HIGH | LOW, null for rule alarms
  ...
}

enum AlarmSource { RULE INSTRUMENT_LIMIT }
enum AlarmLimitKind { HIGH LOW }
```

`ruleId` becomes nullable because an attribute-driven alarm has **no rule row**,
and inventing a synthetic one would put editable rules on the Alarm Rules page
that silently disagree with the attribute they came from.

`ruleSnapshot` is still written for instrument-limit alarms. It freezes
`{ source, metric, limitKind, limit, attributeKey, description, snapshotAt }` —
the limit **as it was when the alarm fired**. Changing an instrument's limit
afterwards must never rewrite what a historical alarm says about itself. This
snapshot is what feeds the "Limit" column; the page never reads the live
attribute for a historical row.

`clearedValue` is new data — nothing records the reading at clear time today.

Migration is hand-authored (never `migrate diff` — it wants to drop the
partitioned telemetry history table here) and must be applied to
`compliance_core_db_test` as well, or every instrument-touching e2e 500s.

## 3. The Alarms page

Columns, in the order requested:

| Instrument | Type | Raised | Value at raise | Limit | Cleared | Value at clear | Status | Acknowledge |
|---|---|---|---|---|---|---|---|---|

- **Type** — `High Temperature` / `Low Humidity` etc. for limit alarms; the rule
  name for rule alarms.
- **Limit** — from `ruleSnapshot`, e.g. `> 25.0 °C`. Never the live attribute.
- **Value at raise / at clear** — `triggeredValue` / `clearedValue`. `0` is a real
  reading and renders as `0`; absent renders `—`. The existing `triggeredText()`
  already gets this right and is reused.

The severity column and the two tabs stay. `alarm-display.ts` keeps its existing
role as the pure, tested display module; the new status resolution goes there.

## 4. Configurable status texts

Status is the product of two **independent** axes — the condition (still
breaching / ended) and the signature (signed / not signed). Four combinations,
each a setting on the `alarm-limits` config page:

| Setting key | Condition | Acknowledged | Default text |
|---|---|---|---|
| `statusActiveUnack` | still breaching | no | `Still pending Unacknowledged` |
| `statusActiveAck` | still breaching | yes | `Active — Acknowledged` |
| `statusClearedUnack` | ended | no | `Cleared — Unacknowledged` |
| `statusClearedAck` | ended | yes | `Cleared` |

Resolution is a pure function in `alarm-display.ts`:
`statusText(alarm, texts)`. A blank setting falls back to the default rather than
rendering an empty cell.

Keeping all four separately editable preserves the distinction the subsystem was
built around: `Cleared — Unacknowledged` must never be collapsible into
`Cleared`, or the overnight excursion nobody answered for reads as finished.

Acknowledgement is unchanged — reason (5–500 chars) + re-authentication + an
`ALARM_ACKNOWLEDGED` audit row, and 409 on a second attempt so the first
signature stands.

## 5. Instruments with no limits

A bound with no limit is never evaluated, silently — correct behaviour, but it
makes an empty Alarms page ambiguous between "everything is in spec" and
"nothing is being watched".

So `GET /api/alarms/summary` gains `instrumentsWithoutLimits`, and the page shows
a line above the table: **"N instruments have no limits set"**, expanding to the
list of instrument codes. Counted over instruments visible to the caller, through
the same `instrument_scope` visibility used everywhere else.

## 6. Permissions

**No new permissions, privileges, reauth actions or sidebar items.** Reading
alarms is `ALARM_READ`, acknowledging is `ALARM_ACKNOWLEDGE` + reauth, and the
config page is `CONFIG_READ`/`CONFIG_UPDATE` gated with `requiredRole:
'SUPER_ADMIN'` — all of which already exist. The counts in CLAUDE.md do not move.

## 7. Testing

Unit (`limit-decide.ts`), each a case that has bitten this codebase before:

1. reading exactly at the limit → no alarm (boundary in spec)
2. missing limit → never fires
3. non-numeric limit (`"twenty five"`, `""`, `"25 C"`) → never fires, **not zero**
4. alias precedence — an instrument holding both `High Temperature` and
   `High Temperature Limit` resolves by config order, deterministically
5. high and low independence
6. no reading → not a breach (not conflated with OFFLINE)
7. clear captures `clearedValue`
8. rule alarms and limit alarms coexist without either clearing the other
9. inverted pair (low 30 / high 20) → no alarm on either bound
10. a second evaluation cycle while still breaching holds, never re-raises

Shared (`alarm-limits.ts`): parse/resolve/value cases, mirroring the existing
`telemetry-slots.test.ts`.

Web (`alarm-display.ts`): all four status texts, blank-setting fallback, and that
`Cleared — Unacknowledged` never collapses to `Cleared`.

E2E: set attributes → push a reading over the limit → assert exactly one alarm
with the correct frozen limit and type → push an in-spec reading → assert cleared
with `clearedValue` and acknowledgement untouched.

## 8. Explicit non-goals

- Room limits are **not** retired and **not** made an alarm source.
- Alarm rules are **not** removed; they remain for offline, per-location and
  delayed conditions that attributes cannot express.
- No delay/debounce on instrument-limit alarms in this iteration. The rule
  subsystem has `delaySeconds`; adding it here needs the same breach-history
  query and is deferred until asked for.
- No notification changes beyond reusing `enqueueAlarmNotification` as-is.

## 9. Verification caveat

Chrome on this machine cannot reach loopback or LAN addresses through the
automation extension (MDM policy `LocalNetworkAccessAllowedForUrls` allowlists
only two SharePoint origins; plain HTTP on `127.0.0.1` fails identically to
HTTPS, so it is not the mkcert certificate). Every claim in the implementation
will be backed by tests, `tsc --noEmit`, `vite build` and direct database
queries. **The rendered visual check belongs to the operator** and will be
requested explicitly, not assumed.
