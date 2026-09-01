# RS485 sensor-failure alarms — design

**Date:** 2026-08-31
**Status:** implemented
**Source:** operator request — "when telemetry data getting NA or any text value
then it should generate as RS485 Alarm; if Humidity getting NA or any other text
value then RS485 Humidity Failure Alarm, if Temperature then RS485 Temperature
Failure Alarm, if both getting then 2 failure alarms should come."

## The gap this fills

When an RS485 probe or its bus fails, the data logger **keeps talking**. It sends
`NA` where the reading should be. Before this source existed, nothing in the
system noticed:

| Existing source | Why it cannot see the fault |
|---|---|
| `INACTIVITY` | The payload arrived and stamped `last_seen_at`. The instrument *is* reporting — it is the sensor that is dead. |
| `INSTRUMENT_LIMIT` | `telemetry-overview.ts:toSlot()` discards a non-numeric value, so the evaluator sees `null`, and a null is deliberately not a breach (`limit-decide.ts`). |
| `RULE` | Same null, same reason. |
| The dashboard | Renders an empty cell — indistinguishable from an instrument that has never reported. |

So a dead probe looked exactly like a healthy plant with a gap in it.

## Measurement taken before choosing the default

Every retained reading on a temperature or humidity slot key **in the local
development database `compliance_core_db`** — 226,570 of them across
`instrument_telemetry_history`, plus every row of `instrument_telemetry_latest`
regardless of age — is numeric. **Zero instruments would alarm on the first
pass.** The only non-numeric value there is `msg: "hello"` on one instrument,
which is not a slot key.

**That is the only database that was probed.** The AWS install (EC2 + RDS) is a
separate database and its number may differ; re-derive before deploying, because
this default is the one thing standing between a genuine estate-wide sensor
problem and an estate-wide alarm storm.

That number is why this source **ships ON** while `inactivity-alarms` ships OFF.
Inactivity fails closed because switching it on would have raised an alarm for
every already-silent instrument — 101 here, each with a notification and a
webhook fire. There is no equivalent storm here, and a fault detector that
quietly defaults to off detects nothing. Re-derive before changing the default
elsewhere:

```sql
SELECT count(*) FROM instrument_telemetry_latest
WHERE key = ANY(<slot aliases>) AND value_type NOT IN ('int','float');
```

## Decisions

### 1. Detection is by TYPE, never by parsing

`isSensorFailureValue()` accepts only a finite number. The string `"23.5"` **is**
a failure. That is not an oversight: `asNumber()` refuses to coerce a string, so
the dashboard already refuses to plot it and the limit evaluator already treats
it as no reading. Accepting it here would make this alarm disagree with every
other consumer about what counts as a reading, and the screen and the alarm
beside it would tell different stories.

### 2. The clear signal is A NUMBER; silence HOLDS the alarm open

This is `limit-decide.ts`'s rule and the **exact inverse** of
`inactivity-decide.ts`, where absence *is* the alarm and presence is the proof of
recovery. You cannot prove a probe was repaired from the fact that it stopped
talking — and the moment a broken logger falls quiet is when the fault is least
resolved. A pass written by copying the inactivity pass clears every RS485 alarm
at exactly the wrong moment. The two decide modules are separate for this reason
and both carry the asymmetry in their headers.

A missing key is **not** a failure either: a temperature-only logger has no
humidity key, and an instrument that has never reported has neither. Silence is
the inactivity source's question.

### 3. Identity is instrument AND metric

`alarms_active_rs485_unique` is on `(instrument_id, metric) WHERE state='ACTIVE'
AND source='RS485_FAILURE'` — unlike `alarms_active_inactivity_unique`, which is
on the instrument alone. Two probes on one logger fail independently and must
hold two open alarms at once, which is what "2 failure alarms" requires. An index
on the instrument alone would let the first failure block the second from ever
being recorded, and the omission is invisible until it happens in the plant.

`AlarmMetric` is `TEMPERATURE | HUMIDITY | OFFLINE`, so a text value on any other
key raises nothing — there is no metric to record it under.

### 4. Slot resolution is the overview's, not a second copy

`buildTelemetryOverview()` now carries `rawSlots` — each slot's reading **before**
the numeric filter — beside the numeric `temperature`/`humidity` it already
returned. Both come from one `resolveSlot()` call per slot, so the numeric view
and the raw view can never name different keys. Resolving again in the worker
would let the alarm and the dashboard disagree about which key is the temperature
key on an installation where that mapping is administered and has drifted before.

This follows the precedent already stated in that file for `decimals`: the alarm
evaluator never touches the browser but needs an answer the overview has already
worked out. `rawSlots` is not exposed by the dashboard endpoint — Fastify strips
what its response schema does not name.

