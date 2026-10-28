# DigiLog API — CLAUDE.md

## Overview
Fastify backend serving the DigiLog REST API on port 3000. Runs locally on Windows via `tsx watch` in dev, or as a compiled Node service in production-style local builds. The repo currently has no live remote deployment.

## Build & Deploy
```bash
# Windows Local Development (auto-reload)
cd apps/api && npx tsx watch src/app.ts

# Production-style local build
npx tsc -p apps/api/tsconfig.json   # Compile to apps/api/dist/
node apps/api/dist/app.js
```

## Key Paths
- Source: `apps/api/src/`
- Compiled: `apps/api/dist/`
- Entry: `apps/api/src/app.ts`
- Prisma schema: `apps/api/prisma/schema.prisma` (**38 Prisma models, 13 enums** — 37 → 38 on 2026-10-26: `MeasurementType`, migration `20261026120000_profile_measurements`; 36 → 37 on 2026-09-22: `FloorplanRoomLink`, migration `20260922120000_floorplan_polygons_links`, also `floorplan_rooms.points JSONB` and `floorplans.image_path` nullable; no new enum, `kind` is a validated string. Earlier **36 / 13** verified `grep -cE "^model " / "^enum "` 2026-08-27 — **2026-08-27 added 2 models** (`AlarmWebhookTarget`, `AlarmWebhookDelivery`; 34 → 36) for the alarm webhook annunciator, migration `20260827120000_alarm_webhooks`, hand-authored, applied to `compliance_core_db` and `compliance_core_db_test`; **no new enum** — `method`/`event`/`status` are validated strings, the same precedent as `FloorplanRoom.grade`. Earlier, verified 2026-08-17 — **2026-08-17 added 2 enums** (`AlarmSource`, `AlarmLimitKind`; 11 → 13) for instrument-limit alarms: `Alarm` gains a nullable `ruleId`, `source` (RULE | INSTRUMENT_LIMIT), `limitKind` (HIGH | LOW), `clearedValue`. Migrations `20260817090000_instrument_limit_alarms` + `20260817120000_alarm_limit_unique_active` (the latter a partial unique index, no model/enum change), both hand-authored, drift guard PASS, applied to `compliance_core_db_test` as well. Earlier (2026-08-14): projects A/C added `FunctionalLocation`, `AlarmRule`, `Alarm` and the enums `FunctionalLocationType`, `AlarmMetric`, `AlarmComparison`, `AlarmSeverity`, `AlarmState`; C4 added 2 VALUES to `NotificationEventType`, which is not a new enum. **Migrations must be applied to `compliance_core_db_test` separately** — being behind makes every instrument-touching e2e 500. Earlier: **31 Prisma models, 6 enums** (verified `grep -cE "^model "` / `"^enum "` 2026-08-11; the long-standing "61 models, 23 enums" was inherited from upstream DigiLog and was NEVER true in this fork — the real count before Instrument Profiles was 28 models / 6 enums)). Step 1 added the `TemplateKind` lookup model; MT removal (2026-04-30) dropped `Organization` + 11 `organizationId` columns + 2 `orgId` columns; **Step 6 (2026-05-01)** split filter-specific cycle state (`filterProfileId`, `currentLifecycleState`, `currentCycleId`, `filterSet`) off `AssetInstance` into a 1:1 `FilterDetails` sidecar; **Phase A.3 (2026-05-01)** added the `FilterProfileVersion` sidecar; **Phase A.4 (2026-05-02)** added the `EquipmentGroupVersion` sidecar; **Step 4 (2026-05-02)** replaced `FilterProfile.applicableTemplates Json` with the `FilterProfileApplicableTemplate` join table; **2026-05-17 dropped 5 models** (`RuleChain`, `RuleChainVersion`, `RuleNode`, `RuleNodeConnection`, `Alarm`); **2026-06-11..2026-06-17 dropped 6 models** (`DeviceCredential`, `UnsMapping`, `ConnectivityStatus`, `DataStream`, `DeadLetterQueue`, `IngestionSystemConfig`) with the data-ingestion tear-out; **2026-07-01 dropped 2 orphaned tables** (`QrCode`, `LatestTelemetry` — both 0 rows; QR module gone 2026-06-06, telemetry pipeline gone Phase 7; migration `20260701071802_drop_qrcode_latesttelemetry`); **2026-07-04 dropped 2 orphaned tables** (`ChecklistReview`, `ElectronicSignature` — both 0 rows, 0 code refs; migration `20260704062157_drop_checklistreview_electronicsignature`); **2026-07-04 dropped 4 models** (`ReportTemplate`, `ReportTemplateVersion`, `ReportInstance`, `ReportSignature`) + 2 enums (`ReportTemplateStatus`, `ReportStatus`) with the reports generate/sign tear-out (migration `20260704121326_drop_reports_generate_sign`; `ReportReview` survives); **2026-08-08 added `InstrumentProfile.attributeKeys`** (nullable `attribute_keys TEXT`) — the attribute keys the New Instrument form asks for in that profile, replacing the single global list; migration `20260808163000_instrument_profile_attribute_keys` backfills every existing profile from the **live** `system_config['instrument-attributes']` value (12 keys here, not the 6-key `INSTRUMENT_ATTRIBUTE_KEYS_DEFAULT` constant). **No model or enum count change** — a nullable column is not a model, so 29 / 6 stand. This reversed the "profiles are grouping only, they inherit nothing" comment on the model; profiles inherit **prompts, never values** (see `docs/superpowers/specs/2026-08-08-per-profile-instrument-attributes-design.md`).
- **2026-08-11 — instrument dashboard.** Added 2 models (`Floorplan`, `FloorplanRoom`) + nullable `Instrument.roomId` (29 → **31 models**, 6 enums, verified `grep -cE "^model "`). Migration `20260811120000_instrument_floorplans` is HAND-AUTHORED and deliberately STRIPS three statements `prisma migrate diff` emitted: `DROP TABLE instrument_telemetry_history` (partitioned, invisible to the datamodel, held 1180 rows), `ALTER audit_trail.chain_position DROP NOT NULL` (the §11 hash-chain position, sequence-backed out of band), and a drop/recreate of an unchanged `instrument_credentials` FK. **Read that SQL's header before regenerating any migration here.** `20260811130000_retire_limit_attributes` edits only `instrument_profiles.attribute_keys` — the audited move of recorded values onto rooms is `scripts/retire-limit-attributes.ts`, because deleting an attribute is a §11 record change needing an attributable audit row that raw SQL cannot write. New module: `floorplans`. New config def: `telemetry-slots`. Drift guard PASS.
- **2026-08-24 — room doors + cleanroom grade.** Added 2 nullable columns to the
  existing `FloorplanRoom` model: `doors Json?` (array of `{wall, offset, width,
  kind}`, normalized to the wall so a door stays attached when the room moves)
  and `grade String?` (`A|B|C|D|CIRCULATION|UTILITY`, zod-validated, deliberately
  **not** a Postgres enum so the vocabulary can grow without a migration).
  Migrations `20260824100000_floorplan_room_doors` and
  `20260824140000_floorplan_room_grade`, both hand-authored, applied to
  `compliance_core_db` and `compliance_core_db_test`. **No model or enum count
  change** — 34 models / 13 enums stood at that date (36 / 13 now, after the
  2026-08-27 alarm-webhook models). On `PUT .../rooms/:roomId`, an omitted
  `doors` key leaves the column unchanged; only an explicit `null`/`[]` clears
  it — deliberate §11 data-loss guard. Also this date: new reauth action
  `DOWNLOAD_REPORT` under a new `Reports` category (46 → 47 reauth actions,
  7 → 8 categories) gating `POST /api/audit/report-export-log` (now requires
  `remarks`); it reuses the existing `REPORT_GENERATED` audit action (93/87/7
  unchanged). `GET /:id/telemetry` gained `offset` paging; new
  `GET /:id/telemetry-keys` endpoint. **Fixed a pre-existing security gap:**
  `GET /:id/telemetry` had no instrument-visibility scoping (bare
  `findUnique`) while `GET /:id` did — now scoped identically, 404 (never 403)
  out of scope.
