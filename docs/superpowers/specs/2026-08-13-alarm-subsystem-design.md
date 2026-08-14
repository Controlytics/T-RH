# Alarm subsystem — design (Project C)

**Date:** 2026-08-13
**Branch:** `data-injection`
**Depends on:** A (Functional Locations) for rule targeting. Independent of B and D.

## Goal

Configurable alarm rules over instrument telemetry, with a raise/clear lifecycle, an
e-signed acknowledgement, immutable history, and notification delivery. Unblocks the
Alarms card on the dashboard.

## Operator decisions

1. **Configurable rules per instrument or location** — not derived from room limits.
2. **Acknowledgement requires a reason plus password re-authentication**, written to
   the audit trail.
3. **An alarm auto-clears when the condition ends**, the row persists with raised/
   cleared times, and it stays listed as unacknowledged until someone acknowledges it.

## The consequence of decision 1, and how it is mitigated

Configurable rules create a **second definition of "out of spec"**, alongside the room
limits that already drive the dashboard table and the floor plan. A rule may alarm at
24 °C while the room's own spec permits 25 °C, so the table can show a value in green
while an alarm is active against it. That is a legitimate configuration — an early
warning tighter than the spec — but it is confusing if left unexplained, and it is
unanswerable after the fact if the rule is later edited.

Three mitigations, all required:

- **Every alarm snapshots the rule that fired** into `Alarm.ruleSnapshot`. An
  inspector asking "why did this fire at 24.0 when the spec is 25.0?" is answered from
  the alarm row itself, not from the current rule, which may since have changed. This
  is the same reasoning behind the existing profile/checklist version sidecars.
- **The alarm names its rule on screen**, e.g. `Rule "Cold room early warning" —
  temperature above 24.0 °C`, so nobody has to guess which threshold applied.
- **Where a rule is tighter or looser than the room's own limits, the rules page says
  so** next to that rule. Silent disagreement between the two definitions is the
  failure mode; a visible note is cheap.

## Data model

```prisma
enum AlarmMetric      { TEMPERATURE  HUMIDITY  OFFLINE }
enum AlarmComparison  { ABOVE  BELOW  OUTSIDE_RANGE }
enum AlarmSeverity    { CRITICAL  MAJOR  MINOR }
enum AlarmState       { ACTIVE  CLEARED }

model AlarmRule {
  id       String  @id @default(uuid())
  name     String
  /// EXACTLY ONE of these is set — enforced in validation, not by the schema, so the
  /// error names the field instead of surfacing as a constraint violation.
  instrumentId         String? @map("instrument_id")
  functionalLocationId String? @map("functional_location_id")

  metric     AlarmMetric
  comparison AlarmComparison
  /// ABOVE/BELOW use `thresholdHigh` only. OUTSIDE_RANGE uses both.
  thresholdLow  Float? @map("threshold_low")
  thresholdHigh Float? @map("threshold_high")
  /// Seconds the condition must persist before the alarm raises. 0 = immediately.
  /// A telemetry spike one sample wide otherwise produces an alarm nobody can act on.
  delaySeconds Int @default(0) @map("delay_seconds")
  severity     AlarmSeverity @default(MAJOR)
  isActive     Boolean @default(true) @map("is_active")

  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)
  createdBy String?  @map("created_by")
  updatedBy String?  @map("updated_by")

  instrument         Instrument?         @relation(fields: [instrumentId], references: [id], onDelete: Cascade)
  functionalLocation FunctionalLocation? @relation(fields: [functionalLocationId], references: [id], onDelete: Cascade)
  alarms             Alarm[]

  @@index([isActive])
  @@map("alarm_rules")
}

model Alarm {
  id     String @id @default(uuid())
  ruleId String @map("rule_id")
  /// The rule AS IT WAS when this alarm fired. Editing or deleting the rule must not
  /// change what a historical alarm says about itself.
  ruleSnapshot Json @map("rule_snapshot")

  instrumentId String      @map("instrument_id")
  metric       AlarmMetric
  /// The reading that tripped it. NULL for OFFLINE, which has no value.
  triggeredValue Float? @map("triggered_value")
  severity       AlarmSeverity
  state          AlarmState @default(ACTIVE)

  raisedAt   DateTime  @default(now()) @map("raised_at") @db.Timestamptz(3)
  clearedAt  DateTime? @map("cleared_at") @db.Timestamptz(3)

  acknowledgedAt   DateTime? @map("acknowledged_at") @db.Timestamptz(3)
  acknowledgedBy   String?   @map("acknowledged_by")
  acknowledgeReason String?  @map("acknowledge_reason")

  rule       AlarmRule  @relation(fields: [ruleId], references: [id], onDelete: Restrict)
  instrument Instrument @relation(fields: [instrumentId], references: [id], onDelete: Restrict)

  /// The active-list query and the dashboard count both read these.
  @@index([state, raisedAt(sort: Desc)])
  @@index([instrumentId, raisedAt(sort: Desc)])
  @@index([acknowledgedAt])
  @@map("alarms")
}
```

