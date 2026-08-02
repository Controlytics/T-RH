# Data Injection P3 — Alarms & Device Liveness (Design)

**Date:** 2026-08-03
**Branch:** `data-injection`
**Status:** Approved design, not yet planned or implemented
**Predecessors:** P1 (configuration backbone), P2 (MQTT telemetry end-to-end)

---

## 1. Purpose

P2 stores telemetry. Nothing looks at it. P3 makes a reading that falls outside
its configured limits produce a **latched, human-dispositioned, e-signed
excursion record**, and makes an instrument that stops reporting produce a
device-offline event.

This is the first phase in which the platform *reacts* to instrument data rather
than merely recording it.

## 2. Scope

**In scope**

- Threshold definitions per instrument + telemetry key.
- Alarm lifecycle with latching and human acknowledgement (21 CFR Part 11
  e-signature).
- Re-trigger accounting so a flapping sensor produces one excursion, not N.
- Device liveness: online / offline detection via a scheduled silence sweep.
- First-ever emission of the three `DEVICE_*` notification event types, plus two
  new alarm event types.
- RBAC, audit wiring, and the operator-facing alarm queue UI.

**Explicitly out of scope**

- Attribute / config storage (P4).
- Retention, inspector export, dead-letter resolution workflow (P5).
- Commands / RPC and the per-device credential model they require (P6).
- Severity escalation by breach magnitude — see §11.1.
- Root-cause suppression (gateway down → suppress child instrument alarms) —
  see §11.2.

## 3. Decisions taken, with reasoning

| Decision | Chosen | Rejected alternative and why |
|---|---|---|
| Alarm lifecycle | **Latched** — survives value recovery, requires signed ack | Auto-clear (ThingsBoard default). An unattended 5-minute excursion that self-erases leaves no record demanding review — the exact artefact an inspector asks for. |
| Threshold storage | **Own `AlarmThreshold` model** | `InstrumentSetting.values` JSON blob. Cannot be indexed; "who changed the limit and when" degrades to a blob diff rather than field-level audit. |
| Liveness detection | **Silence timeout on a scheduled sweep** | Heartbeat-only. A device that dies silently never sends a heartbeat, so the failure mode that matters most is the one heartbeats cannot see. |
| Flapping sensor | **One alarm row + re-trigger counter** | One row per breach. 200 latched alarms each needing a signed ack makes the queue unusable and trains operators to bulk-ack without reading. |
| Expected-interval location | **Column on `Instrument`** | `InstrumentSetting.values`. Same auditability objection as thresholds, plus the sweep filters on this field and a JSON key cannot be indexed. |

## 4. Ground truth established before designing

Verified against live code on 2026-08-03. These findings shaped the design and
must be re-verified if this spec is picked up later.

### 4.1 The notification stack is live, but its device half has no emitter

`dispatchNotification()` (`apps/api/src/modules/notification-delivery/notification-dispatcher.ts:24`)
has **four production callers**:

| Caller | Event |
|---|---|
| `apps/api/src/app.ts:250` | `SYSTEM_ERROR` |
| `apps/api/src/modules/auth/auth.service.ts:72` | `USER_LOCKED` |
| `apps/api/src/modules/auth/auth.service.ts:279` | `USER_LOGIN` |
| `apps/api/src/modules/users/user.service.ts:153` | `USER_CREATED` |
| `apps/api/src/modules/notification-rules/routes.ts:351` | rule test harness |

`DEVICE_ONLINE`, `DEVICE_OFFLINE` and `DEVICE_INACTIVITY` are declared in the
`NotificationEventType` enum, carry field maps and default templates, and are
emitted by **nothing**. P3 is their first emitter.

Consequence: alarm notification follows a pattern already proven in production.
Rule matching, priority ordering, recipient resolution (ROLE / GROUP / USER),
six delivery channels, templating, cooldown and `NotificationLog` retry all
exist and are exercised today.

### 4.2 `matchConditions` filters, it does not evaluate