### 5. The evidence lives on the snapshot

`triggeredValue` is a Float and cannot hold `NA`, so it stays NULL and the
offending text goes onto `ruleSnapshot.rawValue`, with the key it arrived on, its
ingest-assigned `valueType`, and the instrument's display precision frozen the
way every other alarm freezes it.

~~The **Generated Value column shows that text** — `NA`, `ERR` — rather than an
administered wording.~~ **REVERSED the same day, on operator instruction, and the
reasoning was wrong in a way worth keeping.** The raw text is almost always `NA`,
and `NA` is precisely what the dashboard already renders for a slot with NO
reading (`NOT_AVAILABLE`). So the "evidence" was a word the reader had already
learned to parse as *no data* — a dead probe and an instrument nobody had wired
up looked the same in the one column meant to separate them.

The value columns now show ONE administered word, `rs485-alarms.failureText`,
default `Error`. **The evidence is not lost:** the raw value is still frozen on
`ruleSnapshot.rawValue`, still named in the condition, and every notification and
webhook prints that condition beside the value. Lesson: evidence that collides
with an existing convention is not evidence, it is ambiguity.

The **Limit column shows the constant `numeric`**: what was breached is the
expectation that a sensor sends a number. A constant, not a config setting — a
second set of "what does the Limit column say" wordings, for a second source, on
one table, invites two different answers to one question.

The **Cleared Value column shows a real measurement**, because unlike an
inactivity alarm this one clears on an actual reading.

### 6. No grace period

A single bad poll raises. An RS485 fault is not a blip — it persists until
someone fixes the wiring — and the operator chose immediacy over a grace with the
consequence stated: a transient bad poll writes two permanent §11 alarms that
each need an e-signature. Adding a grace later needs a snapshot field and a
history query, i.e. a migration.

### 7. Annunciated like any other alarm

Raise and clear enqueue a notification and every matching alarm webhook. No
special-casing.

### 8. The word appears everywhere a failed reading would (2026-08-31, follow-up)

The Alarms page, acknowledge dialog, trend widget and signed PDF; the dashboard
table and floorplan tiles; the trend page's raw table; and the `${value}` of
every alarm notification and webhook (new optional `valueText` on both payload
builders).

Two constraints that shaped it:

- **The server decides.** `OverviewRow.sensorError` is computed with the same
  predicate that raises the alarm and declared in the response schema. The
  browser cannot distinguish a broken reading from a missing one — both leave the
  slot null — and re-deriving the judgement there is how a cell comes to
  contradict the alarm beside it.
- **No literal in browser code.** One `useFailureText()` hook over the narrow
  read endpoint; the only fallback is the shared constant. A `'Error'` default in
  a component is a second opinion about an administered value, and the two
  diverge the moment somebody edits the setting.

**The trend raw table was silently dropping broken readings** — it was built from
`numericRows`, so a table that claims to list every reading in the range omitted
exactly the ones an engineer opens it to find. `toTableRowsWithErrors` keeps
them; the chart still filters, because you cannot plot a word.

Absent readings keep saying `NA`: a broken probe and an unwired instrument are
different faults with different remedies.

## What was NOT changed

No new model, enum, permission, reauth action, audit action, page or route.
`AlarmSource` gains a fourth **value**. Config defs 26 → 27.

## Verification

- `modules/alarms/__tests__/rs485-decide.test.ts` — 17 unit tests.
- `src/e2e/alarm-rs485.e2e.test.ts` — 21 e2e driving the REAL pass.
- 12 new display tests in `apps/web/.../alarm-display.test.ts`.
- Mutation-checked: inverting the clear rule (`undefined → 'clear'`) fails the
  hold test.

**Two bugs that mutation check found, both worth recording:**

1. The worker's clear branch read `action === 'clear' && open && slot`, so a
   wrong decision was silently skipped rather than acted on — which made an e2e
   for the clear rule pass *even with the rule inverted*. `slot` is now a type
   guard inside the branch, not a second opinion.
2. The e2e's `beforeEach` cleared the readings by name (`temperature`,
   `humidity`) and so left the **second alias** `temp` behind from an earlier
   test. The slot still resolved, and the "goes silent" test was not testing
   silence. It now deletes every reading for the fixture instrument.

**And one incident:** the first version of this e2e had a bad `::uuid` cast on a
text column *in `afterAll`*, which aborted teardown before the config restore and
left `alarm-limits` disabled in the shared `compliance_core_db_test` — failing 8
tests in two unrelated suites, and ratcheting itself in, because each later run
read the disabled value as its own "before". The restore loop now runs FIRST and
every step is independently guarded. `apps/api/CLAUDE.md` already recorded one
occurrence of this failure mode; this is the second.