**`onDelete: Restrict` on both Alarm relations.** An alarm is a regulated record;
deleting an instrument or a rule must not erase the history of what it did. Deleting a
rule that has alarms is refused with a 409 naming the count, matching how functional
locations behave. `AlarmRule`'s own targets cascade, because a rule for a deleted
instrument is meaningless — but its alarms survive via the snapshot.

**No `Alarm.updatedAt`, and rows are never edited** except to set `clearedAt` or the
three acknowledgement fields. There is deliberately no delete path.

## Evaluation

A graphile-worker task, `alarm_evaluation`, alongside the existing `notification`,
`password_expiry_check`, `session_sweep` and `telemetry_partition_maintenance` tasks —
the established home for periodic work in this repo. **Not** in the ingest path: an
alarm evaluation that throws must never be able to reject a telemetry write.

Each run, for every active rule:

1. Resolve the rule's instruments — one instrument, or every instrument in the
   functional location, **expanded through `resolveLocationIds()`** so a rule on a
   Block covers its Areas. One definition of that expansion, shared with B and D.
2. Read the latest value for the rule's metric (or last-seen for `OFFLINE`).
3. Decide breach: `ABOVE`, `BELOW` or `OUTSIDE_RANGE` against the thresholds.
4. Apply `delaySeconds`: a breach only raises once it has persisted that long, so a
   one-sample spike does not produce an alarm nobody can act on.
5. **Raise** if breaching and no ACTIVE alarm exists for that (rule, instrument) —
   the uniqueness rule that prevents one excursion producing an alarm every minute.
6. **Clear** (`state = CLEARED`, `clearedAt = now`) if an ACTIVE alarm exists and the
   condition has ended. Acknowledgement state is untouched: a cleared-but-
   unacknowledged alarm is exactly the overnight excursion someone must still answer
   for in the morning.

The decision logic — breach detection, delay, raise/clear — is **pure and unit-tested**;
the worker only does I/O around it. That is where the risk is, and it is the only part
a machine can check.

## Acknowledgement

`POST /api/alarms/:id/acknowledge` with `{ reason }`, requiring re-authentication
(`ACKNOWLEDGE_ALARM`) and writing `ALARM_ACKNOWLEDGED` to the hash-chained audit trail
with the reason as the signature meaning. Acknowledging an already-acknowledged alarm
returns 409 rather than overwriting the first signature — the first acceptance is the
record.

An alarm can be acknowledged while ACTIVE or after it has CLEARED.

## Notifications

Raising an alarm enqueues an existing `notification` job. Two new
`NotificationEventType` values are needed — `ALARM_RAISED` and `ALARM_CLEARED` — since
the enum currently has `DEVICE_OFFLINE` and `DEVICE_INACTIVITY` but nothing for a
limit excursion. Delivery, targeting and read state are the existing module's job; the
alarm subsystem does not reimplement any of it.

## API

| Method | Path | Permission |
|---|---|---|
| GET | `/api/alarms/rules` | `ALARM_RULE_READ` |
| POST / PUT / DELETE | `/api/alarms/rules[/:id]` | `ALARM_RULE_MANAGE` + reauth, audited |
| GET | `/api/alarms?state=&acknowledged=&instrumentId=` | `ALARM_READ` |
| GET | `/api/alarms/summary` | `ALARM_READ` — counts for the dashboard card |
| POST | `/api/alarms/:id/acknowledge` | `ALARM_ACKNOWLEDGE` + reauth, audited |

**Rules are mounted UNDER `/api/alarms`, not at `/api/alarm-rules`** as this table
originally said (corrected 2026-08-14). The module registers one prefix and both the API
and the web page agree on it; moving the routes now would be churn for no gain.

**Alarms respect project D's visibility scope.** An alarm names an instrument, so
listing alarms for instruments a role may not see would leak exactly what D withholds.
The same `resolveVisibility()` applies, and `/summary` counts only visible alarms.

## Phases

C is too large for one change. Each phase is independently useful and reviewable:

- **C1 — rules + evaluation + lifecycle.** Models, migration, pure decision logic with
  tests, the worker task, rule CRUD API. No UI. Verifiable by seeding a rule and
  watching alarms raise and clear.
- **C2 — acknowledgement.** The endpoint, reauth action, audit action and template
  (**two edits**: `audit-templates.ts` and `audit-helpers.ts`).
- **C3 — UI.** An Alarms page (active / history, acknowledge dialog), an Alarm Rules
  config page, and the dashboard **Alarms card** that has been absent since B.
- **C4 — notifications.** The two enum values and the enqueue on raise/clear.

## Out of scope

- Alarm escalation, shelving/suppression windows, and repeat notification schedules.
- Anything deriving alarms from room limits — decision 1 was explicit.
- Editing or deleting alarm rows.