`NotificationRule.conditions` is a JSONB **filter** applied to dispatch context
(the schema's own comment gives `{"severity": ["CRITICAL","MAJOR"]}`). It is not
a threshold evaluator. Threshold evaluation is genuinely new work; severity-based
notification routing is not — it works as soon as severity ships in the context.

### 4.3 Exactly two files treat `NotificationEventType` as a closed set

Both must be widened in the same commit as the enum:

- `notification-dispatcher.ts` — four maps: `EVENT_LABELS` (:38),
  `EVENT_FIELDS` (:45), default templates (:283), summary templates (:403)
- `notification-rules/routes.ts:13` — the `EVENT_CATALOG` the rules UI renders

No frontend file hardcodes the list; the UI reads the catalog over the API. A
third list does not exist. *(Verified by grepping `USER_LOCKED`,
`CHECKLIST_REJECTED`, `DEVICE_INACTIVITY` across `apps/api/src`, `apps/web/src`
and `packages/shared`.)*

### 4.4 The ingest flush loop is the correct hook

`flushNow()` (`apps/api/src/modules/data-injection/ingestion.service.ts:52`)
already holds every reading in memory after `writeBatch` (:101-104). Evaluation
runs there — no second read of the database, and the readings are already
durable.

### 4.5 Constraints inherited from prior incidents

- `packages/queue/crontab.txt` — a cron identifier with no handler in `app.ts`'s
  `taskList` leaks jobs forever. This repo reached **51,798 orphan jobs** from
  exactly that. Handler and crontab line ship together.
- `flushNow`'s interval callback swallows errors (`catch(() => {})`, :111).
  Anything new hung off it needs its own surfacing error path.
- `SIDEBAR_ITEMS` (`packages/shared`) and `allNavItems`
  (`apps/web/src/components/layout/sidebar.tsx`) are two independent lists. A
  feature added to only the first ships with no nav link. This already happened
  on this branch.
- `vitest` does not typecheck. `npx tsc --noEmit` on both apps is part of done.

## 5. Data model

### 5.1 New enums

```
AlarmState        ACTIVE | ACTIVE_ACKED | RESOLVED_UNACKED | CLOSED
AlarmSeverity     CRITICAL | MAJOR | MINOR | INFO
ThresholdOperator GT | GTE | LT | LTE | EQ | NEQ | OUT_OF_RANGE
LivenessState     ONLINE | OFFLINE | UNKNOWN
```

`AlarmSeverity` values match the example already written into the
`NotificationRule.conditions` schema comment, so existing rule-authoring guidance
stays correct.

### 5.2 `AlarmThreshold`

| Field | Notes |
|---|---|
| `id` | uuid |
| `instrumentId` | FK → `Instrument`, `onDelete: Restrict` |
| `key` | telemetry key this threshold watches |
| `operator` | `ThresholdOperator` |
| `limit` | used by all operators except `OUT_OF_RANGE` |
| `limitLow`, `limitHigh` | used by `OUT_OF_RANGE` only |
| `hysteresis` | dead-band; value must return past the limit by this margin to count as recovered. Default `0`. |
| `severity` | `AlarmSeverity` |
| `isActive` | soft disable without deleting the definition |
| `createdBy`, `createdAt`, `updatedAt` | |

`@@unique([instrumentId, key, operator])` — permits a high limit and a low limit
on the same key, forbids two contradictory definitions of the same comparison.

Validation: `OUT_OF_RANGE` requires both bounds and `limitLow < limitHigh`; every
other operator requires `limit`. Enforced in the zod schema and asserted in tests.

### 5.3 `Alarm`

| Field | Notes |
|---|---|
| `id` | uuid |
| `instrumentId`, `key` | denormalised so the queue lists without joining |
| `thresholdId` | FK, `onDelete: Restrict` — a threshold with alarm history cannot be deleted |
| `severity` | copied from the threshold **at raise time**, so later edits to the threshold do not rewrite history |
| `state` | `AlarmState` |
| `firstBreachAt`, `lastBreachAt` | |
| `breachCount` | starts at 1, incremented on re-breach |
| `triggerValue` | the value that raised it |
| `peakValue` | worst value seen while open |
| `resolvedAt` | set when the value recovers |
| `ackedBy`, `ackedAt`, `ackReason` | the e-signature; `ackReason` is mandatory |
| `closedAt` | |

Partial unique index on `(instrumentId, key)` `WHERE state <> 'CLOSED'` — the
one-open-alarm-per-series rule is enforced by the **database**, not only by
evaluator logic. Prisma cannot express a partial unique index, so this is raw SQL
in the migration, mirroring the existing `hierarchy_nodes_root_slug_key`
precedent. The schema must carry a comment saying so, or a later `migrate diff`
will propose dropping it as untracked.

**Not partitioned.** Volume is low and every row is a record that must be
retained, so the `dropExpiredPartitions` hazard does not extend here. No delete
endpoint exists.

### 5.4 `InstrumentLiveness`

| Field | Notes |
|---|---|
| `instrumentId` | PK, FK → `Instrument`, `onDelete: Cascade` |
| `lastSeenAt` | updated on every successful telemetry write |
| `state` | `LivenessState`, defaults `UNKNOWN` |
| `stateChangedAt` | |
| `offlineAlarmId` | the open offline alarm, so recovery can close the right row |

State is **persisted** specifically so the sweep does not re-fire. A device dark
for a week must produce one offline alarm, not one per sweep interval.
`NotificationRule.cooldownMinutes` cannot serve this purpose — it is an in-memory
`Map` (`notification-dispatcher.ts:19`) wiped on every restart, as that file's own
TODO records.

### 5.5 `Instrument` — one new column

`expectedIntervalSec Int?` — nullable; a null means the instrument is exempt from
liveness monitoring. The sweep filters on this column, which is why it is a
column and not a key inside `InstrumentSetting.values`.

## 6. Alarm state machine

```
              breach
    (none) ───────────────▶ ACTIVE ─────── recover ──────▶ RESOLVED_UNACKED
                             │  ▲                              │      │
                        ack  │  └────────── re-breach ─────────┘      │ ack
                             ▼                                        ▼
                       ACTIVE_ACKED ─────── recover ──────────▶    CLOSED
```

| Event | From | To | Side effect |
|---|---|---|---|
| Breach, no open alarm | — | `ACTIVE` | create row; dispatch `ALARM_RAISED` |
| Breach, alarm open | any open | unchanged, or `RESOLVED_UNACKED` → `ACTIVE` | `breachCount++`, `lastBreachAt`, `peakValue` |
| Recover | `ACTIVE` | `RESOLVED_UNACKED` | set `resolvedAt` |
| Recover | `ACTIVE_ACKED` | `CLOSED` | set `resolvedAt`, `closedAt` |
| Ack (signed) | `ACTIVE` | `ACTIVE_ACKED` | audit row |
| Ack (signed) | `RESOLVED_UNACKED` | `CLOSED` | audit row, `closedAt`; dispatch `ALARM_ACKNOWLEDGED` |

Two invariants:

1. **`CLOSED` is only reachable through a human acknowledgement.** Nothing
   self-closes. This is the whole point of latching.
2. **A re-breach walks `RESOLVED_UNACKED` back to `ACTIVE`.** A flapping sensor
   cannot have its excursion closed out from under the operator reviewing it.

Recovery is measured against the limit adjusted by `hysteresis`, not the raw
limit, so boundary noise cannot toggle the state.

## 7. Evaluation flow

A **pure** evaluator, following the `fan-out.ts` precedent: resolution is
injected, the function never touches a database, and it returns a list of
intended transitions rather than performing them.

```
flushNow()
  ├─ … route / parse / fanOut  (unchanged)
  ├─ await writeBatch(...)                 ← readings become durable
  ├─ await evaluateAlarms(batches, …)      ← NEW, strictly after the write
  └─ await writeDeadLetters(...)
```

**Ordering is load-bearing.** Evaluating before the write would let a failed
write leave a latched excursion — one demanding a signed acknowledgement —
pointing at a reading absent from the history table. Under Part 11 an alarm
referencing a non-existent record is worse than a missed alarm.

Threshold and open-alarm lookups are cached **once per flush**, matching how
`buildResolverCache()` and `unsSettings()` are already loaded once per flush
rather than once per message.

**Error handling.** The evaluator gets its own `try`/`catch` that writes a
`DeadLetter` row and dispatches `SYSTEM_ERROR`. It must not inherit the interval
callback's silent `catch(() => {})` (`ingestion.service.ts:111`) — that would let
alarms stop firing while ingestion continued to look healthy, which is the
failure mode this whole phase exists to prevent.

`lastSeenAt` on `InstrumentLiveness` is updated in the same step. If liveness was
`OFFLINE`, the arriving reading flips it to `ONLINE`, dispatches `DEVICE_ONLINE`,
and closes the offline alarm (see §8).

## 8. Liveness sweep

New graphile-worker task `instrument_liveness_sweep`, every 5 minutes.

```
*/5 * * * * instrument_liveness_sweep ?id=instrument_liveness_sweep&max=1&fill=0s
```

The `?id=…&max=1&fill=0s` form matches every existing entry: `id` prevents a slow
handler overlapping itself, `max=1` caps queued instances, `fill=0s` stops
backfill after a restart.

**The handler must be registered in `app.ts`'s `taskList` in the same commit as
the crontab line.** `crontab.txt` documents that graphile-worker silently
enqueues jobs for unknown identifiers and never completes them; this repo reached
51,798 orphan rows that way.

Logic per sweep:

1. Select instruments with `expectedIntervalSec IS NOT NULL` and
   `isActive = true`.
2. Offline when `now - lastSeenAt > expectedIntervalSec × gracePeriodMultiplier`.
   The multiplier is a config value (default 2) so a single late message does not
   raise an alarm.
3. Transition `ONLINE`/`UNKNOWN` → `OFFLINE`: raise an offline alarm, store its
   id on `offlineAlarmId`, dispatch `DEVICE_OFFLINE`.
4. Already `OFFLINE`: **do nothing.** This is what the persisted state buys.

**Recovery auto-closes the offline alarm.** A device coming back is not a
deviation requiring disposition — the *threshold* excursions are what latch.
Offline alarms are therefore the single exception to the "nothing self-closes"
rule, and the exception is deliberate and documented here so it is not read as an
inconsistency.

`DEVICE_INACTIVITY` is left unemitted in P3. Its semantics (device connected but
not producing) need the attribute/status storage that P4 adds; emitting it from
the same silence check would make it a duplicate of `DEVICE_OFFLINE`.

## 9. 21 CFR Part 11 surface

Compliance is built **in this phase**, not deferred to P5. Retrofitting a
tamper-evident chain onto rows already written is precisely the corruption that
has already occurred once in this project's local database.

- **Acknowledgement is a signed action.** New reauth action `ACKNOWLEDGE_ALARM`,
  enforced through the existing `reauth-check.ts`. `ackReason` is mandatory and
  cannot be blank or whitespace.
- **Every alarm state transition writes a chained `AuditTrail` row** — raise,
  ack, close — through the existing hash-chained `lib/audit.ts`.
- **Threshold create / update / delete** are audited and reauth-gated under a
  second new reauth action, `MANAGE_ALARM_THRESHOLD`. One action covers all three
  mutations rather than three near-identical ones — the 2026-07-04 cleanup removed
  three `*_TEMPLATE_KIND` reauth actions precisely because per-verb actions that
  no endpoint discriminated on were theatre. Deleting a threshold that has alarm
  history is refused by the FK (`onDelete: Restrict`); `isActive = false` is the
  supported way to retire one.
- **No delete endpoint for alarms**, at any privilege level.
- Alarm `severity` is copied at raise time, so editing a threshold never rewrites
  the severity of a historical excursion.

## 10. Notification wiring

Two new `NotificationEventType` members: `ALARM_RAISED`, `ALARM_ACKNOWLEDGED`.
Plus first emission of the existing `DEVICE_ONLINE` and `DEVICE_OFFLINE`.

Widening a Prisma enum is a schema change, so per `apps/api/CLAUDE.md` this needs
a **hand-authored** migration reviewed from `prisma migrate diff`, with
`npm run db:verify-migrations` passing before commit. `prisma db push` and
`migrate dev` auto-generation are forbidden against a populated database.

The two closed-set files from §4.3 are widened in the same commit: four maps in
`notification-dispatcher.ts`, and `EVENT_CATALOG` in
`notification-rules/routes.ts`.

Dispatch context carries `severity`, `instrumentName`, `unsPath`, `key`, `value`,
`limit`, `breachCount` and `timestamp`. Severity-based routing then needs no new
code — `matchConditions` already filters on `conditions`, and the schema comment
already documents `{"severity": [...]}` as the intended shape.

## 11. Deliberately deferred

### 11.1 Severity escalation by magnitude

A reading 50× over the limit raises the same severity as one 1% over. Escalation
tiers are a real GxP pattern, omitted here as YAGNI. Adding them later means
extra rows on `AlarmThreshold`, not a model change.

### 11.2 Root-cause suppression

If a gateway drops, every instrument beneath it raises its own offline alarm. P3
produces N alarms. Suppression needs gateway-level liveness, which P3 does not
model, and is better designed once attributes (P4) exist.

### 11.3 Alarm rules beyond thresholds

No rate-of-change, no cross-instrument comparison, no scripted conditions. If
those are ever wanted, they belong in a rule engine, not in `AlarmThreshold`.

## 12. RBAC & UI

Three permissions as `PERMISSION_TREE` nodes:

| Permission | Node | Grants |
|---|---|---|
| `ALARM_VIEW` | `alarms.view` | the alarm queue |
| `ALARM_ACKNOWLEDGE` | `alarms.acknowledge` | the signed ack action |
| `ALARM_THRESHOLD_MANAGE` | `alarms.thresholds` | threshold CRUD |

All three `configurable: true` — unlike the eight P1 nodes left non-configurable,
these ship with UI, so a toggle grants a visible capability.

Frontend: an alarm queue page (filter by state / severity / instrument), an ack
dialog carrying the mandatory reason and the reauth prompt, threshold management
on the instrument detail page, and an open-alarm count on the instrument list.

**The sidebar entry must be added to both lists** — `SIDEBAR_ITEMS` in
`packages/shared` *and* `allNavItems` in
`apps/web/src/components/layout/sidebar.tsx`. Only the first was updated during
P1, and the feature shipped with no navigation link; every code review passed
because nothing in any diff was wrong — the omission lived in a file nobody
touched.

## 13. Testing

| Layer | Approach |
|---|---|
| State machine | Pure unit tests over the transition table in §6, no database. Every cell, including the `RESOLVED_UNACKED` → `ACTIVE` re-breach. |
| Threshold evaluation | Pure unit tests per operator, including hysteresis boundaries and `OUT_OF_RANGE` validation. |
| Ordering | A test proving evaluation does not run when `writeBatch` rejects. |
| Evaluator failure | A test proving a throwing evaluator produces a `DeadLetter` and does not silently no-op. |
| Liveness sweep | A test proving a second sweep over an already-offline instrument raises nothing. This is the regression that persisted state exists to prevent. |
| Part 11 | Ack without reauth → 401. Ack with blank reason → 400. Every transition produces a chained audit row. |
| Sidebar parity | The still-unwritten test asserting `SIDEBAR_ITEMS` and `allNavItems` hold the same ids. |
| Cron registration | A test asserting every identifier in `crontab.txt` has a handler in `app.ts`'s `taskList`. Also still unwritten, and it would have caught the 51,798-row leak. |

**Test isolation.** Any test touching thresholds, alarms or liveness creates its
own scratch instrument and hierarchy node. No test mutates shared schema or
shared rows — the partition-drop incident produced a destructive test whose own
guard passed vacuously because it ran after the damage.

**Typecheck is part of done.** `npx tsc --noEmit -p apps/api/tsconfig.json` and
the web equivalent. `vitest` runs through esbuild and strips types without
checking them; the API previously sat with two `TS2322` errors across eight
consecutive green tasks.

**Timezone.** Every new timestamp column is `timestamptz`, matching
`InstrumentTelemetryHistory` and `audit_trail`. P2 shipped a `timestamp` column
that rendered a −19790s age on this IST machine while every test passed on the
assumption of UTC.

## 14. Expected count changes

Baseline verified live on 2026-08-03 with the commands in the root `CLAUDE.md`
"Live-count verification" block. Targets are projections — re-derive at
implementation time, never quote them from here.

| | Verified baseline | Projected after P3 |
|---|---|---|
| Prisma models | 33 | 36 |
| Prisma enums | 8 | 12 |
| Permission constants | 46 | 49 |
| Reauth actions | 51 | 53 |
| API modules | 23 | 24 (`alarms`) |
| Frontend routes | 45 | 46 |
| `NotificationEventType` members | 10 | 12 |
| `crontab.txt` lines / distinct task ids | 4 / 3 | 5 / 4 |

Plus one new sidebar item — in **both** lists, per §12.

## 15. Open questions for implementation

1. Should the alarm queue default to hiding `CLOSED` alarms? Assumed yes, with a
   filter to reveal them.
2. Grace-period multiplier default of 2 is an assumption. It belongs in a config
   def so a site can tune it — note that `seedDefaults()` only inserts when a row
   is **absent**, so changing this default later is a code change *plus* a data
   step.
3. Whether `ALARM_ACKNOWLEDGED` should notify at all, or only `ALARM_RAISED`.
   Included for now; it costs one enum member and rules default to inactive.