- **2026-08-27 — `GET /:id/telemetry` stopped silently truncating wide ranges.**
  **No count moved** (36/13 models/enums, 42 permissions, 48 reauth actions, 24
  modules, 25 config defs — re-derived, unchanged) and there is **no
  migration**: one existing route gained query parameters.
  - **The defect.** `telemetry.repository.ts:getHistory` did
    `Math.min(opts.limit ?? 100, 1000)` with `ORDER BY ts DESC`, so ANY range
    wider than 1000 readings returned only the NEWEST 1000 and said nothing.
    At this installation's 30–90s cadence a 7-day chart therefore plotted
    roughly the last DAY while the axis claimed a week, and every figure derived
    from the response described that slice. Look for this shape wherever a
    `limit` and a `from`/`to` meet in one query.
  - **The chart path is now separate from the table path.** `points` (integer,
    1..5000; out of range is a **400 from the schema, never a silent clamp**)
    switches the handler to: read the whole range, `lttb()`-downsample to
    `points` per key, and return `historyTotal` (the TRUE count in range),
    `historySampled`, and `summaries[key]`. `points` omitted = the old paged
    `limit`/`offset` table path, byte-for-byte unchanged, so existing callers
    are unaffected. The 1000-row cap in `getHistory` stayed for that
    path until **2026-09-02, when it was REMOVED** along with every other
    server-side record ceiling (operator: *"whatever records are there all
    records should show in everywhere"*). `lib/page-size.ts` is now the one
    definition and it does not cap. **`points` KEEPS its 1..5000 schema bound**,
    which is a 400 rather than a silent clamp and governs plotted points, not
    records.
  - **`summaries[key]` is computed in SQL over EVERY reading in the range**
    (`telemetry.repository.ts:getRangeSummary`), in a query SEPARATE from the
    row query, and that separation is the point of the design: a `max` derived
    from the downsampled subset would let a spike the sampler did not select
    vanish from a signed §11 readout. `belowCount`/`aboveCount`/
    `outOfSpecCount` are **nullable and the null is load-bearing** — it means
    no limit was resolved for that key, which is not the claim "zero breaches".
    `limitMin`/`limitMax` ride along from the server's own limit resolution, so
    a printed count and a printed bound cannot come from two different answers
    to "which limit applies?".
  - **The response schema is a filter, not documentation.** Fastify STRIPS any
    field not declared in the `response` block — a field added to the handler
    without a line there vanishes between handler and wire with no error
    anywhere. `historySampled`/`summaries` had to be declared to exist.
  - Pinned by `src/e2e/instrument-telemetry-range.test.ts`, including the
    assertion that carries the design: **`summary.max` equals the true maximum
    in the range even when that reading is not among the returned rows.**
- **2026-08-27 — alarm webhook annunciator.** New module `alarm-webhooks`
  (23 → **24 modules**), registered in **both** `app.ts` and
  `src/e2e/test-helper.ts`. Added 2 models, `AlarmWebhookTarget` +
  `AlarmWebhookDelivery` (34 → **36 models**; **13 enums unchanged** —
  `method`/`event`/`status` are validated strings); migration
  `20260827120000_alarm_webhooks`, hand-authored, applied to both databases.
  New reauth action `MANAGE_ALARM_WEBHOOK` in the existing `Configuration`
  category (47 → **48**, 8 categories unchanged); 4 new audit actions +
  templates (93 → **97** / 87 → **91**, 7 categories unchanged). **No new
  permission** — the routes reuse `ALARM_RULE_READ` / `ALARM_RULE_MANAGE`.
  New graphile-worker task `alarm_webhook` (5 → **6**), enqueued
  `maxAttempts: 1` with retry bounded inside the task (3 attempts, ~2s apart)
  so backoff cannot buzz a hooter long after the excursion cleared;
  event-driven, **no `crontab.txt` entry on purpose**. Fires on RAISED /
  CLEARED / ACKNOWLEDGED — the acknowledge hook sits **after** the atomic claim
  so a double-acknowledge produces one delivery, not two. Cooldown throttles
  RAISED only. Body rendering is `alarm-webhooks/render-body.ts`, deliberately
  NOT `notification-delivery/template-engine.ts:resolveTemplate()`, which
  HTML-escapes and would corrupt a JSON payload. Seven routes under
  `/api/alarm-webhooks`; `DELETE` is refused while deliveries reference the
  target (both FKs `Restrict` — a delivery is the §11 evidence of what the
  system did or did not annunciate). Instrument-visibility scoping is **SPLIT**
  (corrected 2026-08-27 — this entry previously said the whole module was
  unscoped): the CONFIG routes (`GET /`, `GET /:id`, mutations) are
  deliberately NOT scoped, matching the alarm RULES routes
  (`alarms/routes.ts:93-202`) and unlike the alarm LIST routes, because a
  half-scoped config surface would let an admin build a target that silently
  omitted half the plant. `GET /:id/deliveries` **IS** scoped
  (`resolveVisibility`, nested under the alarm's instrument, ANDed never
  spread): it is not configuration and returns `requestBody` verbatim, which
  carries the instrument code and the reading. `alarmId: null` rows (TEST
  fires) are returned — they name no instrument, and a nested relation filter
  would otherwise drop them. Also 2026-08-27: the worker delivers to matched
  targets CONCURRENTLY (`Promise.allSettled`) so one dead hooter cannot delay
  the others by ~19s; the match/cooldown pass stays sequential because
  `shouldFire` mutates the cooldown map. `POST /:id/test` fires ONE attempt
  (`deliverToTarget`'s `maxAttempts` param) — a test is a diagnostic, and three
  attempts held the request, and the `ALARM_WEBHOOK_TESTED` audit row that
  follows it, open for ~19s against a hooter that does not answer.
- **2026-08-28 — instrument visibility can name INSTRUMENTS, not just locations.**
  **No count moved** (36 models / 13 enums, 42 permissions, 48 reauth actions, 24
  modules, 25 config defs / 25 pages — unchanged) and **no migration**: the
  existing `instrument_scope` JSONB carries the new shape.
  - **The column holds TWO shapes, permanently.** Rows before this date are a
    bare `string[]` of functional-location ids; rows since are
    `{locationIds, instrumentIds}`. Legacy rows are deliberately NEVER rewritten
    — rewriting every access-control row is a bigger risk than a reader that
    takes both. `normalizeScope()` in `modules/instruments/visibility.ts` is that
    reader and there is exactly ONE of it. Before this change there were two
    independent `Array.isArray(v)` tests (visibility.ts and the admin GET in
    `roles/routes.ts`), and in both, "not an array" meant *nothing stored* →
    **unrestricted**. Either one left behind reads a legacy restricted row as
    unrestricted while the admin screen still shows the restriction.
  - **`scopeToWhere` is a UNION and always emits BOTH branches** —
    `{OR: [{functionalLocationId:{in}}, {id:{in}}]}`. `{OR: []}` matches NOTHING
    in Prisma while `{}` matches EVERYTHING, and a "drop the empty branch"
    refactor is one step from the second. Every consumer treats the fragment as
    opaque (`AND: [where, vis]`, `{instrument: vis}`, `visibilityWhere`), so the
    nested OR composes — verified, not assumed.
  - **A documented rule was deliberately reversed:** an instrument with no
    functional location is still unreachable by the LOCATION branch (`IN (...)`
    never matches NULL) but IS granted when named by id. Assigning a freshly
    commissioned device must not silently do nothing.
  - **Two pre-existing leaks fixed in the same pass**, both the shape of the
    `GET /:id/telemetry` gap closed 2026-08-24 — a sibling route left on a bare
    lookup when its neighbour was scoped: `GET /:id/dead-letters` (returns
    `rawPayload`, the device's own message) and
    `GET /api/floorplans/:id/rooms/:roomId/history` (returned every instrument in
    the room). The latter filters the room MEMBERSHIP query, so an out-of-scope
    instrument contributes no series rather than being stripped after the rows
    were read. `GET /api/floorplans/:id` stays unscoped **knowingly**: it lists
    instrument identity per room, is CONFIG_READ, and is fetched only by the
    Config → Floorplans editor (verified 2026-08-28) — the dashboard uses
    `GET /api/floorplans`, which returns rooms without instruments.
  - New route `GET /api/roles/instrument-scope/instruments` (ROLE_MANAGE),
    **deliberately unscoped** for the admin picker, same reasoning as the
    alarm-webhook config routes. The §11 signature on both scope PUTs now names
    the instrument count too — "set to N functional location(s)" became false the
    moment instruments could be named.
  - Pinned by `src/e2e/instrument-scope-selection.test.ts` (21 cases, every
    restricted case paired with a positive control, driven through the seeded
    OPERATOR because SUPER_ADMIN short-circuits visibility) and 26 unit tests in
    `modules/instruments/__tests__/visibility.test.ts`.
- **2026-08-31 — inactivity alarms, a THIRD alarm source.** `AlarmSource` gains
  `INACTIVITY` — a new enum VALUE, so **36 models / 13 enums are UNCHANGED**.
  Config defs **25 → 26** (`inactivity-alarms.def.ts`, rendered by the dynamic
  page so no `routes/config/*.tsx`). No new permission, reauth action, module,
  audit action or route.
  - **TWO hand-authored migrations, and they must stay two.**
    `20260831120000_inactivity_alarms` adds the enum value;
    `20260831120001_inactivity_unique_active` adds
    `alarms_active_inactivity_unique` on `(instrument_id) WHERE state='ACTIVE'
    AND source='INACTIVITY'`. Postgres REFUSES to use a newly added enum value in
    the transaction that added it, so merging them fails. Both applied to
    `compliance_core_db` and `compliance_core_db_test`; the `DROP TABLE
    instrument_telemetry_history` Prisma emitted was stripped as usual; drift
    guard PASS.
  - **`loadInactivityConfig` reads `enabled === true`, NOT `!== false`.** That is
    the opposite of `loadLimitConfig` and is the single most important line in the
    feature: an absent or half-seeded row must mean OFF. Failing open raises one
    alarm per silent instrument — 101 here — each with a notification and a
    webhook fire. `graceMinutes` is clamped on read, so a hand-edited row cannot
    carry a negative (raise on everything) or a NaN (raise on nothing, silently).
  - **The clear signal is PRESENCE, inverting `limit-decide.ts`'s rule** that a
    missing reading HOLDS an alarm open. Absence IS this alarm, so presence is the
    proof of recovery. `inactivity-decide.ts` is a separate pure module and both
    files carry the asymmetry in their comments; a pass copied from the limit
    pass's shape strands every inactivity alarm ACTIVE for good.
  - The pass does NOT recompute `reporting` — it reads `row.reporting` from
    `buildTelemetryOverview()`, the ONE definition, so an alarm and the dashboard
    can never disagree about whether an instrument is offline. It queries
    `lastSeenAt`/`expectedIntervalSec` separately, only for the grace and the
    frozen snapshot.
  - The snapshot freezes `activeWindowMinutes` because that config is administered
    LIVE — same reasoning as freezing a limit onto an instrument-limit alarm.
  - `AlarmEvaluationResult` gains `inactivityEvaluated`, separate from
    `instrumentsEvaluated`: the two passes are independently switchable and one
    number could not say which of them ran.
  - **Three column wordings joined the def later the same day** — the
    `Generated Value` / `Limit` / `Cleared Value` cells an inactivity alarm has no
    number to fill. Served by `GET /api/config/inactivity-alarms/display-texts`
    (`static-routes/inactivity-alarms.routes.ts`), all authenticated users, the
    same narrow-slice pattern as `/alarm-limits/status-texts` — a SECOND route on
    purpose, since that one's contract is a slice of the `alarm-limits` row. The
    def stays SUPER_ADMIN-only. **The Limit wording is validated, not just
    defaulted:** it must contain `{minutes}`, which the browser substitutes from
    the alarm's FROZEN snapshot, and a string without it is replaced by the
    shipped wording HERE as well as in `inactivityLimitText()` — a caller that
    skips that helper still cannot be handed a wording that drops the threshold.
    No count moved. Pinned by 6 e2e in `src/e2e/config.test.ts`, one of which
    drives the full save round trip through `PUT /dynamic/inactivity-alarms` —
    the dynamic PUT writes `{...body}` wholesale and this def has no zodSchema,
    so new keys persist, but that is a property worth a test rather than a read.
  - Pinned by `modules/alarms/__tests__/inactivity-decide.test.ts` (17 unit) and
    `src/e2e/alarm-inactivity.e2e.test.ts` (14 e2e, driving the REAL pass).
    **That e2e file PINS `instrument-activity`** — its first version passed every
    "does not raise" case for the wrong reason, because the test database carries
    the 1440-minute default window while the live install carries 3, so a
    120-minute silence still counted as reporting.
- **2026-08-31 — RS485 sensor-failure alarms, a FOURTH alarm source.**
  `AlarmSource` gains `RS485_FAILURE` — a new enum VALUE, so **36 models / 13
  enums are UNCHANGED**. Config defs **26 → 27** (`rs485-alarms.def.ts`). No new
  permission, reauth action, module, audit action or route.
  - **TWO hand-authored migrations, and they must stay two**, same Postgres
    constraint as the inactivity pair. `20260831160000_rs485_alarms` adds the enum
    value; `20260831160001_rs485_unique_active` adds `alarms_active_rs485_unique`
    on `(instrument_id, metric) WHERE state='ACTIVE' AND source='RS485_FAILURE'`.
    **Keyed on the metric as well as the instrument**, unlike the inactivity
    index: two probes on one logger fail independently and must hold two open
    alarms, which is the behaviour the feature was asked for. Both applied to
    `compliance_core_db` and `compliance_core_db_test`; the `DROP TABLE
    instrument_telemetry_history` Prisma emitted was stripped as usual; drift
    guard PASS.
  - **`loadRs485Config` reads `enabled !== false` — the OPPOSITE of
    `loadInactivityConfig`.** Deliberate: this one only fires for a sensor
    actively reporting rubbish, measured at ZERO instruments here across every
    retained slot-key reading, while inactivity failing open raises one alarm per
    silent instrument. The two loaders are not a shared helper because that single
    character encodes which way each feature should fail.
  - **The clear signal is A NUMBER; silence HOLDS the alarm open** — the
    `limit-decide.ts` rule, inverting `inactivity-decide.ts`. `rs485-decide.ts` is
    a separate pure module and all three files carry the asymmetry.
  - **`buildTelemetryOverview()` gained `rawSlots`** — each slot's reading BEFORE
    the numeric filter, from the same single `resolveSlot()` call that produces
    the numeric one. The pass must not re-resolve: the alias mapping is
    administered and has drifted here, and an alarm naming a different key than
    the dashboard would be unanswerable. Not exposed by the endpoint — the
    response schema does not name it, and Fastify strips what it does not name.
  - The offending value cannot go on `triggeredValue` (a Float), so it is frozen
    onto `ruleSnapshot.rawValue` with its key, `valueType` and the display
    precision.
  - New list-query type token `RS485`, matching on `source` — an RS485 alarm's
    metric is TEMPERATURE or HUMIDITY, the same values a limit alarm carries.
  - Pinned by `modules/alarms/__tests__/rs485-decide.test.ts` (17 unit) and
    `src/e2e/alarm-rs485.e2e.test.ts` (21 e2e, driving the REAL pass).
    **Mutation-checking found two defects in the tests**: the worker's clear
    branch silently skipped a wrong decision, which made the e2e pass with the
    clear rule INVERTED; and the e2e's `beforeEach` cleared readings by name and
    left the SECOND alias behind, so the "goes silent" test was not testing
    silence. Both fixed; the guard is now inside the branch, and teardown deletes
    every reading for the fixture.
  - **INCIDENT — the second occurrence of a failure mode already recorded in this
    file.** That e2e's first version had a bad `::uuid` cast on a text column in
    `afterAll`, so teardown threw BEFORE its config restore and left
    `alarm-limits` disabled in the shared `compliance_core_db_test`: 8 failures in
    two unrelated suites, which then ratcheted in, because each later run read the
    disabled value as its own "before" and faithfully restored it. **Put the
    config restore FIRST in `afterAll` and guard every step independently** — a
    suite must hand back the config it touched even while it is failing.
- **2026-08-31 — alarm RULES removed.** Migration
  `20260831200000_remove_alarm_rules` drops `alarm_rules`, `Alarm.rule_id` and the
  `AlarmComparison` type (models 36 → **35**, enums 13 → **12**). Verified 0 rules
  and 0 RULE alarms BEFORE dropping, and the migration records the queries —
  had either been non-zero the model would have stayed and only the authoring
  surface would have gone. **`ALARM_RULE_READ`/`MANAGE` are NOT dead**: they gate
  `modules/alarm-webhooks`. **`AlarmSource.RULE` stays** — Postgres cannot drop an
  enum value without recreating the type. `validation.ts` kept its
  ACKNOWLEDGEMENT helpers; only the rule-draft half went.
- **2026-08-31 — floorplan annotation layer.** Migration
  `20260831220000_floorplan_annotations` adds `floorplan_rooms.meta JSONB` and
  `floorplans.annotations JSONB`, both nullable. **35 models / 12 enums
  UNCHANGED** — no new model, no new enum, the `doors`/`grade` precedent
  exactly. Applied to `compliance_core_db` and `compliance_core_db_test`; the
  `DROP TABLE instrument_telemetry_history` Prisma emits was stripped as always.
  - Carries what a DRAWING says that a generated plan cannot: per-room fill
    colour, ceiling height and floor dimensions; per-plan equipment blocks, HVAC
    units, water points, airflow runs and free text. All coordinates normalized
    0..1 against the plan, the same convention as `floorplan_rooms.x/y/w/h`.
  - **Both had to be declared in `roomProps`/`planProps` to exist on the wire.**
    Fastify strips undeclared response properties silently — the third time this
    has mattered here, after `historySampled`/`summaries` and the alarm list's
    `locationName`. Nested objects are the dangerous shape: the outer key passes
    while an inner one is dropped, so `src/e2e/floorplan-annotations.e2e.test.ts`
    asserts the inner keys individually and is mutation-checked.
  - `meta` is written with `Prisma.DbNull` for a generated room, never
    `JsonNull`, which would store the JSON literal `null` and read back present.
  - Only the QC plan has either; every other plan keeps SQL NULL and renders
    unchanged, including its legend, which is drawn only when annotations exist.

- **2026-09-04 — the MQTT client id and topic segment are the instrument
  CODE again.** Operator request; **no count moved** and **no migration**. The
  UUID interlude (2026-08-07) existed because a code of `+`/`#` in the ACL
  template matched every instrument; that was refused at registration by
  `instrumentCodeTopicViolation()` (`@digilog/shared`) from 2026-09-04 **until
  2026-09-16, when the operator had the guard REMOVED** ("remove instrument id
  restriction popup"; consequence stated: a `+`/`#` code cannot publish and a
  `+` client id matches every topic under the file ACL — see root CLAUDE.md's
  SUPERSEDED note and `codeSchema`'s comment). `/` is allowed — the plant's codes are
  `CWH/RDU/001-00` — so the bridge subscribes `instruments/#`,
  `parseTelemetryTopic` matches a fixed prefix/suffix, `isDownlinkTopic` drops
  the bridge's own retained slots silently, and lookup is by `code`. `mqtt-auth`
  binds `clientid` to `code` with NO UUID fallback. Downlink/roster topics are
  keyed on codes (`AttributeDownlink.code`/`gatewayCode`); the routes resolve
  the gateway's code. `scripts/migrate-mqtt-topics-to-code.ts` moved the
  retained slots; `etc/acl.conf` bridge grants are `instruments/#`. Pinned by
  `mqtt-topic.test.ts` (11), `e2e/mqtt-auth.test.ts` (UUID is DENIED),
  `e2e/mqtt-ingest.test.ts` (slash code routes; UUID topic dropped; own
  downlink echo not logged), and the downlink/roster e2e rekeyed on codes.
  **The reserved-last-segment rule is load-bearing**: without it a child coded
  `X/telemetry` has its downlink parsed as telemetry from `<gw>/attributes/X`.
- **2026-09-16 — instrument codes unique IGNORING CASE.** Migration
  `20260916150000_instrument_code_ci_unique`: `CREATE UNIQUE INDEX
  instruments_code_lower_unique ON instruments (lower(code))`, hand-authored
  (Prisma cannot express a functional index and `migrate diff` will propose
  dropping it — refuse), applied to `compliance_core_db` and
  `compliance_core_db_test`. Raises P2002 like the plain constraint, so
  create / rename / bulk report it through their existing duplicate paths;
  `bulk-csv.ts` folds case for in-file repeats. **Models 36 / enums 13
  unchanged.** Pinned by 3 e2e in `instruments.test.ts` + 1 parser case.
- **2026-09-16 — a key dropped from a profile cascades to its instruments.**
  `instrument-profiles/routes.ts`: `GET /:id/attribute-usage` (keys the
  profile's instruments carry, folded by case, with counts) and `PUT /:id`
  now deletes the attribute on every instrument of the profile for each
  REMOVED key, in the same transaction as the profile update, one
  `INSTRUMENT_ATTRIBUTE_REMOVED` row per instrument (value + remark), the
  device told after commit (`announceRemoval`); `reason` REQUIRED when any
  instrument carries a removed key (`400 REASON_REQUIRED` + `affected`).
  `null` attributeKeys re-arms the default and drops nothing. The
  `attribute-labels` def's zod refuses keys or names that differ only by
  case. 4 e2e in `instrument-profiles.e2e.test.ts`, mutation-checked. **No
  count moved, no migration.**
- **2026-09-22 — Layout Designer: polygon rooms and room links.** Migration
  `20260922120000_floorplan_polygons_links` (hand-authored, the partitioned
  DROP stripped, both databases, drift guard PASS, migration guard OK):
  `floorplan_rooms.points JSONB` (NULL = a rectangle; when present the server
  DERIVES `x/y/w/h` as the bounding box on every write — `roomGeometry()` in
  `floorplans/validation.ts` — and an OMITTED `points` on PUT keeps the stored
  polygon AND its box), `floorplans.image_path` nullable (a blank plan), and
  the table `floorplan_room_links` (model `FloorplanRoomLink`, **36 → 37**;
  `kind` OPENING | CONNECTOR a validated string, enums 13 unchanged). Doors may
  name `edge` instead of `wall`; the shared `doorEdge` is the converter and
  the overlap check groups by edge. Three routes on the existing module
  (`POST/PUT/DELETE /:id/links[/:linkId]`, CONFIG_UPDATE +
  `UPDATE_FLOORPLAN_ROOM` re-auth): an OPENING is checked against the rooms'
  REAL outlines with the shared `sharedEdges` (400 `NOT_ADJACENT`), a
  CONNECTOR refuses a duplicate pair either way round (409). Audit actions
  103 → **106**, templates 97 → **100** (`FLOORPLAN_LINK_*`; `{room}` carries
  "A ↔ B", no new placeholder). `points`, door `edge` and `links` are DECLARED
  in the response schemas — each was mutation-checked by deleting the
  declaration (the eighth time the Fastify strip has mattered here). Pinned by
  `e2e/floorplan-polygons.e2e.test.ts` (5) and `e2e/floorplan-links.e2e.test.ts`
  (3) plus 6 unit cases; the older floorplan e2e files green unchanged.
- **2026-10-01 — floors in the 2D architectural style: one shared trace module,
  one generic draw script.** **No count moved, no migration.**
  `modules/floorplans/architectural-layout.ts` holds the trace types
  (`ArchLayout`, `ArchRoom`, `ArchDoor`) and the px → stored conversions
  (`archPoints`, `edgeDoor`, `archAnnotations`, which sets `style:
  'architectural'`); they were lifted out of `qc-layout-2.ts` unchanged when
  Microbiology became the second such floor, and QC's output was compared byte
  for byte. `microbiology-layout.ts` was rewritten in place as an `ArchLayout`
  (21 polygon rooms, 25 door leaves, 4 columns, 7 windows; the rectangle trace
  and its `TRACED` entry are gone). `scripts/draw-architectural-floor.ts --area
  "QC Microbiology" [--apply]` draws it — dry run by default, every room
  through `validateRoomPayload`, one audit row per room / link / plan, label /
  grade / meta carried by room code. QC keeps `draw-qc-layout-2.ts`.
  `draw-cwh-floorplan.ts` skips both (`DRAWN_ELSEWHERE`). Two leaves of a
  double door are stored 1 px apart: the door overlap check refuses two doors
  that touch on one edge once their fractions are rounded. Pinned by
  `__tests__/microbiology-layout.test.ts` (16, mutation-checked: hinge end, an
  off-grid edge, a door on the wrong room, the outward swing). Applied to
  `compliance_core_db` only; AWS needs the script run after the next deploy.
  - **A door has an optional `swing: 'in' | 'out'` (same day).** `'out'` is an
    EXTERIOR door that opens out of the building (Microbiology's emergency
    exit); absent = in, every door before it. It is named in `doorSchema`
    (`validation.ts`) — the parsed payload is what the route stores, so an
    unnamed field is dropped on save — AND in `roomProps.doors` (`routes.ts`),
    or Fastify strips it on the way out. `hinge` had the same two requirements
    and no HTTP test until now: `e2e/floorplan-polygons.e2e.test.ts` asserts
    both fields over the write and both reads, mutation-checked by deleting
    each line from the response schema. `ArchAnnotations` gained optional
    `equipment` / `labels` (outlined plant and its caption); a trace without
    them emits the same JSON as before.
  - **QC 3 is the third such floor (same day), and the rectangle-trace path is
    GONE.** `qc3-layout.ts` rewritten in place as an `ArchLayout` (31 rooms
    tiling an L-shaped building, 44 door leaves + 4 leafless openings, 26
    columns, 7 windows, 3 outlined boxes); `draw-architectural-floor.ts --area
    "QC 3"`. With no floor left on it, `traced-layout.ts`,
    `__tests__/traced-layouts.test.ts` and the `TRACED` / `tracedRooms` branch
    of `draw-cwh-floorplan.ts` were removed; that script now only generates
    Stability, Module-E, Module-F and Ware House. `vPair` / `hPair` build a
    double door. A corridor that runs right round a block is two rooms of ONE
    code (`CWH-I/235` and `CWH-I/235 (2)`): a stored outline cannot have a
    hole. Pinned by `__tests__/qc3-layout.test.ts` (14, mutation-checked: an
    off-grid edge, touching leaves, an exit swinging in).
  - **QC 3's NORTH ROW is drawn larger than the drawing has it (same day,
    operator: "rooms are very small and those data was showing very
    small", "increase widgth") — the ONE deliberate departure on any traced
    floor.** `NORTH_ROW` (32 px taller), `NORTH_X` (the four partitions: the
    two LCMS rooms 82 px wide, the three glass-ware rooms ~50) and `qc3Y`
    are exported from `qc3-layout.ts`; the room table still holds the
    MEASURED y values and the export maps them (`drawn`, `drawnBox`), so a
    re-measure compares like with like. A hinged door in a vertical wall
    and a column keep their own size inside the stretched band; rooms below
    it move 32 px down unchanged. Canvas 870 x 850. The test file checks
    edges against the drawing's lines passed through `qc3Y` (20 tests now;
    five more mutation checks: the row not stretched, rooms below not
    shifted, a door or a column stretched with the row, the LCMS rooms at
    the drawn width). Re-applied to `compliance_core_db`; AWS needs it.
  - **Module-E is the fourth such floor (same day).** `module-e-layout.ts`
    (25 rooms, 22 door leaves + 13 leafless openings, 17 columns, 7 windows,
    4 stubs, 12 sliding-door bars), `draw-architectural-floor.ts --area
    "Module-E"`; `draw-cwh-floorplan.ts` skips it. **The source is a vector
    PDF and the numbers are PDF POINTS read from the file** (PyMuPDF,
    `page.get_drawings()` x `page.rotation_matrix` — the page is stored
    rotated 270 degrees), each partition on the midline of its two faces.
    New in this trace: VOIDS (ducts, column casings, cavities) that no room
    covers — the test's tiling check is "exactly one room, or a listed
    void" — and a duplicate room code on the drawing (CWH-I/017 twice; the
    second stored as `CWH-I/017 (3.5KL BLENDER)`, which the view's
    continuation rule does not match because that needs `(digits)`).
    Pinned by `__tests__/module-e-layout.test.ts` (16, mutation-checked six
    ways). Applied to `compliance_core_db` only; AWS needs the script run.
  - **Module-F is TWO floors (same day).** `module-f-layout.ts` (ground: 28
    rooms, first: 21; both from VECTOR PDFs in PDF points) exports the
    MEASURED traces (`MODULE_F_GROUND_TRACE` / `_FIRST_TRACE`) and the DRAWN
    layouts (`_LAYOUT`), the latter through the new `enlargeLayout(layout,
    {x, y bands})` in `architectural-layout.ts` — taller and wider where the
    rooms were too small for a card (QC 3's north-row precedent, generalised):
    leafless openings and bars stretch with the wall, a hinged door keeps its
    width and moves with the wall line nearest its doorway (a double door's
    leaves together), a column / window / bar keeps its size or thickness and
    moves with its wall line. `ArchLayout` gained `floor?` (`{group, label,
    order}`), `north?` and `renamesPlan?`; `archAnnotations(b, a, {floor,
    north})` emits them; **`planProps.annotations` DECLARES `floor` (inner
    keys) and `north`** — the ninth time the response filter has mattered;
    pinned in `floorplan-annotations.e2e.test.ts` (9), mutation-checked.
    `draw-architectural-floor.ts` takes SEVERAL layouts per area, finds the
    plan by name, else RENAMES the plan named by `renamesPlan` (audited
    `FLOORPLAN_UPDATED`), else CREATES it beside its sibling floor
    (`FLOORPLAN_CREATED`). 072-00 "3.5KL Blender" is unplaced on purpose.
    Pinned by `__tests__/module-f-layout.test.ts` (61; mutation-checked:
    the door anchoring). Applied to `compliance_core_db` only; AWS needs
    `--area "Module-F" --apply`.
- **2026-10-26 — PROFILE MEASUREMENTS (phase 1): every key mapping is the
  instrument PROFILE's.** Migration `20261026120000_profile_measurements`
  (hand-authored; the partitioned DROP, the audit-chain noise and an FK
  drop/re-add stripped; applied to `compliance_core_db` AND
  `compliance_core_db_test`; the drift guard's steps run as plain commands —
  `scripts/verify-migrations.ps1` is blocked by the PowerShell execution policy
  here — PASS): table `measurement_types` (model `MeasurementType`, 37 → **38**,
  enums unchanged) seeded TEMPERATURE / HUMIDITY; `instrument_profiles.measurements`
  JSONB backfilled from THIS install's four config rows through two `pg_temp`
  functions (session-only, nothing persists). Read ONLY through
  `modules/instruments/profile-measurements.ts` (10 s cache, invalidated by
  every profile write); `load-limits` / `load-range` / `load-offsets` keep
  only their global switches; `decimals.ts` lost `loadDecimalsConfig`;
  `telemetry-overview.loadAliases` is GONE. New routes:
  `GET /api/instrument-profiles/measurement-types`,
  `POST /api/instrument-profiles/:id/measurement-impact`,
  `GET /api/instruments/offset-keys`, `GET /api/config/telemetry-slots/refresh`.
  `OverviewRow` carries INTERNAL `profileId` / `measured` (not in the route
  schema — stripped on the wire). Every `measurements` inner key is DECLARED
  in `profileProps` (mutation-checked: dropping it fails 8 e2e). The evaluator
  gained a STRANDED pass. **A test must own its fixture profile** — three
  worker tests took `instrumentProfile.findFirst()` and failed once profiles
  differed. Feature note: `docs/feature-notes.md` PROFILE MEASUREMENTS.
- **2026-10-28 — DEVICE ATTRIBUTES ON EVERY PROTOCOL.** HTTP `POST`/`GET
  /api/ingest/v1/attributes` (new PUBLIC path — `public-paths.test.ts` updated
  deliberately), WS/TCP `{"attributes":…}` / `{"subscribe":"attributes"}`
  (`device-attributes.ts`, `attribute-sessions.ts`). `ingestAttributeReport` takes
  `transport` / `certificateVerified`; `publishAttributeDownlink` pushes to
  subscribers (keyed by instrument ID, `AttributeDownlink.instrumentId`/`gatewayId`
  REQUIRED) before the broker. Every push re-runs re-auth + the certificate rule.
  No count moved. `e2e/device-attributes.e2e.test.ts` (10), mutation-checked 9 ways.
- **2026-10-28 — BULK UPLOAD UPDATES an existing Instrument ID.** `POST /bulk`
  and the new `POST /bulk/preview` (INSTRUMENT_CREATE, writes nothing) share ONE
  plan, `bulk-plan.ts` `planBulkUpload()` (pure), fed by `planBulkFile()` in
  `routes.ts`; the upload re-plans the file and never trusts the preview. An
  existing ID gets the attribute cells that DIFFER (blank keeps; identity columns
  not applied); another profile / out of view / no Instrument Update / a refused
  key = a row error; one remark when a recorded value is overwritten (400
  `REMARK_REQUIRED` writes nothing). `applyBulkChanges` locks every key before the
  first `auditLog`. `updated` / `unchanged` / `changes[].from` (nullable) are
  DECLARED — mutation-checked. **No count moved, no migration.** Pinned by
  `e2e/bulk-update.e2e.test.ts` (15) and `__tests__/bulk-plan.test.ts` (20).
- **2026-10-28 — WIDGET DATA KEYS, phase 1 (server).** Two routes in a child
  plugin of the instruments routes (`data-keys-routes.ts`, so no `app.ts` /
  `test-helper.ts` registration): `GET /api/instruments/data-keys` and
  `POST /api/instruments/latest-values`; `keys` on `/:id/telemetry` and
  `/telemetry-history`. **No count moved, no migration.** `resolvedSlotFor` is
  NOT yet used by `floorplans/room-history.ts` or `telemetry-aggregate.ts`, which still treat every device key of a slot as that measurement (pre-existing; raised as a follow-up). Rules: the catalogue
  reads `instrument_telemetry_latest` (never a history `GROUP BY`) and judges
  `numeric` by `NUMERIC_READING`; latest-values takes its rows from
  `buildTelemetryOverview({ instrumentIds, visibilityWhere })` — a measured key's
  bounds are the overview's, never re-resolved, and the route is in the
  "every server resolver agrees" e2e; a raw key's `decimals` is null (print as
  received). Every response field is declared (`value` with no type = any JSON);
  the latest-values body is validated by the shared zod schema, the JSON schema
  only documents it. `getDistinctKeys` stays on history (the chart path's
  "every key"). **"Measured" is ONE function on the key-naming routes, `resolvedSlotFor`**: only the key a
  slot RESOLVED to on the instrument (the overview's choice) is that measurement —
  the chart path's `slotFor` uses it too, which fixed the trend page charting the
  wrong one of two device keys. An empty id list is a 200 `[]`. Pinned by
  `e2e/data-keys.e2e.test.ts` (27, mutation-checked six ways, incl. a real HTTPS
  ingest case), the two-key resolver-agreement case and `__tests__/keys-param.test.ts`.
- **2026-10-27 — DEVICE CERTIFICATES: a profile can require each device's own
  client certificate.** Migration `20261027120000_device_certificates`
  (hand-authored, applied to `compliance_core_db` AND `_test`; models 38 / enums
  13 unchanged — five nullable `instruments.device_cert_*` columns and
  `instrument_profiles.require_device_certificate` DEFAULT false). Audit 98 →
  100 / 111 → 113. No permission, reauth action, module, def or page moved.
  - **ONE decision** (`modules/instruments/device-certificate.ts`) for HTTPS
    (`ingest-routes.ts`, 403), WebSocket (`ws-listener.ts`, close 4403, also on
    every later frame), MQTT (`mqtt-auth-routes.ts`, from `cert_subject`) and raw
    TCP (`tcp-listener.ts`, never TLS → refused); the gateway fan-out drops a
    requiring child unless the connection carried the gateway's own certificate
    (`fanoutDevices(…, { certificateVerified })`, omitted on MQTT = judged at
    CONNECT). The facts ride on the cached `IngestIdentity.deviceCert` and
    `ChildRef.requiresCertificate` — every route that changes them invalidates
    the caches and kicks the MQTT session.
  - **`lib/https-options.ts`** builds the server's TLS options (lifted from
    `app.ts` so a test builds the same server): with the device CA it adds
    `requestCert: true, rejectUnauthorized: false, ca: <device CA only>`.
    **`app.inject` never performs a TLS handshake** — `socket.authorized` is
    exercised ONLY by `e2e/device-certificate-tls.e2e.test.ts`, which runs a real
    https listener. Keep that file when touching any of this.
  - `modules/instruments/device-ca.ts` issues with `@peculiar/x509` 2.1.0
    (exact; needs `reflect-metadata`, imported there). `device-certificate-
    routes.ts` is a child plugin of `instruments/routes.ts`, so it needed no
    registration in `app.ts` / `test-helper.ts`. `codeLabel` moved to
    `code-label.ts` (both route files use it; importing back from `routes.ts`
    would be circular).
  - **Every device-certificate test owns its env**: they set
    `DEVICE_CA_CERT_PATH` / `_KEY_PATH` to a temp CA in `beforeAll` and restore
    it FIRST in `afterAll`; the "inert" cases delete the variable inside a
    try/finally. `apps/api/.env` on this checkout now carries a real local
    device CA (`certs/device-ca.*`, git-ignored).
- **2026-10-03 — a SUPER_ADMIN deletes a functional location with everything
  in it.** `DELETE /api/functional-locations/:id` takes `?cascade=true`:
  refused 409 `NOT_EMPTY` without it (as before), 403 `SUPER_ADMIN_ONLY` with
  it for any other role; for a super admin the Areas are deleted (before the
  Block — the parent FK is RESTRICT), the instruments in any of them set to
  `functionalLocationId: null`, and one `FUNCTIONAL_LOCATION_DELETED` row per
  location written inside the transaction (`auditLog(entry, tx)`), the Block's
  carrying `areasDeleted`, `instrumentsUnlinked` and
  `instrumentsUnlinkedInAreas`. Pinned by `e2e/functional-location-delete
  .e2e.test.ts` (4; the role gate mutation-checked). **`audit_trail
  .signature_meaning` is `VARCHAR(255)` and the audit insert is RAW SQL, so a
  longer meaning is a 500, not a truncation** — the order route's listed every
  block name and `functional-location-order.e2e.test.ts` had been failing 2 of
  14 on the test database's leftover blocks; `boundedMeaning()` (exported from
  `functional-locations/routes.ts`, 3 unit tests) lists what fits and counts
  the rest. Keep every `signatureMeaning` short; the detail belongs in
  `beforeValue` / `afterValue` (JSONB, unbounded). No count moved.
- **2026-09-16 — the instrument CODE is changeable.** `PUT /api/instruments/:id`
  accepts `code` (shared `updateInstrumentSchema`, same `codeSchema` as create).
  **No count moved, no migration.** The code is the MQTT client id and every
  topic segment, which is why it was immutable; `afterCodeChange` (inside the
  plugin, after the commit, never throws) now clears the old retained
  attribute slot, republishes the set under the new code, and for a gateway
  clears the old roster and moves every child's slot; the caller's existing
  roster pass publishes the new rosters. `invalidateIngestAuthCache` so the old
  client id is refused at once. Name follows the code when it was the code.
  Duplicate → 409 `DUPLICATE_CODE`. **The device must be reconfigured by
  hand** — the platform cannot reach it. Pinned by
  `e2e/instrument-rename.e2e.test.ts` (6) over `setDownlinkPublisher`.
- **2026-09-05 — `GET /api/instruments/telemetry-history`: the merged, paged
  readings of SEVERAL instruments** (the Instruments page's history widget).
  **No count moved** and **no migration**: one new route on the existing
  module, `INSTRUMENT_READ` like its siblings, registered before `/:id` as
  `/telemetry-overview` is. `getMultiInstrumentHistory` pivots in SQL —
  `jsonb_object_agg(key, value)` GROUP BY `(instrument_id, ts)`, newest first —
  so a page boundary cannot split an instant's temperature from its humidity;
  `total` counts instants. Values are RAW and unfiltered by key: the slot keys,
  limits and precision are `telemetry-overview`'s per-instrument answer, and a
  site-wide alias filter here would drop an instrument whose keys have drifted.
  **Visibility is applied to the ID SET** (`withVisibility({id:{in}})`) before
  the query — out of scope is absent, never 403. `values` is declared
  `additionalProperties: true`; an object schema without it serialises to `{}`
  silently, the sixth time the response filter has mattered here. Pinned by
  `src/e2e/telemetry-history.e2e.test.ts` (5, incl. the OPERATOR scope case —
  which needs `INSTRUMENT_READ` granted and `invalidateRolePermsCache`, as
  `instrument-scope-selection.test.ts` does; seeded instants must be inside an
  EXISTING partition, i.e. near now). Mutation-checked: dropping the visibility
  filter fails it.
- **2026-09-05 — the ATTRIBUTE REPORT: a device writes attributes over
  MQTT.** New module `modules/instruments/attribute-report.ts`; topic
  `instruments/<code>/attributes/report`, dispatched by the bridge BEFORE
  `isDownlinkTopic` (which would swallow it — it contains `/attributes/`).
  Telemetry batch shape, same parser and fan-out, same child-map
  authorisation. **New audit action `INSTRUMENT_ATTRIBUTE_REPORTED`** (97 →
  98 / 91 → 92), in `SYSTEM_AUDIT_ACTIONS` because there is no user — the
  device's code is in the row and in the fixed reason. Unchanged values are
  neither written nor audited (firmware re-reports every minute). Keys a
  device may write are administered on the `instrument-attributes` def
  (`deviceWritableKeys`, blank = any); a refused key is dead-lettered by name.
  The role gate (`attributeWriteRefused`) is NOT consulted — a device is not a
  role. `report` joined `MQTT_RESERVED_TOPIC_SEGMENTS`. Republishes the
  per-instrument slot and the bundle after the commit. ACL publish grant
  widened; local broker restarted; AWS needs the same. Pinned by
  `e2e/mqtt-attribute-report.test.ts` (8, over the real bridge and database)
  and 5 unit.
- **2026-09-05 — RTC sync.** `modules/instruments/listeners/rtc-sync.ts`:
  `{"method":"getTime"}` on `instruments/<code>/rtc-request` (dispatched by
  the bridge before the telemetry parse; any active instrument may ask; other
  methods ignored with a log) → exactly `{"unix":<epoch-ms NUMBER, 13 digits>}`
  (operator: "{"unix":1792221233122}"; the shape moved three times on 2026-09-05
  and the firmware parser is the authority) on the
  GLOBAL `digilog/rtc/time`, not retained, AND every 10 minutes on the
  wall-clock boundary (`RTC_TICK_MS`; every minute for its first hours,
  operator: "make it every 10 minutes") from `startRtcTicker()` — started in `app.ts` right after
  `setDownlinkPublisher`, stopped in shutdown before the bridge closes, both
  timers `unref()`'d. **Outside `instruments/` on purpose**: the bridge's
  `instruments/#` would otherwise hand the tick back to itself on every tick,
  and one literal ACL grant serves every device. `rtc-request` reserved as a
  last segment. No count moved. 8 unit (ticker under fake timers) + 3 e2e.
  **`MqttBridgeHandle.publish` refuses a NON-RETAINED publish while offline**
  (found live: two stale ticks flushed together on reconnect); retained state
  still queues. Any future event-style downlink inherits that rule.
- **2026-09-05 — the child attribute CHANGE event.** Module
  `modules/instruments/child-attributes-bundle.ts` (the file name is the
  morning's design; the topic is the same). `instruments/<gw>/children/attributes`
  is an EVENT — `EVENT_PUBLISH_OPTIONS`, QoS 1, `retain: false` — published
  from `announceAttributeChange` (after the per-child slot) and from the
  device report path, once per changed key, carrying ONLY that key under the
  child's `devN` (`null` = removed). Membership publishes nothing there;
  nothing to clear on gateway delete. **Reshaped twice the same day** at the
  operator's direction: retained whole-set bundle → the changed child's full
  set → the key alone. `publishRetained` gained an `options` parameter for it
  (default unchanged). The retained copy on the local broker was cleared by
  `scripts/clear-child-attribute-bundles.ts`. Pinned by 3 e2e (incl. `retain
  === false` off the captured options, and "only Location, not the limit, not
  the sibling") + 3 unit.
- **2026-09-01 — the enable-flag rule spanned THREE resolvers, and all three
  were wrong at some point on the same day.** "A bound the instrument switches
  off is not enforced" was implemented independently in `buildTelemetryOverview`
  (cards, dashboard table, floorplan tiles, the chart's limit LINE), in
  `instruments/routes.ts:boundsFor` (the summary strip, the SQL breach counts and
  the signed PDF), and in the trend card's own status fall-through. Each was
  written by someone who verified their own and assumed the rest were covered.
  - **The visible symptom was a number and a picture disagreeing on one screen**:
    the limit line vanished correctly while the strip beside it went on counting
    breaches in SQL against the bound it had stopped drawing — into a §11 report.
    A second symptom was a normal 24.5 °C reading "Out of limit" because the card
    inherited the OTHER slot's verdict against a humidity bound of `0` that the
    instrument disables.
  - **The generalisable lesson, and the test that now encodes it:** N tests each
    pinning one resolver cannot catch two resolvers DISAGREEING, which is the
    only failure that reaches a screen. `src/e2e/instrument-telemetry-range.test.ts`
    → `every server resolver agrees about a disabled bound` asserts the overview
    and the chart summary return the SAME bounds for one instrument, rather than
    asserting each is independently null. Mutation-checked: diverging one
    resolver fails it with "the chart summary and the overview disagree".
    **If a third server-side consumer of these bounds is added, add it there.**
  - A disabled bound comes back **NULL** ("not judged"), never `0` ("checked,
    never breached"). The gate is per-bound: disabling the high limit must not
    silence the low one.

- **2026-09-01 — `telemetry-overview` returns the two placement facts it was
  missing.** **No count moved** (35 models, 12 enums, 42 permissions, 48 reauth
  actions, 24 modules) and there is **no migration**: one existing endpoint
  returns two more fields.
  - `functionalLocationName` (from a new `functionalLocation: { select: { name:
    true } }` on the existing query) and `locationAttribute` (the `Location`
    ATTRIBUTE, read from the attribute rows the query ALREADY selects for the
    limits — no second query, no `where` on the relation).
  - **`locationAttribute` is named for its source and must never be called
    `location`.** `Instrument.location` is a live free-text COLUMN of the same
    name, superseded and read by nothing; a bare `location` would be
    indistinguishable from it at every call site. An e2e case sets that column
    to different text and asserts it is NOT what comes back.
  - Attribute matching is trimmed and case-insensitive, the same rule
    `resolveLimit()` in `@digilog/shared` uses. A blank value is treated as
    ABSENT — an attribute somebody created and left empty says nothing, and
    letting it through renders a cell that looks like a rendering fault.
  - **Both are DECLARED in the route's 200 block, and this is the FIFTH time an
    undeclared field has bitten this repo** — after `historySampled`/`summaries`,
    the alarm list's `locationName`, the floorplan `meta`/`annotations`, and
    `rangeBounds`. The guard is `src/e2e/telemetry-overview.e2e.test.ts`, which
    asserts through `app.inject`, never off the builder's return value.
    **Mutation-check it by deleting the field from the SCHEMA, not the builder**:
    a builder mutation exercises a path that was never in doubt. Deleting both
    schema lines fails all 5.
- **2026-08-31 — a quoted number is a reading.** `coerceReading()` in
  `@digilog/shared` replaced four independent `typeof v === 'number'` tests
  (`telemetry-overview.asNumber`, the chart's plottable filter, the web
  `numericRows`, `toTableRowsWithErrors`) AND the `jsonb_typeof(value) = 'number'`
  cast in `telemetry.repository.ts:getRangeSummary`. **If you widen one, widen the
  SQL too** — otherwise the summaries are computed over a different population
  than the chart drawn from the same range.
- **2026-08-31 — alarm type names in one config.** Def `alarm-type-names`
  (28 → 29), route `/api/config/alarm-type-names/current`, loader
  `modules/alarms/load-type-names.ts`. **The loader lives with the alarm loaders,
  NOT beside its route** — the evaluator reads it on every pass, and a worker
  importing a Fastify route module drags the HTTP layer into the job runner.
  `alarmTypeKeyFor()` in `@digilog/shared` is the one mapping both sides use.
  Names are read live; nothing frozen moves with them.
- **2026-08-31 — per-bound ENABLE attributes on instrument limits.** No count
  moved and no migration: four alias-list settings on the existing `alarm-limits`
  def, plus `enabledBoundsFor()` in `load-limits.ts` and a gate in the limit pass.
  - `parseEnableFlag` / `resolveEnableFlag` live in `@digilog/shared` beside
    `resolveLimit` and follow its key-precedence rule exactly.
  - **Absent/blank/unreadable = ENABLED**, in BOTH places that decide it:
    `parseEnableFlag` (attribute present, value unusable) and `enabledBoundsFor`'s
    `?? true` (attribute absent). The second is the one that actually fires for a
    missing attribute — the first is unreachable for that case, which a mutation
    check exposed.
  - **A disabled bound CLEARS an alarm open on it**, bypassing the
    `value === null` hold guard, because the clear is not "returned to spec" — the
    bound is simply no longer enforced. Notification wording says so.
  - Pinned by 5 unit + 8 e2e; mutation-checked three ways. **The new e2e block
    initially inherited `High Temperature Limit = 99` from the test above it and
    every "raises" assertion failed for the wrong reason** — it now pins its own
    bounds in `beforeEach`. Depending on file order is how a suite starts passing
    vacuously.
- **2026-08-31 — sensor RANGE alarms, a FIFTH alarm source.** `AlarmSource`
  gains `SENSOR_RANGE`; **36 models / 13 enums UNCHANGED**. Config defs
  **27 → 28** (`sensor-range-alarms.def.ts`). Migrations
  `20260831180000_sensor_range_alarms` + `20260831180001_sensor_range_unique_active`
  (`alarms_active_sensor_range_unique` on `(instrument_id, metric)`), separate for
  the usual Postgres enum reason, applied to both databases, drift guard PASS.
  - **The load-bearing behaviour is SUPPRESSION, not the alarm.** An out-of-range
    reading is withheld in `telemetry-overview.ts` — `rangeError` set, numeric
    slot nulled — so the limit pass neither raises nor clears from it. Done at the
    single point where a stored value becomes "a reading"; anywhere else and one
    consumer trusts a number the others rejected. Pinned by
    `src/e2e/alarm-sensor-range.e2e.test.ts`, whose key assertions are "60 raises
    a range alarm and NO limit alarm" and "30 still raises a normal limit alarm".
    Mutation-checked: deleting the null-ing line fails 3.
  - `loadRangeConfig`/`rangeFor` reuse `parseLimitKeys`/`resolveLimit` from
    `load-limits.ts` on purpose — range bounds are attributes read by ordered
    alias exactly as limits are, and a second resolver would drift.
  - The snapshot freezes the reading, the span, AND the attribute key each bound
    came from, so "it fired against `High Temperature Range` = 50" survives a
    rename.
  - `decideRange` holds the alarm open when the probe falls silent OR starts
    sending `NA` — clearing on the arrival of a non-numeric value would declare a
    saturated probe healthy at the moment it broke a second way.
- **2026-08-31 — the alarm list filters, counts, sorts and pages SERVER-side.**
  **No count moved** (re-derived that day: 36 models / 13 enums, 42 permissions,
  48 reauth actions, 24 modules, 25 config defs) and there is **no migration**:
  one existing route gained query parameters and two response fields.
  - **The defect.** The Alarms page filtered and counted in the BROWSER over
    `GET /api/alarms?limit=500`. The four state boxes therefore counted the
    newest 500 alarms while reading as plant-wide totals. Same shape as the
    `GET /:id/telemetry` truncation fixed 2026-08-27 — a `limit` and a range
    meeting in one query — and the page's own comment defended it as a feature.
  - New pure module `modules/alarms/list-query.ts` holds the whole filter
    algebra: `parseAlarmListQuery` / `buildAlarmWhere` / `buildAlarmOrderBy` /
    `quadrantWhere` / `pageBounds`. Two properties it exists to guarantee:
    **every fragment is ANDed, never merged** (search and the location filter
    both want an `instrument` key, and a merged key would silently WIDEN the
    result, which composes with visibility scoping into an access-control bug);
    and **a bad filter is a 400, not a shrug** (an unreadable date or a reversed
    range is refused by field — dropping the bound would list alarms from
    outside the range under a header claiming it applied). An unknown `sort`
    falls back instead of erroring: it changes the order, not which rows.
  - **All four state counts come from ONE `groupBy`, and `total` is DERIVED by
    summing them.** `_count.acknowledgedAt` counts rows where that column is NOT
    NULL, which IS the signature axis, so grouping by `state` and reading `_all`
    against it yields the whole 2x2 in a single pass. Four separate `count()`s
    would be four separate points in time, and this page polls beside a live
    evaluator. The `status` filter is excluded from that query ALONE — every
    other filter narrows it — so choosing a box does not zero the other three,
    and a card's number and "showing N of M" answer the same question.
  - **Legacy parameters all still work.** `state`, `acknowledged`,
    `instrumentId`, `functionalLocationId`, and `limit` — the last now an alias
    for `pageSize` with the same 500 ceiling, which is why
    `ALARM_PAGE_SIZE_MAX` is 500 and not something tidier: the dashboard's
    selection panel and the trend page's alarms widget both send `limit=500`,
    and a lower ceiling would silently truncate them.
  - Response gains `instrumentName`, `locationName` (the FUNCTIONAL location,
    not the superseded free-text `instruments.location`) and `roomLabel`.
    Declared in `alarmProps` — Fastify strips any field the response schema
    does not name, which has cost this repo twice.
  - Pinned by `src/modules/alarms/__tests__/list-query.test.ts` (28 unit tests,
    mutation-checked) and `src/e2e/alarm-list-filters.e2e.test.ts` (17 e2e,
    every request scoped to a fixture Block so the numbers are exact).
- Config definitions: `apps/api/src/modules/config/defs/` (**34 files** — `ls` 2026-10-01; `sensor-offsets.def` added that day (Temp / Humid Off set applied at ingest; see root CLAUDE.md). Earlier **33 files** — `ls` 2026-10-01; `report-downloads.def` added that day: per report KIND Direct / Request, remarks and password, settings BUILT from `REPORT_KINDS`, enforced by `report-reviews` and `audit/report-export-log`, served by `static-routes/report-downloads.routes.ts`. Earlier **32 files** — `ls` 2026-09-16; `attribute-labels.def` added that day: what each instrument attribute KEY is called on screen, ONE `json` map setting with a `zodSchema`, `hasCustomPage: false` + `customPagePath: '/config/instrument-attributes'` so the generic dynamic GET/PUT keep validating, gating and auditing while the names are edited as a column on the Instrument Attributes page (no page of its own — operator); the bulk-upload route now reads the profile's keys + this map (`bulkAttributeColumns`) so `parseInstrumentCsv` can map display-name headings back to keys, and writes the filled cells per instrument through `writeInitialAttributes` (one `INSTRUMENT_ATTRIBUTE_SET` row per key, device announced after commit); `name` stopped being a required CSV column (blank = the code); served to all users by `static-routes/attribute-labels.routes.ts` (`/attribute-labels/current`, the eighth narrow-slice route, `additionalProperties` declared or the map arrives as `{}`); 6 e2e in `attribute-labels.e2e.test.ts`; **2026-09-21 the same def and route gained a second setting, `settingsHidden: {instrumentId, keys[]}` — the fields the Settings PAGE hides (the hidden set, so a new key shows by default); the zod refuses a bad shape and accepts the field's absence, the `/current` response declares both inner keys (mutation-checked: dropping them fails 3 e2e), `coerceSettingsHidden()` in `@digilog/shared` is the reader; no count moved, 9 e2e now**. The 27 recorded next was ALREADY STALE by four — `alarm-type-names`, `sensor-range-alarms`, `trend-widgets` and `report-approvers` landed without this line moving. Earlier **27 files** — `ls` 2026-08-31; `rs485-alarms.def` added that day for the RS485 sensor-failure source, also rendered by the dynamic config page. Earlier **26 files**; `inactivity-alarms.def` added that day for the inactivity-alarm source, rendered by the dynamic config page so it adds no `routes/config/*.tsx`. Earlier **25 files** — verified by `ls` 2026-08-17; `alarm-limits.def` added 2026-08-17 (which attribute keys carry each temperature/humidity limit, the limit-alarm severity, the master switch, and the four alarm status wordings). `telemetry-slots.def` added 2026-08-11. Earlier note: the previous "36" was inherited from DigiLog and was never true here. `instrument-attributes.def` added 2026-08-07)
- Route modules: `apps/api/src/modules/` (**25 modules**, verified `ls | wc -l` 2026-09-07 — `report-reviews` added 2026-09-07 (the report review workflow: every PDF download is a request an approver signs; six routes, no DELETE, party-scoped, one conditional decision; registered in BOTH `app.ts` and `test-helper.ts`; `ReportReview` model + `ReportReviewStatus` enum, migration `20260907120000_report_reviews`, 35/12 → 36/13; 15 e2e in `report-reviews.e2e.test.ts`, mutation-checked). Earlier **24**, verified 2026-08-27 — `alarm-webhooks` added 2026-08-27; earlier 23, verified `ls` 2026-08-14 — `functional-locations` + `alarms` added 2026-08-13. **A new module must be registered in BOTH `app.ts` AND `src/e2e/test-helper.ts`** — the helper builds its own app, so a module missing from it 404s in every e2e test. Earlier: 21 modules verified `ls` 2026-08-11 — `floorplans` added 2026-08-11. The previous "33" was already stale and the shortfall has NOT been individually reconciled; treat the removal notes below as history, not an inventory — `org-admin`/`tenant-admin` deleted in MT removal; `rule-chain` deleted 2026-05-17; `qr-code` deleted 2026-06-06; **`data-ingestion`, `uns`, `connectivity`, `queries` deleted 2026-06-11..2026-06-17** with the ingestion tear-out; **`reports`, `report-templates` deleted 2026-07-04** with the reports generate/sign tear-out (`report-reviews` survives); `debug-traces` re-added 2026-06-12 reading from `audit_trail` instead of dropped `ts_pipeline_traces`)
- Config routes: monolith split into `apps/api/src/modules/config/static-routes/<surface>.routes.ts` per tab; top-level `routes.ts` is just a registration loop (~170 LOC, was 1003)

## Architecture
- **25** route modules registered via `apps/api/src/modules/*/routes.ts` (re-verified `ls apps/api/src/modules/ | wc -l` 2026-09-07 — `report-reviews` added that day; earlier 24, 2026-08-27; the "21" here was a 2026-08-11 snapshot, see the Key Paths note above for what changed since)
- Config auto-discovery at startup via `lib/config-discovery.ts`
- Config registry pattern via `lib/config-registry.ts` (self-registering config modules)
- Input sanitization: `lib/sanitize.ts` (HTML stripping on all text inputs)
- JWT auth with 30-min refresh, session management, re-auth for sensitive ops
- Permission-based RBAC via `requirePermission()` on all protected routes
- **`app.requireAnyPermission(...perms)`** (`plugins/rbac.ts`) — sibling decorator to
  `requirePermission()` for a route that can be satisfied by either of two permission
  families (e.g. a broad `CONFIG_UPDATE` or a narrower per-feature toggle). It shares
  the exact same `hasEffectivePermission()` fallback rules (`*_VIEW <- *_READ`,
  `*_<suffix> <- *_MANAGE`) as `requirePermission`, so the two decorators can't drift
  on what a role is allowed — live users today: `admin-requests`, `backup`, `uploads`.
  `enforceReauth(action, req, reply)` (`lib/reauth-check.ts`) pairs with it: it accepts
  `string | string[]` and fires reauth if the role requires it for **any** of the
  listed actions, for the same "one route serves multiple logical actions" case.
  (This pattern predates the filter-domain removal — the original 04-18 use case,
  documented in the now-archived `PHASE_5_RECENT_WORK.md` § 9, gated
  equipment-groups/checklist-profiles/PM/filter-ops permission-family fallbacks that
  no longer exist — but the decorator and its rationale are unchanged and current.)

## API modules (live)

**25** modules under `apps/api/src/modules/` (`ls apps/api/src/modules/ | wc -l`, 2026-10-05):
`admin-requests, alarm-webhooks, alarms, audit, auth, backup, config, dashboards, debug-traces,
floorplans, functional-locations, help, instrument-profiles, instruments, ldap,
notification-delivery, notification-rules, notifications, report-reviews, roles, super-admin,
system-health, uploads, user-groups, users`.

A "33 API Modules" list from 2026-07-04 stood here until 2026-10-05 beside this live one, with a
paragraph saying not to use it (audit finding DOCS-23 — two inventories for one number). It is
gone; which module was removed when (MT removal 2026-04-30, rule-chain 2026-05-17, the ingestion
tear-out 2026-06-11..17, the reports tear-out 2026-07-04, the Phase 0 filter-domain strip
2026-07-18) is in `CHANGELOG.md`.

## Databases
- **digilog_db** per `.env.example` (this checkout's actual `.env` uses `compliance_core_db` — see
  Environment note above) (PostgreSQL 18 via Prisma) — application data (**38 models, 13 enums** — 37 → 38 on 2026-10-26, `MeasurementType` —
  verified `grep -cE "^model "` / `"^enum "` 2026-10-05; 36 → 37 on 2026-09-22 with `FloorplanRoomLink` — see root `CLAUDE.md` System Stats for the
  live number, the "29 models, 6 enums" here is a 2026-08-08 snapshot, not current)
- ~~`digilog_tsdb`~~ — **DROPPED 2026-06-11** with the data-ingestion tear-out, still gone. All 6 hypertables removed (`ts_telemetry`, `ts_attributes`, `ts_checklist_responses`, `ts_device_events`, `ts_binary_data`, `ts_pipeline_traces`).
- `digilog_test_db` per `.env.example` naming (this checkout's actual test DB is `compliance_core_db_test`) — **the vitest suite runs entirely against this DB** (since 2026-07-02). `vitest.env.ts` forces `DATABASE_URL` onto it before Prisma connects, so e2e/integration writes never pollute the dev DB's immutable, hash-chained `audit_trail` (21 CFR §11). Same schema as the dev DB (migration-driven); seed it once with `DATABASE_URL=…/<test-db> INITIAL_ADMIN_PASSWORD=Admin@123 npx tsx prisma/seed.ts`.

## Database Migrations — READ BEFORE ANY SCHEMA CHANGE

**The schema is migration-driven (since commit `5141131`, 2026-06-25). `prisma db push` and `prisma migrate dev` auto-generation are FORBIDDEN against any populated DB — they can silently drop customer audit data (21 CFR §11).** Full rationale + the customer-install/upgrade design: `tasks/EXE-PACKAGING-PLAN.md` §2.

- **Baseline = a `pg_dump`, never regenerate it.** `prisma/migrations/00000000000000_baseline/migration.sql` is a full schema dump that includes triggers, functions, and manual sequences (`deviation_number_seq`, `qnn_seq`, `audit_trail_chain_position_seq`) — none of which `schema.prisma` can express (`grep -c "CREATE UNIQUE INDEX.*WHERE"` on the baseline returns 0; it holds no partial unique index). Regenerating it from the datamodel would silently delete those. The datamodel's first partial unique index is a later, separately hand-authored migration: `alarms_active_instrument_limit_unique` (`20260817120000_alarm_limit_unique_active`, one ACTIVE instrument-limit alarm per instrument/metric/bound) — same "Prisma can't express this" category, just not part of the baseline. Prior incremental history is archived in `prisma/migrations_archive_20260624/`; raw objects live in `prisma/sql/{extensions,invariants}.sql`.
- **Applying schema** (fresh install or upgrade): extensions first, then `migrate deploy`.
  1. `CREATE EXTENSION IF NOT EXISTS ltree; CREATE EXTENSION IF NOT EXISTS pgcrypto;` (i.e. apply `prisma/sql/extensions.sql`) — **required**; the baseline uses these but doesn't create them, so `migrate deploy` fails on a bare DB without it.
  2. `npx prisma migrate deploy` (root: `npm run db:migrate`).
  3. Seed with `INITIAL_ADMIN_PASSWORD` set (the seed throws without it). The seed is all `upsert` and never overwrites the admin password → upgrade-safe.
- **A guard now enforces the "strip the DROP" step (2026-08-29).** Every
  migration authored here since 2026-08-08 has had
  `DROP TABLE "instrument_telemetry_history"` generated by Prisma and removed
  by hand — fifteen of them say so in a comment. `apps/api/src/lib/migration-guard.ts`
  makes that automatic: it fails if any committed migration drops
  `instrument_telemetry_history`, `instrument_telemetry_latest` or `audit_trail`.
  It runs three ways — inside `npm test` (`src/lib/__tests__/migration-guard.test.ts`),
  as `npm run check:migrations`, and as a gate on `npm run db:migrate`.
  **Do NOT silence a failure by adding a Prisma model for the partitioned
  table**: Prisma would then emit a plain `CREATE TABLE` for a fresh
  environment, producing an UNPARTITIONED table, and ingest dies at the first
  month boundary when Postgres rejects rows outside every partition range.
  Strip the DROP from the migration SQL, as the previous fifteen did. Note the
  guard cannot save a LOCAL database — `prisma migrate dev` creates and applies
  in one step — it stops the damage reaching the repo, CI and production.
- **Authoring a NEW migration** (the auto-gen `migrate dev` flow is unreliable here because the pg_dump baseline always reads as "drift" vs the datamodel):
  1. Edit `schema.prisma`.
  2. `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script` → review, strip the out-of-band noise (triggers/functions/sequences managed in `prisma/sql/*`).
  3. Hand-author the reviewed SQL into `prisma/migrations/<UTC-timestamp>_<name>/migration.sql` (pattern: see archived `20260530_filter_reverse_mirror`). Keep `prisma/sql/*` in sync for any new raw objects.
  4. `npm run db:verify-migrations` — the drift guard: builds a scratch DB from migrations and asserts it diffs empty against your dev DB. **Must PASS before commit.**
  5. `npx prisma migrate resolve --applied <name>` on existing populated DBs (dev/test) so they don't re-run it.

## Key Libs (`apps/api/src/lib/`)
- `audit.ts` — hash-chained audit logger. Unkeyed SHA-256 by default (V1/V2); when
  `AUDIT_CHAIN_KEY` is set it writes a keyed HMAC-SHA256 (V3, `audit_trail.checksum_version=3`)
  so a DB-level actor can't forge the chain. Verifier requires the key for v3 rows; legacy rows
  keep the unkeyed fallback. See `lib/hash-chain.ts`.
- `ldap-identity.ts` — the single definition of "is this credential ours?".
  `isLdapUser()` + `verifyCredential()`, shared by `auth.service.login`,
  `authService.verify` (removed 2026-10-05 with POST /api/auth/verify, audit
  SEC-5), and `lib/reauth-check.ts` so a directory user's password
  is checked by an LDAP bind rather than bcrypt-compared against the
  `LDAP_EXTERNAL_AUTH` sentinel (which always fails). Added 2026-08-08 after
  that defect was found to make re-authentication — every 21 CFR §11.200
  e-signature — impossible for AD-authenticated users. Also exports
  `LDAP_PASSWORD_MANAGED_MESSAGE`, the one wording used wherever a local-password
  operation is refused. See `docs/LDAP-AD-INTEGRATION-GUIDE.md`.
- `sanitize.ts` — HTML stripping on all text inputs
- `config-discovery.ts` — Auto-discover config definitions at startup
- `config-registry.ts` — Self-registering config module pattern
- `jwt.ts` — JWT token management
- `reauth-check.ts` — Re-authentication enforcement with 10s in-memory cache

## Testing

```bash
cd apps/api && npm test    # Stable single-fork run (see below for why)
cd apps/api && npm run lint  # tsc over src/ AND over scripts/ + the seed (tsconfig.scripts.json, 2026-10-05)
```

**`npm run lint` type-checks `apps/api/scripts/` since 2026-10-05 (audit
DOCS-3).** `tsconfig.json` includes `src/**/*` only, so four scripts calling
`prisma.alarmRule` (removed 2026-08-31) and 26 further type errors in nine live
scripts sat unnoticed until a `tsx` run. A script that no longer compiles now
fails lint. `AuditEntry` accepts `null` on every optional field for that
reason (the insert always wrote `?? null`).

### Local Active Directory stand-in (2026-08-08)

`src/test-support/fake-ad-server.ts` is an AD stand-in speaking the real LDAP
wire protocol (`ldapjs`, devDependency). There is no directory to develop
against on this machine and none can be run — Docker/WSL2 are unavailable — so
this is how the LDAP code is exercised through the unmodified `ldapts` client
over a TCP socket rather than through a mock. It reproduces the customer's
layout (parent group → five role sub-groups → employees) and AD's
direct-vs-transitive `memberOf` distinction.

- `npx tsx src/test-support/fake-ad-server.ts` — run standalone on `:1389` and
  drive the real app in a browser; it prints every value to paste into the
  config page.
- `npx vitest run src/e2e/ldap-directory.e2e.test.ts` — 28 e2e tests over it.

It found two bugs no mock could: `ldap://` never worked (ldapts turns on TLS
whenever `tlsOptions` is present, and we always passed them), and every first
login bound to the directory twice. Does NOT cover TLS, AD's own
lockout/expiry, or paged `memberOf` — see `docs/LDAP-AD-INTEGRATION-GUIDE.md`
§2.4.

**If you add a `system_config` key to that e2e file, add it to
`TOUCHED_CONFIG_KEYS` in the same commit.** The suite shares
`compliance_core_db_test`; an earlier version restored only 2 of the 4 keys it
wrote and left `password-policy` stripped of its complexity flags, silently
breaking three unrelated `user.service.test.ts` tests.

### Single-fork requirement (read before running the suite)

The full `apps/api` test suite **must run in a single fork** to produce a
stable pass/fail count. The verified stable invocation is:

```bash
cd apps/api && npx vitest run --pool=forks --poolOptions.forks.singleFork=true
```

`npm test` is wired to this exact command so operators don't have to
remember the flags. If you invoke `npx vitest run` directly with the
default pool, you will see flaky failures that are NOT real bugs.

**Why** — two contention sources, neither introduced by any single test:

1. **Shared `admin` test user race.** `vitest.global-setup.ts` provisions
   one `admin` / `Admin@123` user (SUPER_ADMIN) and one `RB0001` /
   `Test@1234` user (OPERATOR) in `digilog_test_db` (was `digilog_db` until
   2026-07-02 — see DB-isolation note below). Most e2e/integration
   suites log in as `admin`. When vitest runs multiple worker forks in
   parallel, two files can hold concurrent sessions for the same user;
   one calling `POST /api/auth/logout` invalidates the session row the
   other is mid-request against, and the second worker sees a 401 it
   doesn't expect. `vitest.config.ts` already sets
   `fileParallelism: false`, but with the default `forks` pool that
   only serialises files *within* a worker — multiple worker processes
   can still be spawned. `singleFork: true` collapses everything into
   one process, which removes the race.

   **It is NOT only `logout` — every LOGIN invalidates a held bearer too
   (found 2026-09-01).** `src/e2e/test-helper.ts`'s `loginAs()` terminates ALL
   sessions for the user before issuing its token. So any suite calling
   `loginAs(app)` kills the `admin` bearer every other suite is holding, and
   `singleFork` does NOT help when the second suite is in a DIFFERENT PROCESS —
   another agent, another terminal, a `tsx watch` sharing
   `compliance_core_db_test`.

   **The vulnerable shape is a suite that acquires ONE bearer in `beforeAll` and
   reuses it across the whole file.** That is most e2e files here. The symptom is
   not an assertion failure that names auth: the request 401s, `res.json()` comes
   back without the key the test reads, and you get `expected undefined to be 6`
   on a dozen tests at once — which reads like a data or fixture bug and sends you
   looking in the wrong place.

   **How to tell it apart from a real failure, in one step:** look at the STATUS
   CODE, not the assertion. 401 across tests that touch unrelated routes
   (`/api/config/password-policy`, `/session`, `/datetime`) is this race and
   nothing else — no product change can 401 the password-policy endpoint. A 400
   would implicate your own querystring or body schema. Measured 2026-09-01:
   `src/e2e/alarm-list-filters.e2e.test.ts` failed 17 of 22 at roughly a 50% rate
   run entirely ALONE, while the same endpoint probed directly returned 200 six
   times out of six, and the file's own unit-test neighbours were 204/204 stable.
   Failing alone is the tell that the contention is another PROCESS.

   Corollary for the baseline below: **a red run measured while another agent is
   working is not evidence of anything.** Re-run serially before believing it.

2. **Local dev server contention.** ~~If `tsx watch src/app.ts` is running
   on `:3000` against the same `digilog_db`, a test logout invalidates
   the dev server's session too.~~ **Largely resolved 2026-07-02** by the
   DB isolation below: the suite now runs against `digilog_test_db`, so a
   dev server on `digilog_db` no longer shares the `user_sessions` table
   with the tests. (A test-only flake can still occur within the suite
   from source #1; single-fork handles that.)

The flakiness was *surfaced*, not introduced, by the new e2e files in
commit `859492e3` (Phase 8.7 / Wave 8a verification). Those files just
added more concurrent admin logins, exposing a pre-existing infra
limitation.

### DB isolation — the suite runs against `digilog_test_db` (2026-07-02)

The suite previously ran against the live dev DB `digilog_db`. Every audited
e2e action (logins, filter cycles, RFID identifier assign/delete, config
edits) wrote **permanent, immutable, hash-chained** rows into the real
`audit_trail` (21 CFR §11) — e.g. `phase3-rfid-offline.test.ts` created RFID
`RFID-p3-<ts>-A/B` tags and then deleted their filters, leaving orphaned
`ASSET_IDENTIFIER_*` rows with blank filter names that surfaced in the live
Audit Trail UI. `vitest.env.ts` now rewrites `DATABASE_URL` (`digilog_db` →
`digilog_test_db`) before any `lib/prisma` import, so all test writes land in
the throwaway test DB. `vitest.setup.ts` (per worker) and
`vitest.global-setup.ts` (main process) both import it for its side effects.
Two suite tests that had implicitly relied on `digilog_db`'s accumulated data
were fixed to assert contracts instead of ambient counts
(`entities.test.ts` instance-list). `config.test.ts`'s datetime/current test
has a **pre-existing intermittent flake** (unrelated to this change — passes
in isolation and in most full runs; absent `[Config] Validation failed`
warning rules out data corruption); single-fork masks it in practice.

**Verified baseline** (2026-07-15, single-fork mode):
**1173 passing, 0 failed, 12 skipped (113 files).** Web: **573/573 (44 files)**.
If your single-fork run shows materially different numbers, investigate before
assuming your change broke something.

> **Measure serially or not at all.** Concurrent agents editing this tree while
> sharing `digilog_test_db` make the count meaningless — 2026-07-15 saw runs of the
> *same* tree fail in different files (19, 32, 37 failures) purely from the shared
> `admin` login race, all green once the agents settled. If several agents are live,
> run only your own touched files and leave the baseline to a serial pass afterwards.
> (Prior baseline: 829/80 files @ 2026-07-02.)

> The prior "1231 passing / 2 failed" (Wave 8a) baseline went **stale** — by
> 2026-07-02 the branch carried **83 pre-existing failures** across 14 files
> (all test debt, not product bugs: prisma-mock drift, auth security-hardening
> that unified login errors + added an audit-userId guard + stricter body
> schemas, a `validateUserId` config mismatch, and dead e2e tests for the
> `POST /api/assets/templates` route removed in Phase 1). Cleared 2026-07-02:
> 82 stale/dead tests fixed-or-removed + **1 real bug fixed** — `authService.logout`
> didn't call `invalidateSessionAuthCache`, leaving a logged-out session valid
> in the 30s cache (commit `3e87785`). **15 skipped** includes 7 instance-CRUD
> e2e tests `it.skip`'d in `entities.test.ts` — a real coverage gap: they need
> an asset template, which can now only come from seed (rewrite pending).

**Per-file authoring tip.** If you're adding a new e2e/integration test
file, follow the pattern from agent AD's recent commits: provision a
*unique* SUPER_ADMIN user inside the file's `beforeAll` (e.g. username
based on the test file name) instead of logging in as the shared
`admin`. That keeps your file safe under both single-fork and
multi-fork runs and makes it cheaper to debug in isolation. The
shared-`admin` pattern is grandfathered-in for older files but should
not be repeated.

**Trade-off accepted.** Single-fork is slower (no cross-file
parallelism) but reliable. Until each test file owns its own login
fixture, this is the right default.

## Environment
- API_PORT=3000 (default per `.env.example`; this checkout's actual `.env` runs 3001 to avoid
  colliding with a sibling DigiLog checkout on 3000 — see `local-env-two-checkouts` memory)
- PostgreSQL: localhost:5432 (only database now — also hosts the graphile-worker job queue). DB name
  per `.env.example` is `digilog_db`; this checkout's actual `.env` uses `compliance_core_db` — same
  sibling-checkout reason. Don't hardcode either name; read `DATABASE_URL`.
- ~~TimescaleDB~~ — `digilog_tsdb` database dropped 2026-06-11, still gone.
- **MQTT is back (2026-08, correction 2026-08-24).** The line that used to be here — "Mosquitto
  removed 2026-06-17 with data-ingestion tear-out ... `mqtt`/`aedes` deps gone" — was true of the OLD
  telemetry pipeline but is now WRONG: `apps/api/package.json` depends on `"mqtt": "^5.15.2"` again,
  and `app.ts` registers `/api/ingest/v1`, `mqtt-auth-routes.ts`, an MQTT bridge
  (`modules/instruments/listeners/mqtt-bridge.ts`), and a raw-TCP ingest listener (`INGEST_TCP_PORT`)
  for the new instrument-telemetry ingest path. `aedes` is still gone (that was an in-process broker
  for the old pipeline; the new bridge is a client connecting OUT to an external broker, EMQX in local
  dev — see `emqx-on-windows` memory). Verified `grep -n mqtt apps/api/src/app.ts` and
  `grep '"mqtt"' apps/api/package.json` 2026-08-24.

---

> ⚠️ **EVERYTHING FROM HERE DOWN (Phase 2 through Phase 4) DESCRIBES REMOVED SOFTWARE.**
> The filter/cleaning/checklist/PM/equipment-group domain was deleted in the 2026-07-18 Phase 0
> strip and its remaining vocabulary in the 2026-08-20 filter-domain removal — verified `ls
> apps/api/src/modules/` 2026-08-24 shows none of `filter-operations`, `filter-profiles`,
> `cleaning-profiles`, `checklist-profiles`, `pm-schedules`, `equipment-groups`,
> `entity-assignments` exist, and `apps/api/prisma/schema.prisma` has no `Filter*`/`Checklist*`/
> `EquipmentGroup*`/`CleaningCycle` models. The RFID Android app (`rfid_scan_app/`) referenced in
> Phase 3 also does not exist (verified `ls rfid_scan_app` 2026-08-24: no such file). Kept below as
> history, per this repo's doc policy — do not use it to infer what currently exists.

## Phase 2: Digital Filter Management System

### Phase 2 Modules
- `modules/cleaning-profiles/` — Pipeline profile CRUD with versioning, visual editor support, graph validation
- `modules/filter-profiles/` — Filter-to-cleaning-profile assignment with org scoping
- `modules/filter-operations/` — Core operations: cycle start/advance/bypass/checklist/events
- `modules/pm-schedules/` — Preventive maintenance scheduling with monthly entries and tolerance windows
- `modules/checklist-profiles/` — Checklist template and question management with usage checks. Phase A.1 (2026-05-01): every mutation is snapshot-then-bump into `ChecklistProfileVersion`; cycles pin the version at start so submissions resolve against the exact schema the operator saw. New endpoints: `GET /:id/versions` and `GET /:id/versions/:versionNumber`.
- `modules/equipment-groups/` — Equipment group management (AHU dashboard)
- `modules/entity-assignments/` — Entity-to-group assignments
- `modules/config/defs/filter-*.def.ts` — Config definitions for filter lifecycle, cleaning reasons

### Key Phase 2 API Endpoints
```
POST /api/filters/:id/start-cycle    — Start cleaning cycle
POST /api/filters/:id/advance        — Advance to next stage
POST /api/filters/:id/submit-checklist — Submit checklist answers
POST /api/filters/:id/bypass         — Bypass stage (deviation)
POST /api/filters/bulk-operate       — Batch advance / start-and-advance / submit-checklist in ONE request (partial success; reuses the single-op service methods per item)
GET  /api/filters/:id/current-state  — Get filter state + next actions
GET  /api/filters/cycles             — List cleaning cycles (events-routes.ts mounts /cycles + /events under the shared /api/filters prefix)
GET  /api/filters/events             — List filter events
GET  /api/filter-cleaning-profiles                       — List cleaning profiles (latest version per lineage)
GET  /api/filter-cleaning-profiles/:id/versions          — Phase A.2: list all versions in lineage
GET  /api/filter-cleaning-profiles/:id/versions/:n       — Phase A.2: fetch frozen snapshot at version n
GET  /api/filter-profiles            — List filter profiles
GET  /api/filter-profiles/:id/versions             — Phase A.3: list archived FilterProfile versions
GET  /api/filter-profiles/:id/versions/:n          — Phase A.3: frozen FilterProfile snapshot at version n
GET  /api/equipment-groups            — List equipment groups
GET  /api/equipment-groups/:id/versions            — Phase A.4: list archived EquipmentGroup versions (composite)
GET  /api/equipment-groups/:id/versions/:n         — Phase A.4: frozen EquipmentGroup composite snapshot at version n
GET  /api/pm-schedules               — List PM schedules
GET  /api/checklist-profiles                       — List checklist profiles
GET  /api/checklist-profiles/:id/versions          — Phase A.1: list archived versions
GET  /api/checklist-profiles/:id/versions/:n       — Phase A.1: fetch frozen snapshot at version n
GET  /api/equipment-groups           — List equipment groups
```

### Phase 2 Patterns
- Organization scoping via `orgWhere(ctx)` on all filter queries
- Pipeline graph validation (connectivity, stateKeys, checklist profiles)
- Transaction wrapping for cycle start and profile versioning
- Server-side checklist enforcement in `advance()`
- Input sanitization on user-provided text fields
- Events as immutable log with SHA-256 checksums for 21 CFR Part 11 compliance
- **FilterCleaningProfile versioning** — immutable-rowful via `lineageId` UUID set at first create; updates archive the old row and insert a new row with `version+1` carrying the same lineageId. Cycles freeze `profileId` at start, so audit replay reads the exact archived row that was active at cycle start. Phase A.2 (2026-05-01) introduced `lineageId` (replacing `name`-based grouping) and exposed version history endpoints.
- **FilterProfile versioning** — Phase A.3 (2026-05-01). Sidecar pattern (mirrors A.1 ChecklistProfile): `FilterProfile.version` is a monotonic counter on the live row; `FilterProfileVersion` is a snapshot-then-bump sidecar capturing the OUTGOING state on every `update()`. First version is created lazily — live row IS v1 until first edit. No cycle pinning needed because cycles already pin `cleaning_cycles.profileId` to a FilterCleaningProfile row at start; FilterProfile drift cannot reach a running cycle. Per-block override is explicitly out of scope (FilterProfile uniform across all blocks).
- **EquipmentGroup composite versioning** — Phase A.4 (2026-05-02). Composite sidecar pattern (mirrors A.1 ChecklistProfile + questions): `EquipmentGroup.version` is the live counter, `EquipmentGroupVersion` snapshots the WHOLE composite (group + 3 instruments ordered by sortOrder) inside the same transaction as the live mutation. **P1 (2026-05-02)** added cycle-side pinning via `cleaning_cycles.equipmentGroupVersionPin Int?`. Reading validation reads `operatingMin/Max` from the pinned `EquipmentGroupVersion.snapshot.instruments[]`, with fallback to the live row when pin is NULL (legacy cycles). `FilterEvent.attributes.instrumentReadings` continues to immutably snapshot the submitted values — that's the audit-trail layer, P1 is the validation-rule layer. **Cleaning reasons are NOT versioned** — already drift-resistant via `CleaningCycle.cleaningReasonKey` + `cleaningReasonLabel` columns set at cycle start.
- Auto-complete on last stage (STAGE leads to END node)

### Pipeline Flow
CHECKLIST nodes between STAGE nodes trigger automatic question dialogs.
Server-side enforcement: advance() blocks if pending checklist not completed.
Cycle auto-completes when last STAGE leads to END node.
Stage types: WASH_IN, WASH_OUT, DRY_IN, DRY_OUT, STORAGE_IN, STORAGE_OUT

---

## Phase 3 Update (2026-04-07)

**RFID & Offline Operations:**
- RFID Scanner Android app (`rfid_scan_app/`) for KC-series UHF readers
- RFID keyboard guard prevents UKB tag input leaking into random fields
- Offline cleaning operations via IndexedDB queue + sync engine
- Cached identifier→filter map for offline RFID lookup
- "Data Synced" indicator in mobile header
- One identifier per entity (backend-enforced)
- Responsive layout with collapsible sidebar
- Error popups replace inline banners
- User creation auto-assigns org for admins
- `/api/roles/active` public endpoint for contact-admin page

See `CHANGELOG.md` for full details.

---

## Phase 4 Update (2026-04-14) — in-app permissions/themes/reports phase

> Note: a separate "Phase 4" appears in the windows-friendly-rewrite plan (tooling cleanup of `install-on-target.ps1` + `package-for-production.ps1`). The two are unrelated.

**New Config Definitions:**
- `report-page-titles.def.ts` — report identity (company name + application name) shown in every report header + footer (blank → Branding). **Replaced `report-settings.def.ts` on 2026-06-29** (the old show/hide-toggle + layout config was removed; report-page page size now comes from Pagination Settings). The configurable common labels were also removed 2026-06-29 — the chrome uses fixed defaults.
- Public endpoint: `GET /api/config/report-page-titles/current` (all authenticated users)
- Public endpoint: `GET /api/config/password-policy/current`

**Permissions Updates (snapshot at release; current totals are higher — see live counts in root `CLAUDE.md`):**
- ~95 permission constants at release (**44** on 2026-10-05 — verify with `grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts`)
- 87 reauth actions at that point (**55** on 2026-10-05 — verify with `grep -cE "^\s+[A-Z_]+:" packages/shared/src/types/reauth-actions.ts`); the 2026-05-04 audit-linkage fixes added `UPDATE_PROFILE` (H1) + `RETIRE_FILTER` / `REPLACE_FILTER` / `BULK_UPLOAD_FILTERS` (C2) + `APPROVE_ADMIN_REQUEST` (M1) + `UPDATE_FILTER_LIFECYCLE` (M2) (`tasks/AUDIT-2026-05-04-linkage-review.md`); later net-changed by the UNS + reports tear-outs
- FEATURE_TO_PERMISSION_MAP entries include both frontend + backend permissions
- Block change requests GET endpoint accepts BLOCK_CHANGE_REQUEST OR BLOCK_CHANGE_APPROVE
- Backup export uses CONFIG_UPDATE (removed hardcoded SUPER_ADMIN check)
- ~~Org-admin routes changed from requireRole to requirePermission(ORG_VIEW)~~ (org-admin module deleted in MT removal 2026-04-30)

**Backend Fixes:**
- Backup restore: SQL/CSV formats now include password_hash
- enforceReauth added to: retention PUT, retention execute POST, submit-checklist POST
